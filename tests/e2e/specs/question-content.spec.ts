import { test, expect } from "@playwright/test";
import type { ChatInputRequest, ChatState } from "@microsoft/agent-host-protocol";
import { inputAnswers, projectInputs } from "../../../electron/main/session-sources/agent-host/projection";
import { startTestServer, type TestServerInstance } from "../setup/test-server";
import { seedTestData } from "../setup/seed-data";
import { expandAllProjects, selectSession } from "../setup/test-helpers";

const message = [
  "The next test produces a large log and needs your confirmation.",
  "It may consume substantial compute and disk space. Only the selected test will run; other tests remain stopped.",
  "Temporary notebooks will be kept for inspection. No existing notebook will be deleted.",
  `Diagnostic identifier: ${"long-identifier-".repeat(70)}`,
  "Do you approve running this test once?",
].join("\n\n");
let server: TestServerInstance;

const optionalAskUserRequest: ChatInputRequest = {
  id: "optional-ask-user",
  message: "请确认移动端上下文菜单的设计方案：",
  questions: [
    {
      id: "desktopRightClick",
      title: "桌面端顺手支持鼠标右键菜单",
      message: "桌面端是否顺手支持右键菜单？",
      required: false,
      kind: "single-select",
      allowFreeformInput: true,
      options: [
        { id: "true", label: "True", recommended: true },
        { id: "false", label: "False" },
      ],
    },
    {
      id: "extraTargets",
      title: "是否有其他具体位置需要覆盖（可选）",
      message: "没有可留空。",
      required: false,
      kind: "text",
    },
    {
      id: "menuStyle",
      title: "移动端菜单形态",
      message: "手机触发后菜单的展示形态",
      required: false,
      kind: "single-select",
      options: [
        { id: "bottom_sheet", label: "底部操作面板 Bottom Sheet" },
        { id: "floating_popover", label: "行旁就近浮层菜单 Popover" },
      ],
    },
  ],
};
let lastSubmittedAnswers: string[][] | null = null;

test.beforeAll(async () => {
  server = await startTestServer({ port: 0 });
  seedTestData(server.mockAdapters);
  const adapter = server.mockAdapters.get("opencode")!;
  const questions = ["full-question", "legacy-question", "optional-form-question"].map(id => {
    adapter.seedSession({ id, title: id, engineType: "opencode", directory: "/test/project-alpha",
      time: { created: Date.now(), updated: Date.now() } });
    const chat = { resource: `ahp-chat:/${id}`, title: "", modifiedAt: "2026-11-20T00:00:00Z", status: 6, turns: [],
      activeTurn: { id: "turn", startedAt: "2026-11-20T00:00:00Z", message: { text: "Ask before running", origin: { kind: "user" } },
        responseParts: [{ kind: "inputRequest", request: id === "optional-form-question"
          ? optionalAskUserRequest
          : { id: "approval",
            ...(id === "full-question" ? { message } : {}),
            questions: [
              { id: "choice", kind: "single-select", title: "Test approval", message: "Choose an action", required: true,
                options: [{ id: "run", label: "Run once" }, { id: "stop", label: "Keep stopped" }] },
              { id: "note", kind: "text", title: "Notes", message: "Any additional instructions?" },
            ],
          } }],
      },
    } as ChatState;
    return projectInputs(id, chat, "opencode").questions[0].question;
  });
  let activeQuestions = [...questions];
  adapter.getPendingQuestions = (sessionId?: string) => activeQuestions.filter(question => !sessionId || question.sessionId === sessionId);
  adapter.replyQuestion = async (questionId: string, answers: string[][]) => {
    const target = activeQuestions.find(question => question.id === questionId);
    if (target?.sessionId === "optional-form-question") {
      // Validate against real Agent Host inputAnswers converter!
      inputAnswers(optionalAskUserRequest, answers);
      lastSubmittedAnswers = answers;
    }
    activeQuestions = activeQuestions.filter(question => question.id !== questionId);
    adapter.emit("question.replied", { questionId, answers });
  };
  await server.registerSessionRoutes();
});

test.afterAll(async () => { await server?.stop(); });

for (const mobile of [false, true]) {
  test(`shows the complete request above its questions on ${mobile ? "mobile" : "desktop"}`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    await page.addInitScript(() => localStorage.setItem("settings:theme", JSON.stringify("dark")));
    await page.goto(server.baseUrl);
    await expandAllProjects(page);
    await selectSession(page, "full-question");
    const body = page.locator("[data-question-message]");
    await expect(body).toHaveText(message);
    await expect(body).toHaveCSS("white-space", "pre-wrap");
    const layout = await body.evaluate(element => ({
      width: element.clientWidth, scrollWidth: element.scrollWidth,
      height: element.clientHeight, scrollHeight: element.scrollHeight,
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
    expect(layout.scrollHeight).toBeGreaterThan(layout.height);
    await expect(page.getByRole("radio", { name: "Run once" })).toBeVisible();
    await expect(page.locator('[data-component="notification-toasts"] > div')).toHaveCount(0, { timeout: 10_000 });
    await page.screenshot({ path: testInfo.outputPath(`question-${mobile ? "mobile" : "desktop"}.png`) });
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: testInfo.outputPath(`question-end-${mobile ? "mobile" : "desktop"}.png`) });
    await page.getByRole("radio", { name: "Run once" }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Any additional instructions?", { exact: true })).toBeVisible();
    await expect(body).toHaveText(message);
    const submit = page.getByRole("button", { name: "Submit", exact: true });
    await expect(submit).toBeEnabled();
    await expect(submit).toBeInViewport();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Run once" })).toHaveAttribute("aria-checked", "true");
  });
}

test("keeps questions without request-level context unchanged", async ({ page }) => {
  await page.goto(server.baseUrl);
  await expandAllProjects(page);
  await selectSession(page, "legacy-question");
  await expect(page.getByText("Choose an action", { exact: true })).toBeVisible();
  await expect(page.locator("[data-question-message]")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Run once" })).toBeVisible();
});

test("submits multi-question optional ask_user form on mobile when optional questions are left blank", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.baseUrl);
  await expandAllProjects(page);
  await selectSession(page, "optional-form-question");

  // Page 1 has recommended option "True" pre-selected
  await expect(page.getByRole("radio", { name: "True" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Next", exact: true }).click();

  // Page 2 (optional text) — leave blank
  await expect(page.getByText("没有可留空。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  // Page 3 (optional single-select without freeform) — leave blank and click Submit!
  await expect(page.locator("main input[type='text']")).toHaveCount(0);
  const submit = page.getByRole("button", { name: "Submit", exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();

  // Question dock disappears and inputAnswers accepted the payload cleanly
  await expect(submit).toHaveCount(0);
  await expect(page.locator('[data-component="notification-toasts"] > div')).toHaveCount(0);
  expect(lastSubmittedAnswers).toEqual([["True"], [], []]);
});

