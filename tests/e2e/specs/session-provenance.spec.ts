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
        canCreateSession: enabled,
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

test("shows Add Project button and Local vs VS Code target choices on desktop and mobile", async ({ page }, testInfo) => {
  // Ensure VS Code source is enabled and connected
  await page.evaluate(() => {
    localStorage.setItem("settings:locale", JSON.stringify("en"));
    localStorage.setItem("settings:theme", JSON.stringify("light"));
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${server.baseUrl}/settings`);
  const panel = page.locator("[data-session-source-settings]");
  const toggleSwitch = panel.getByRole("switch", { name: "Connect to VS Code chats" });
  await expect(toggleSwitch).toBeVisible({ timeout: 10_000 });
  await toggleSwitch.scrollIntoViewIfNeeded();
  if ((await panel.textContent())?.includes("Not connected")) {
    await toggleSwitch.click();
    await expect(panel).toContainText("Sharing is off");
  }
  if ((await toggleSwitch.getAttribute("aria-checked")) !== "true") {
    await toggleSwitch.click();
  }
  await expect(panel).toContainText("Connected");

  // Desktop: verify Add Project icon (left of Refresh) is visible and offers Local vs VS Code
  await page.goto(`${server.baseUrl}/chat`);
  const addProjectBtn = page.locator('[data-action="add-project"]');
  await expect(addProjectBtn).toBeVisible();
  await addProjectBtn.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const targetGroup = dialog.locator("[data-add-project-target]");
  await expect(targetGroup).toBeVisible();
  await expect(targetGroup.getByRole("radio", { name: "Local (CodeMux)" })).toHaveAttribute("aria-checked", "true");
  const vscodeRadio = targetGroup.getByRole("radio", { name: "VS Code" });
  await expect(vscodeRadio).toBeVisible();
  await vscodeRadio.click();
  await expect(vscodeRadio).toHaveAttribute("aria-checked", "true");
  await dialog.locator('input[type="text"]').fill("/test/remote-vscode-repo");
  await dialog.screenshot({ path: testInfo.outputPath("add-project-vscode-en.png") });

  await dialog.getByRole("button", { name: "Add Project" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("[data-session-origin]").filter({ hasText: "VS Code" }).first()).toBeVisible();

  // Desktop: hover existing project and click '+' to see New Local Session / New VS Code Session menu
  const alphaRow = page.locator("aside .group").filter({ hasText: "project-alpha" }).first();
  await alphaRow.hover();
  await alphaRow.locator('[data-action="project-new-session"]').click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "New Local Session" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "New VS Code Session" })).toBeVisible();
  await menu.screenshot({ path: testInfo.outputPath("project-plus-menu-en.png") });
  await page.keyboard.press("Escape");

  // Mobile (dark zh): verify Add Project button AND long-press context menu on existing project
  await page.evaluate(() => {
    localStorage.setItem("settings:locale", JSON.stringify("zh"));
    localStorage.setItem("settings:theme", JSON.stringify("dark"));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(page).toHaveURL(/\/chat/);

  // Open mobile sidebar drawer
  await page.locator('header button, [aria-label*="侧边栏"], button:has(svg line[x1="4"])').first().click();
  const mobileAddProject = page.locator('[data-action="add-project"]');
  await expect(mobileAddProject).toBeVisible();
  await mobileAddProject.click();

  const zhDialog = page.getByRole("dialog");
  await expect(zhDialog).toBeVisible();
  await expect(zhDialog.getByRole("radio", { name: "本机 (CodeMux)" })).toBeVisible();
  await expect(zhDialog.getByRole("radio", { name: "VS Code" })).toBeVisible();
  // Verify interactive folder drill-down from drive roots without typing
  await expect(zhDialog.locator('[data-folder-entry="C:\\\\"]')).toBeVisible();
  await zhDialog.locator('[data-folder-entry="Q:\\\\"]').click();
  await zhDialog.locator('[data-folder-entry="Q:\\\\Projects"]').click();
  await zhDialog.locator('[data-folder-entry="Q:\\\\Projects\\\\codemux"]').click();
  await expect(zhDialog.locator('input[type="text"]')).toHaveValue("Q:\\Projects\\codemux");
  await page.screenshot({ path: testInfo.outputPath("add-project-vscode-mobile-zh.png") });
  await zhDialog.getByRole("button", { name: "取消" }).click();

  // Right-click / contextmenu on existing project row in mobile sidebar -> shows 新建本机会话 & 新建 VS Code 会话
  const zhAlphaRow = page.locator("aside .group").filter({ hasText: "project-alpha" }).first();
  await zhAlphaRow.click({ button: "right" });
  const zhMenu = page.getByRole("menu");
  await expect(zhMenu).toBeVisible();
  await expect(zhMenu.getByRole("menuitem", { name: "新建本机会话" })).toBeVisible();
  await expect(zhMenu.getByRole("menuitem", { name: "新建 VS Code 会话" })).toBeVisible();
  await page.waitForTimeout(160);
  await page.screenshot({ path: testInfo.outputPath("project-context-menu-mobile-zh.png") });
});
