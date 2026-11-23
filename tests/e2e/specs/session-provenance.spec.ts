import { test, expect } from "@playwright/test";
import { startTestServer, type TestServerInstance } from "../setup/test-server";
import { seedTestData } from "../setup/seed-data";
import { expandAllProjects, selectSession } from "../setup/test-helpers";

let server: TestServerInstance;
let releaseSourceToggle: (() => void) | undefined;
let holdNextSourceToggle = false;

test.beforeAll(async () => {
  const sources = [{
    id: "vscode", peerName: "VS Code", kind: "attach" as const, enabled: true,
    available: false, status: "unavailable" as const, providers: [],
  }];
  server = await startTestServer({
    port: 0,
    sessionSources: sources,
    onSetSessionSource: async (sourceId, enabled) => {
      if (holdNextSourceToggle) {
        holdNextSourceToggle = false;
        await new Promise<void>(resolve => { releaseSourceToggle = resolve; });
      }
      const next = {
        ...sources.find(s => s.id === sourceId)!,
        enabled,
        available: enabled,
        status: enabled ? ("connected" as const) : ("disabled" as const),
      };
      const index = sources.findIndex(s => s.id === sourceId);
      if (index >= 0) sources[index] = next;
      return next;
    },
  });
  seedTestData(server.mockAdapters);
  const adapter = server.mockAdapters.get("opencode")!;
  for (const [id, title, connection] of [
    ["source-only", "Shared host chat", { source: "VS Code", executor: "VS Code", shared: true, available: true }],
    ["known-creator", "Known creator chat", { source: "VS Code", origin: "Verified app", executor: "VS Code", shared: true, available: true }],
    ["legacy-origin", "Existing origin chat", { origin: "Codex", executor: "CodeMux", shared: false, available: true }],
  ] as const) {
    adapter.seedSession({ id, title, engineType: "opencode", directory: "/test/project-alpha",
      time: { created: Date.now(), updated: Date.now() }, connection });
  }
  await server.registerSessionRoutes();
});

test.afterAll(async () => { await server?.stop(); });

test.beforeEach(async ({ page }) => {
  await page.goto(server.baseUrl);
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByText("project-alpha").first()).toBeVisible();
  await expandAllProjects(page);
});

for (const locale of [
  { code: "en", source: "Connection source", origin: "Creating app", unknown: "Unknown", executor: "Current executor", via: "Connected via VS Code" },
  { code: "zh", source: "接入来源", origin: "创建应用", unknown: "未知", executor: "当前执行端", via: "通过 VS Code 接入" },
  { code: "ru", source: "Источник подключения", origin: "Приложение создания", unknown: "Неизвестно", executor: "Текущий исполнитель", via: "Подключено через VS Code" },
]) {
  test(`separates connection source from unknown creator in ${locale.code}`, async ({ page }, testInfo) => {
    await selectSession(page, "Shared host chat");
    await page.evaluate(code => {
      localStorage.setItem("settings:locale", JSON.stringify(code));
      localStorage.setItem("settings:theme", JSON.stringify(code === "en" ? "light" : "dark"));
    }, locale.code);
    await page.reload();
    const badge = page.locator("[data-session-origin]").filter({ hasText: "VS Code" });
    await expect(badge).toHaveAttribute("title", locale.via);
    await page.locator("[data-session-connection]").click();
    const details = page.locator('[role="region"]').filter({ has: page.locator("dl") });
    for (const [label, value] of [[locale.source, "VS Code"], [locale.origin, locale.unknown], [locale.executor, "VS Code"]]) {
      await expect(details.locator("dt").filter({ hasText: label }).locator("+ dd")).toHaveText(value);
    }
    if (locale.code === "zh") {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: "dark" });
      const bounds = await details.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    }
    await expect(page.locator('[data-component="notification-toasts"] > div')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`provenance-${locale.code}.png`) });
  });
}

test("keeps verified creators and existing origin-only badges distinct from connection sources", async ({ page }) => {
  await selectSession(page, "Known creator chat");
  await expect(page.locator('[data-session-origin]').filter({ hasText: "Verified app" }))
    .toHaveAttribute("title", "Created in Verified app");
  await page.locator("[data-session-connection]").click();
  const details = page.locator('[role="region"]').filter({ has: page.locator("dl") });
  await expect(details.locator("dt").filter({ hasText: "Creating app" }).locator("+ dd")).toHaveText("Verified app");
  await expect(details.locator("dt").filter({ hasText: "Connection source" }).locator("+ dd")).toHaveText("VS Code");
  await page.keyboard.press("Escape");
  await selectSession(page, "Existing origin chat");
  await expect(page.locator('[data-session-origin]').filter({ hasText: "Codex" }))
    .toHaveAttribute("title", "Created in Codex");
  await page.locator("[data-session-connection]").click();
  await expect(details.locator("dt").filter({ hasText: "Connection source" })).toHaveCount(0);
  await expect(details.locator("dt").filter({ hasText: "Current executor" }).locator("+ dd")).toHaveText("CodeMux");
});

test("shows VS Code label and loading spinner with multi-minute hint while enabling", async ({ page }, testInfo) => {
  await page.evaluate(() => {
    localStorage.setItem("settings:locale", JSON.stringify("en"));
    localStorage.setItem("settings:theme", JSON.stringify("light"));
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${server.baseUrl}/settings`);
  const panel = page.locator("[data-session-source-settings]");
  const toggleSwitch = panel.getByRole("switch", { name: "Connect to VS Code chats" });
  await expect(toggleSwitch).toBeVisible({ timeout: 10_000 });
  await expect(panel).toContainText("Open VS Code on this computer to reconnect");

  // Disable first, then trigger slow enable to verify loading spinner + multi-minute hint in light EN and dark ZH
  await toggleSwitch.click();
  await expect(panel).toContainText("Sharing is off");

  holdNextSourceToggle = true;
  await toggleSwitch.click();
  const loadingBanner = panel.locator("[data-session-source-loading]");
  await expect(loadingBanner).toBeVisible();
  await expect(loadingBanner).toContainText("Initial sync may take a few minutes");
  await expect(loadingBanner.locator('[data-component="spinner"]')).toBeVisible();
  await panel.screenshot({ path: testInfo.outputPath("source-settings-loading-en.png") });

  releaseSourceToggle?.();
  await expect(panel).toContainText("Connected");
  await expect(loadingBanner).toHaveCount(0);

  // Also capture dark Chinese mobile view while enabling
  await page.evaluate(() => {
    localStorage.setItem("settings:locale", JSON.stringify("zh"));
    localStorage.setItem("settings:theme", JSON.stringify("dark"));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();

  const zhPanel = page.locator("[data-session-source-settings]");
  const zhSwitch = zhPanel.getByRole("switch", { name: "连接 VS Code 会话" });
  await expect(zhSwitch).toBeVisible({ timeout: 10_000 });
  await zhSwitch.click();
  await expect(zhPanel).toContainText("共享已关闭");

  holdNextSourceToggle = true;
  await zhSwitch.click();
  const zhLoading = zhPanel.locator("[data-session-source-loading]");
  await expect(zhLoading).toBeVisible();
  await expect(zhLoading).toContainText("首次同步可能需要几分钟");
  await zhPanel.screenshot({ path: testInfo.outputPath("source-settings-loading-zh.png") });
  releaseSourceToggle?.();
  await expect(zhPanel).toContainText("已连接");
});
