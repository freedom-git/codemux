import { test, expect } from "@playwright/test";
import { startTestServer, type TestServerInstance } from "../setup/test-server";
import { seedTestData } from "../setup/seed-data";
import { selectSession } from "../setup/test-helpers";

let server: TestServerInstance;

test.beforeAll(async () => {
  server = await startTestServer({ port: 0 });
  seedTestData(server.mockAdapters);
  const adapter = server.mockAdapters.get("opencode")!;
  const sessionId = "long-answer-session";

  const longParagraphs = Array.from(
    { length: 28 },
    (_, i) => `Section ${i + 1}: Detailed engineering analysis paragraph explaining architecture, edge cases, and step-by-step verification details so the response spans multiple mobile screens.`,
  ).join("\n\n");

  adapter.seedSession(
    {
      id: sessionId,
      title: "Long answer session",
      engineType: "opencode",
      directory: "/test/project-alpha",
      time: { created: Date.now() - 60_000, updated: Date.now() },
    },
    [
      {
        id: "m-u1",
        sessionId,
        role: "user",
        time: { created: Date.now() - 50_000, completed: Date.now() - 50_000 },
        parts: [{ type: "text", id: "p-u1", messageId: "m-u1", sessionId, text: "First earlier question" }],
      },
      {
        id: "m-a1",
        sessionId,
        role: "assistant",
        time: { created: Date.now() - 49_000, completed: Date.now() - 45_000 },
        parts: [{ type: "text", id: "p-a1", messageId: "m-a1", sessionId, text: longParagraphs }],
      },
      {
        id: "m-u2",
        sessionId,
        role: "user",
        time: { created: Date.now() - 30_000, completed: Date.now() - 30_000 },
        parts: [{ type: "text", id: "p-u2", messageId: "m-u2", sessionId, text: "这是最后一个问题：请从头给我讲清楚整体方案" }],
      },
      {
        id: "m-a2",
        sessionId,
        role: "assistant",
        time: { created: Date.now() - 29_000, completed: Date.now() - 10_000 },
        parts: [{ type: "text", id: "p-a2", messageId: "m-a2", sessionId, text: `开头第一段回答。\n\n${longParagraphs}\n\n最后一段结尾总结。` }],
      },
    ],
  );
  await server.registerSessionRoutes();
});

test.afterAll(async () => {
  await server?.stop();
});

test("shows jump-to-last-question on entry, renders both jump buttons side-by-side when mid-scroll, and scrolls accurately", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("settings:locale", JSON.stringify("zh"));
      localStorage.setItem("settings:theme", JSON.stringify("dark"));
    });

    await page.goto(server.baseUrl);
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });

    // Open mobile drawer and select the long session
    const aside = page.locator("aside");
    if (await aside.evaluate((el) => el.className.includes("-translate-x-full"))) {
      await page.locator("button.md\\:hidden").first().click();
    }
    const projectHeader = aside.getByText("project-alpha", { exact: true }).first();
    await projectHeader.click();
    await page.waitForTimeout(200);
    await selectSession(page, "Long answer session");

    const jumpLastQuestion = page.locator('[data-jump="last-question"]');
    const jumpLatest = page.locator('[data-jump="latest"]');

    // 1. Right upon entering at the bottom of a long reply, "回到最后提问" is visible pointing up!
    await expect(jumpLastQuestion).toBeVisible();
    await expect(jumpLastQuestion).toHaveAttribute("data-direction", "up");
    await expect(jumpLatest).toHaveCount(0);
    await page.waitForTimeout(220);
    await page.screenshot({ path: testInfo.outputPath("mobile-at-bottom-last-question-dark.png") });

    // 2a. Scroll midway up inside the last answer -> BOTH buttons appear side-by-side ("up" + "latest")!
    const viewport = page.locator(".conversation-viewport");
    await viewport.evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 450; });
    await expect(jumpLastQuestion).toBeVisible();
    await expect(jumpLastQuestion).toHaveAttribute("data-direction", "up");
    await expect(jumpLatest).toBeVisible();
    await page.waitForTimeout(220);
    await page.screenshot({ path: testInfo.outputPath("mobile-mid-answer-both-buttons-dark.png") });

    // 2b. Scroll to earlier turn (top) -> BOTH buttons appear side-by-side ("down" + "latest")!
    await viewport.evaluate((el) => { el.scrollTop = 50; });
    await expect(jumpLastQuestion).toBeVisible();
    await expect(jumpLastQuestion).toHaveAttribute("data-direction", "down");
    await expect(jumpLatest).toBeVisible();
    await page.waitForTimeout(220);
    await page.screenshot({ path: testInfo.outputPath("mobile-both-jump-buttons-dark.png") });

    const barBox = (await page.locator(".conversation-jump-bar").boundingBox())!;
    expect(barBox.x).toBeGreaterThanOrEqual(8);
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(382);

    const qBox = (await jumpLastQuestion.boundingBox())!;
    const lBox = (await jumpLatest.boundingBox())!;
    // Side-by-side on the same horizontal row
    expect(Math.abs(qBox.y - lBox.y)).toBeLessThan(4);
    expect(qBox.x + qBox.width).toBeLessThanOrEqual(lBox.x);

    // 3. Tap "回到最后提问" -> aligns last user question cleanly at top of viewport!
    await jumpLastQuestion.click();
    await expect(page.getByText("这是最后一个问题：请从头给我讲清楚整体方案")).toBeInViewport();
    await expect(jumpLastQuestion).toHaveCount(0);
    await expect(jumpLatest).toBeVisible();
    await page.waitForTimeout(220);
    await page.screenshot({ path: testInfo.outputPath("mobile-jumped-to-last-question-dark.png") });

    // 4. Tap "回到最新消息" -> returns to bottom!
    await jumpLatest.click();
    await expect(page.getByText("最后一段结尾总结。")).toBeInViewport();
    await expect(jumpLatest).toHaveCount(0);
    await expect(jumpLastQuestion).toBeVisible();
  } finally {
    await context.close();
  }
});

test("renders English side-by-side jump buttons cleanly in light theme on mobile", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("settings:locale", JSON.stringify("en"));
      localStorage.setItem("settings:theme", JSON.stringify("light"));
    });

    await page.goto(server.baseUrl);
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });

    const aside = page.locator("aside");
    if (await aside.evaluate((el) => el.className.includes("-translate-x-full"))) {
      await page.locator("button.md\\:hidden").first().click();
    }
    await aside.getByText("project-alpha", { exact: true }).first().click();
    await page.waitForTimeout(200);
    await selectSession(page, "Long answer session");

    await page.locator(".conversation-viewport").evaluate((el) => { el.scrollTop = 50; });
    await expect(page.locator('[data-jump="last-question"]')).toBeVisible();
    await expect(page.locator('[data-jump="latest"]')).toBeVisible();
    await page.waitForTimeout(220);
    await page.screenshot({ path: testInfo.outputPath("mobile-both-jump-buttons-light-en.png") });
  } finally {
    await context.close();
  }
});

