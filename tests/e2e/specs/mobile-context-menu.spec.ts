import { test, expect } from "@playwright/test";
import { startTestServer, type TestServerInstance } from "../setup/test-server";
import { seedTestData } from "../setup/seed-data";
import { expandAllProjects } from "../setup/test-helpers";

let server: TestServerInstance;

test.beforeAll(async () => {
  server = await startTestServer({ port: 0 });
  seedTestData(server.mockAdapters);
  await server.registerSessionRoutes();
});

test.afterAll(async () => {
  await server?.stop();
});

test("opens context menu via touch long-press on mobile without switching session and supports inline confirm and rename", async ({ browser }, testInfo) => {
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

    // Open mobile sidebar drawer if closed
    const aside = page.locator("aside");
    const isHidden = await aside.evaluate((el) => el.className.includes("-translate-x-full"));
    if (isHidden) {
      await page.locator("button.md\\:hidden").first().click();
    }
    const projectHeader = page.locator("aside").getByText("project-alpha", { exact: true }).first();
    await expect(projectHeader).toBeVisible();
    await projectHeader.click();
    await page.waitForTimeout(250);

    const sessionTitle = page.locator("aside").getByText("Fix authentication bug", { exact: true }).first();
    await expect(sessionTitle).toBeVisible();
    const box = (await sessionTitle.boundingBox())!;
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);

    // Dispatch real touchstart -> hold 500ms -> touchend
    await sessionTitle.evaluate((el, pt) => {
      const touch = new Touch({
        identifier: 1,
        target: el,
        clientX: pt.x,
        clientY: pt.y,
        pageX: pt.x,
        pageY: pt.y,
      });
      el.dispatchEvent(new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
      }));
    }, { x: cx, y: cy });

    await page.waitForTimeout(550);

    await sessionTitle.evaluate((el, pt) => {
      const touch = new Touch({
        identifier: 1,
        target: el,
        clientX: pt.x,
        clientY: pt.y,
        pageX: pt.x,
        pageY: pt.y,
      });
      el.dispatchEvent(new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [touch],
      }));
    }, { x: cx, y: cy });

    // Context menu stays open after finger lift, and mobile drawer stays open!
    const menu = page.locator('[data-component="context-menu"]');
    await expect(menu).toBeVisible();
    await page.waitForTimeout(150);
    await expect(menu.locator('[data-menu-item="copy-session-id"]')).toBeVisible();
    await expect(menu.locator('[data-menu-item="rename-session"]')).toBeVisible();
    await expect(menu.locator('[data-menu-item="toggle-pin-session"]')).toBeVisible();
    await expect(menu.locator('[data-menu-item="delete-session"]')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mobile-session-menu-dark.png") });

    // First click on delete shows inline confirm / cancel inside the menu
    await menu.locator('[data-menu-item="delete-session"]').click();
    await expect(menu.locator('[data-menu-confirm="delete-session"]')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mobile-session-delete-confirm-dark.png") });
    await menu.locator('[data-menu-cancel="delete-session"]').click();
    await expect(menu.locator('[data-menu-item="delete-session"]')).toBeVisible();

    // Clicking rename closes menu and focuses inline input
    await menu.locator('[data-menu-item="rename-session"]').click();
    await expect(menu).toHaveCount(0);
    const renameInput = page.locator("aside input[autofocus]");
    await expect(renameInput).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mobile-session-rename-dark.png") });
    await renameInput.press("Escape");
  } finally {
    await context.close();
  }
});

test("opens context menu via right-click on desktop for both project and session rows", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem("settings:theme", JSON.stringify("light")));
  await page.goto(server.baseUrl);
  await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  await expandAllProjects(page);

  const projectHeader = page.locator("aside").getByText("project-alpha", { exact: true }).first();
  await projectHeader.click({ button: "right" });
  const menu = page.locator('[data-component="context-menu"]');
  await expect(menu).toBeVisible();
  await page.waitForTimeout(160);
  await expect(menu.locator('[data-menu-item="new-session"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-project-menu-light.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  const sessionTitle = page.locator("aside").getByText("Fix authentication bug", { exact: true }).first();
  await sessionTitle.click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.waitForTimeout(160);
  await expect(menu.locator('[data-menu-item="rename-session"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-session-menu-light.png") });
});
