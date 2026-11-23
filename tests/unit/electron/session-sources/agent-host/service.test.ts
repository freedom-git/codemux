import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInputRequest, ChatState } from "@microsoft/agent-host-protocol";
import { AgentHostConnection } from "../../../../../electron/main/session-sources/agent-host/connection";
import { AgentHostService } from "../../../../../electron/main/session-sources/agent-host/service";
import { parseEndpoint } from "../../../../../electron/main/session-sources/agent-host/discovery";
import { inputAnswers, nativeChatId, projectChat, projectInputs } from "../../../../../electron/main/session-sources/agent-host/projection";
import { createAgentHostFixture } from "./fixture";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(configure?: (server: Awaited<ReturnType<typeof createAgentHostFixture>>) => void) {
  const server = await createAgentHostFixture();
  cleanup.push(() => server.close());
  configure?.(server);
  const adapter = new AgentHostService({ enabled: true, discover: async () => [server.endpoint], pollMs: 100_000 });
  cleanup.push(() => adapter.stop());
  await adapter.start();
  const id = (await adapter.listSessions("copilot"))[0].id;
  return { server, adapter, id };
}

describe("local endpoint validation", () => {
  it("accepts authenticated local pipes and rejects remote or invalid metadata", () => {
    const valid = { schemaVersion: 2, type: "editor", pid: 123, instanceId: "one", connectionToken: "a".repeat(32),
      endpoint: { type: "socket", path: "\\\\.\\pipe\\vscode-agent-host-one" } };
    expect(parseEndpoint(valid, "profile", "win32")?.source).toBe("profile");
    expect(parseEndpoint({ ...valid, type: "standalone" }, "profile", "win32")?.type).toBe("standalone");
    for (const patch of [{ type: "unknown" }, { schemaVersion: 1 }, { connectionToken: "" }, { pid: -1 },
      { endpoint: { type: "tcp", host: "evil.example", port: 80 } },
      { endpoint: { type: "socket", path: "\\\\other-machine\\pipe\\vscode-agent-host-one" } }]) {
      expect(parseEndpoint({ ...valid, ...patch }, "profile", "win32")).toBeUndefined();
    }
  });
});

describe("AgentHostConnection", () => {
  it("refuses a standalone host when its token is incorrect", async () => {
    const server = await createAgentHostFixture("copilotcli", "tcp");
    cleanup.push(() => server.close());
    const client = new AgentHostConnection({ ...server.endpoint, token: "wrong-token-for-local-fixture" },
      { onChange() {}, onCatalogChange() {}, onClose() {} });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toThrow("Cannot connect");
    expect(server.requests).toHaveLength(0);
  });

  it("buffers actions arriving before a subscription snapshot and rejects unaccepted writes", async () => {
    const server = await createAgentHostFixture();
    cleanup.push(() => server.close());
    const client = new AgentHostConnection(server.endpoint, { onChange() {}, onCatalogChange() {}, onClose() {} });
    cleanup.push(() => client.close());
    await client.connect();
    server.snapshotInterleave = () => server.broadcast(server.chatUri, { type: "chat/turnStarted", turnId: "race",
      startedAt: "2026-11-19T00:00:00Z", message: { text: "hello", origin: { kind: "user" } } });
    await client.subscribe(server.chatUri);
    expect(client.chats.get(server.chatUri)?.activeTurn?.id).toBe("race");
    server.rejectNext = true;
    await expect(client.dispatch(server.chatUri, { type: "chat/turnCancelled", turnId: "race", duration: 0 })).rejects.toThrow("rejected");
    expect(client.chats.get(server.chatUri)?.activeTurn?.id).toBe("race");
  });

  it("accepts large chat snapshots over 32 MiB up to the 100 MiB payload limit", async () => {
    const server = await createAgentHostFixture();
    cleanup.push(() => server.close());
    const largeImageData = "A".repeat(40 * 1024 * 1024);
    server.chat.turns.push({
      id: "large-turn",
      state: "complete",
      startedAt: "2026-11-19T00:00:00Z",
      duration: 100,
      message: { text: "inspect screenshots", origin: { kind: "user" } },
      responseParts: [{
        kind: "toolCall",
        toolCall: {
          toolCallId: "view-1",
          toolName: "view",
          displayName: "view",
          invocationMessage: "Viewing screenshot",
          pastTenseMessage: "Viewed screenshot",
          status: "completed",
          success: true,
          confirmed: "not-needed",
          content: [
            { type: "text", text: "Viewed image file" },
            { type: "embeddedResource", contentType: "image/png", data: largeImageData },
          ],
        },
      }],
    });
    const client = new AgentHostConnection(server.endpoint, { onChange() {}, onCatalogChange() {}, onClose() {} });
    cleanup.push(() => client.close());
    await client.connect();
    await client.subscribe(server.chatUri);
    expect(client.chats.get(server.chatUri)?.turns).toHaveLength(1);
    expect(client.chats.get(server.chatUri)?.turns[0].id).toBe("large-turn");
  });
});

describe("AgentHostService", () => {
  it.each(["socket", "tcp"] as const)("does not infer a creating app from a %s host, provider, or extension metadata", async transport => {
    const server = await createAgentHostFixture("copilotcli", transport);
    cleanup.push(() => server.close());
    Object.assign(server.session, { _meta: { creator: "VS Code", application: "Agency" } });
    const adapter = new AgentHostService({ enabled: true, discover: async () => [server.endpoint], pollMs: 100_000 });
    cleanup.push(() => adapter.stop());
    await adapter.start();
    const session = (await adapter.listSessions("copilot"))[0];
    expect(adapter.getState().peerName).toBe("VS Code");
    expect(session.connection).toMatchObject({ source: "VS Code", executor: "VS Code", available: true });
    expect(session.connection?.origin).toBeUndefined();
    await adapter.restoreSession(session.id);
    expect((await adapter.getSession(session.id))?.connection?.origin).toBeUndefined();
    await adapter.setEnabled(false);
    expect((await adapter.getCatalog("copilot")).sessions[0].connection).toMatchObject({
      source: "VS Code", executor: "VS Code", available: false,
    });
    await adapter.setEnabled(true);
    expect((await adapter.listSessions("copilot"))[0]).toMatchObject({ id: session.id, engineType: "copilot" });
    expect((await adapter.getSession(session.id))?.connection?.origin).toBeUndefined();
  });

  it.each(["127.0.0.1", "localhost"])("continues an authenticated standalone owner's chat over %s TCP", async host => {
    const server = await createAgentHostFixture("copilotcli", "tcp");
    cleanup.push(() => server.close());
    if (server.endpoint.transport.type === "tcp") server.endpoint.transport.host = host;
    const adapter = new AgentHostService({ enabled: true, discover: async () => [server.endpoint], pollMs: 100_000 });
    cleanup.push(() => adapter.stop());
    await adapter.start();
    const sessions = await adapter.listSessions("copilot");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].connection?.available).toBe(true);
    await adapter.sendMessage(sessions[0].id, [{ type: "text", text: "same standalone owner" }]);
    expect(server.chat.activeTurn?.message.text).toBe("same standalone owner");
    await adapter.setEnabled(false);
    await adapter.setEnabled(true);
    expect((await adapter.listSessions("copilot"))[0].id).toBe(sessions[0].id);
    expect(server.requests.some(request => ["createSession", "disposeSession"].includes(request.method))).toBe(false);
  });

  it("discovers without loading transcripts, continues the same chat, and follows external deltas", async () => {
    const { server, adapter, id } = await setup();
    expect(server.requests.some(request => request.method === "subscribe" && request.params.channel === server.chatUri)).toBe(false);
    const updated = vi.fn();
    adapter.on("message.updated", updated);
    await adapter.sendMessage(id, [{ type: "text", text: "continue" }]);
    const turnId = server.chat.activeTurn!.id;
    expect(server.chat.activeTurn?.message.text).toBe("continue");
    expect(server.requests.some(request => request.method === "createSession")).toBe(false);
    server.broadcast(server.chatUri, { type: "chat/responsePart", turnId, part: { kind: "markdown", id: "reply", content: "" } });
    server.broadcast(server.chatUri, { type: "chat/delta", turnId, partId: "reply", content: "same owner" });
    server.broadcast(server.chatUri, { type: "chat/turnComplete", turnId, duration: 10 });
    await expect.poll(() => updated.mock.calls.some(([event]) => event.message.parts.some((part: { text?: string }) => part.text === "same owner"))).toBe(true);
    const history = await adapter.listMessages(id);
    expect(history).toHaveLength(2);
    expect(history[1].parts[0]).toMatchObject({ type: "text", text: "same owner" });
    expect((await adapter.listMessages(id)).map(message => message.id)).toEqual(history.map(message => message.id));
  });

  it("keeps unavailable identities and never creates a replacement after reconnect or disabling sharing", async () => {
    const { server, adapter, id } = await setup();
    await adapter.restoreSession(id);
    await adapter.setEnabled(false);
    expect((await adapter.getCatalog("copilot")).sessions[0].connection?.available).toBe(false);
    await expect(adapter.sendMessage(id, [{ type: "text", text: "offline" }])).rejects.toThrow("unavailable");
    await adapter.setEnabled(true);
    expect((await adapter.listSessions("copilot"))[0].id).toBe(id);
    await adapter.restoreSession(id);
    expect(adapter.hasSession(id)).toBe(true);
    await adapter.removeSession(id);
    expect(server.requests.some(request => ["disposeSession", "createSession"].includes(request.method))).toBe(false);
  });

  it("rejects a pending native approval and withdraws prompts when another client completes them", async () => {
    const { server, adapter, id } = await setup();
    await adapter.sendMessage(id, [{ type: "text", text: "test approval" }]);
    const turnId = server.chat.activeTurn!.id;
    server.broadcast(server.chatUri, { type: "chat/toolCallStart", turnId, toolCallId: "tool", toolName: "powershell", displayName: "Print marker" });
    server.broadcast(server.chatUri, { type: "chat/toolCallReady", turnId, toolCallId: "tool", invocationMessage: "Print marker", toolInput: "{\"command\":\"echo test\"}" });
    await expect.poll(() => adapter.getPendingPermissions(id).length).toBe(1);
    const permission = adapter.getPendingPermissions(id)[0];
    await expect(adapter.replyPermission(permission.id, { optionId: "deny" }, "another-chat")).rejects.toThrow();
    await adapter.replyPermission(permission.id, { optionId: "deny" }, id);
    expect(server.chat.activeTurn?.responseParts.find(part => part.kind === "toolCall")).toMatchObject({ toolCall: { status: "cancelled", reason: "denied" } });
    expect(adapter.getPendingPermissions(id)).toHaveLength(0);
    await expect(adapter.replyPermission(permission.id, { optionId: "allow" }, id)).rejects.toThrow("no longer");
  });

  it("validates model changes and sends mode changes to the native owner", async () => {
    const { adapter, server, id } = await setup();
    await adapter.setMode(id, "plan");
    expect(server.session.config?.values.mode).toBe("plan");
    await adapter.setModel(id, "test-model");
    expect(server.chat.draft?.model?.id).toBe("test-model");
    await expect(adapter.setModel(id, "nonexistent")).rejects.toThrow("not available");
    await expect(adapter.setReasoningEffort(id, "max")).rejects.toThrow("not supported");
  });

  it("uses the owner queue instead of starting a competing turn", async () => {
    const { adapter, server, id } = await setup();
    const consumed = vi.fn();
    adapter.on("message.queued.consumed", consumed);
    await adapter.sendMessage(id, [{ type: "text", text: "first" }]);
    const original = server.chat.activeTurn!.id;
    await adapter.sendMessage(id, [{ type: "text", text: "second" }], { clientMessageId: "optimistic-second" });
    expect(server.chat.activeTurn?.id).toBe(original);
    expect(server.chat.queuedMessages?.[0].message.text).toBe("second");
    const queued = server.chat.queuedMessages![0];
    server.broadcast(server.chatUri, { type: "chat/turnComplete", turnId: original, duration: 1 });
    server.broadcast(server.chatUri, { type: "chat/turnStarted", turnId: "next", queuedMessageId: queued.id,
      startedAt: "2026-11-19T00:00:01Z", message: queued.message });
    await expect.poll(() => consumed.mock.calls.length).toBe(1);
    expect(consumed.mock.calls[0][0]).toMatchObject({ sessionId: id, clientMessageId: "optimistic-second" });
  });

  it("keeps conflicting live owners unavailable across catalogue refreshes", async () => {
    const first = await createAgentHostFixture(), second = await createAgentHostFixture();
    cleanup.push(() => first.close(), () => second.close());
    const adapter = new AgentHostService({ enabled: true, discover: async () => [first.endpoint, second.endpoint], pollMs: 20 });
    cleanup.push(() => adapter.stop());
    await adapter.start();
    const id = (await adapter.listSessions("copilot"))[0].id;
    await expect.poll(() => first.requests.filter(request => request.method === "listSessions").length).toBeGreaterThan(2);
    expect((await adapter.getSession(id))?.connection?.available).toBe(false);
    await expect(adapter.sendMessage(id, [{ type: "text", text: "unsafe" }])).rejects.toThrow("unavailable");
    expect(first.chat.activeTurn).toBeUndefined();
    expect(second.chat.activeTurn).toBeUndefined();
  });

  it("reconnects after transport loss without replacing or duplicating the native chat", async () => {
    const server = await createAgentHostFixture();
    cleanup.push(() => server.close());
    const adapter = new AgentHostService({ enabled: true, discover: async () => [server.endpoint], pollMs: 20 });
    cleanup.push(() => adapter.stop());
    await adapter.start();
    const id = (await adapter.listSessions("copilot"))[0].id;
    await adapter.sendMessage(id, [{ type: "text", text: "persisted" }]);
    const before = (await adapter.listMessages(id)).map(message => message.id);
    server.dropConnections();
    await expect.poll(() => server.requests.filter(request => request.method === "initialize").length).toBe(2);
    await expect.poll(async () => (await adapter.getSession(id))?.connection?.available).toBe(true);
    expect((await adapter.listMessages(id)).map(message => message.id)).toEqual(before);
    expect(server.requests.some(request => request.method === "createSession")).toBe(false);
  });

  it("preserves native model configuration and maps extra-high, maximum effort, and contextSize options", async () => {
    const { server, adapter, id } = await setup(server => {
      server.models.push({
        id: "reasoning-model",
        provider: "copilotcli",
        name: "Reasoning",
        configSchema: {
          type: "object",
          properties: {
            thinkingLevel: { type: "string", default: "medium", enum: ["low", "medium", "xhigh", "max"] },
            contextSize: {
              type: "number",
              default: 272000,
              enum: [272000, 922000],
              enumLabels: ["272K", "1M"],
              enumDescriptions: ["Default", "Longer sessions"],
            } as never,
          },
        },
      });
      server.broadcast(server.chatUri, { type: "chat/draftChanged", draft: {
        text: "native draft", origin: { kind: "user" }, model: { id: "reasoning-model", config: { contextSize: 272000, thinkingLevel: "xhigh" } },
      } });
    });
    const session = await adapter.restoreSession(id);
    const modelInfo = session.connection?.models.find(m => m.modelId === "reasoning-model");
    expect(modelInfo?.capabilities?.supportedReasoningEfforts).toEqual(["low", "medium", "xhigh", "max"]);
    expect(modelInfo?.capabilities?.contextWindowOptions).toEqual([
      { id: "272000", label: "272K", tokens: 272000, description: "Default" },
      { id: "922000", label: "1M", tokens: 922000, description: "Longer sessions" },
    ]);
    expect(adapter.getReasoningEffort(id)).toBe("xhigh");
    expect(adapter.getContextWindow(id)).toBe("272000");
    await adapter.setReasoningEffort(id, "max");
    await adapter.setContextWindow(id, "922000");
    expect(server.chat.draft?.model?.config).toEqual({ contextSize: 922000, thinkingLevel: "max" });
    await adapter.setModel(id, "reasoning-model");
    expect(server.chat.draft?.text).toBe("native draft");
    await adapter.sendMessage(id, [{ type: "text", text: "keep native config" }]);
    expect(server.chat.activeTurn?.message.model?.config).toEqual({ contextSize: 922000, thinkingLevel: "max" });
    await adapter.setReasoningEffort(id, null);
    expect(server.chat.draft?.model?.config).toEqual({ contextSize: 922000 });
  });

  it("loads a read-only chat without allowing messages to its executor", async () => {
    const { adapter, server, id } = await setup(server => {
      server.broadcast(server.chatUri, { type: "chat/turnStarted", turnId: "old", startedAt: "2026-11-19T00:00:00Z",
        message: { text: "read-only history", origin: { kind: "user" } } });
      server.broadcast(server.chatUri, { type: "chat/turnComplete", turnId: "old", duration: 1 });
      Object.assign(server.chat, { interactivity: "read-only" });
    });
    expect((await adapter.listMessages(id))[0].parts[0]).toMatchObject({ text: "read-only history" });
    expect((await adapter.getSession(id))?.connection).toMatchObject({ available: true, readOnly: true });
    await expect(adapter.sendMessage(id, [{ type: "text", text: "forbidden" }])).rejects.toThrow("read-only");
    expect(server.chat.activeTurn).toBeUndefined();
  });

  it("completes native questions and refuses a stale second reply", async () => {
    const { adapter, server, id } = await setup();
    await adapter.sendMessage(id, [{ type: "text", text: "ask" }]);
    server.broadcast(server.chatUri, { type: "chat/responsePart", turnId: server.chat.activeTurn!.id, part: {
      kind: "inputRequest", request: { id: "question", message: "This operation produces a large log.\nConfirm before continuing.", questions: [
        { id: "choice", kind: "single-select", message: "Pick", required: true, options: [{ id: "one", label: "First" }] },
      ] },
    } });
    await expect.poll(() => adapter.getPendingQuestions(id).length).toBe(1);
    const question = adapter.getPendingQuestions(id)[0];
    expect(question).toMatchObject({
      message: "This operation produces a large log.\nConfirm before continuing.",
      questions: [{ question: "Pick", options: [{ label: "First" }] }],
    });
    await adapter.replyQuestion(question.id, [["First"]], id);
    expect(adapter.getPendingQuestions(id)).toHaveLength(0);
    await expect(adapter.replyQuestion(question.id, [["First"]], id)).rejects.toThrow("no longer");
    expect(server.chat.activeTurn?.responseParts[0]).toMatchObject({ kind: "inputRequest", response: "accept",
      request: { answers: { choice: { state: "submitted", value: { kind: "selected", value: "one" } } } } });
  });

  it("disables external CLI session discovery on the host and filters external CLI sessions while keeping adoptable VS Code sessions", async () => {
    const server = await createAgentHostFixture();
    cleanup.push(() => server.close());
    server.rootConfig = {
      schema: {
        type: "object",
        properties: {
          showExternalSessions: {
            type: "string",
            enum: ["none", "recent", "last24Hours", "last7Days", "last30Days"],
          },
        },
      },
      values: { showExternalSessions: "last7Days" },
    };
    server.extraSessions.set("ahp-session:/agency-cli", {
      provider: "copilotcli",
      title: "External Agency CLI chat",
      status: 1,
      lifecycle: "ready",
      activeClients: [],
      chats: [{ resource: "ahp-chat:/agency-cli", title: "External Agency CLI chat", status: 1, modifiedAt: server.chat.modifiedAt }],
      defaultChat: "ahp-chat:/agency-cli",
      _meta: { "vscode.external": true, name: "github/cli" },
    } as never);
    server.extraSessions.set("ahp-session:/legacy-vscode", {
      provider: "copilotcli",
      title: "Adopted VS Code chat",
      status: 1,
      lifecycle: "ready",
      activeClients: [],
      chats: [{ resource: "ahp-chat:/legacy-vscode", title: "Adopted VS Code chat", status: 1, modifiedAt: server.chat.modifiedAt }],
      defaultChat: "ahp-chat:/legacy-vscode",
      _meta: { "vscode.external": true, ehcliAdoptable: true },
    } as never);
    server.extraSessions.set("ahp-session:/agency-cli-unconfigured", {
      provider: "copilotcli",
      title: "External CLI chat even if host ignores config",
      status: 1,
      lifecycle: "ready",
      activeClients: [],
      chats: [{ resource: "ahp-chat:/agency-cli-unconfigured", title: "External CLI chat even if host ignores config", status: 1, modifiedAt: server.chat.modifiedAt }],
      defaultChat: "ahp-chat:/agency-cli-unconfigured",
      _meta: { "vscode.external": true },
    } as never);

    const adapter = new AgentHostService({ enabled: true, discover: async () => [server.endpoint], pollMs: 100_000 });
    cleanup.push(() => adapter.stop());
    await adapter.start();

    expect(server.rootConfig?.values?.showExternalSessions).toBe("none");
    const titles = (await adapter.listSessions("copilot")).map(s => s.title);
    expect(titles).toEqual(["Native editor chat", "Adopted VS Code chat"]);

    // Even if a host lacks showExternalSessions in rootConfig and still lists external CLI sessions, client-side filtering excludes them.
    server.rootConfig = undefined;
    await adapter.setEnabled(false);
    await adapter.setEnabled(true);
    expect((await adapter.listSessions("copilot")).map(s => s.title)).toEqual(["Native editor chat", "Adopted VS Code chat"]);
  });

  it("creates a new VS Code session via createSession, keeps provisional sessions available across poll cycles, and falls back when requested engine is unsupported", async () => {
    const server = await createAgentHostFixture("copilotcli");
    cleanup.push(() => server.close());
    const adapter = new AgentHostService({ enabled: true, discover: async () => [server.endpoint], pollMs: 25 });
    cleanup.push(() => adapter.stop());
    await adapter.start();
    expect(adapter.getState().canCreateSession).toBe(true);

    // Requesting "opencode" (unsupported in VS Code) falls back to advertised "copilotcli" -> "copilot"
    const created = await adapter.createSession("opencode", "/tmp/new-vscode-project");
    expect(created.engineType).toBe("copilot");
    expect(created.directory).toContain("new-vscode-project");
    expect(created.connection).toMatchObject({ source: "VS Code", executor: "VS Code", available: true });

    // Wait across background listSessions polls while the new session is still idle-provisional
    const catalogEventsDuringIdlePolls: unknown[] = [];
    adapter.on("catalog.updated", (ev) => catalogEventsDuringIdlePolls.push(ev));
    const pollsBefore = server.requests.filter(r => r.method === "listSessions").length;
    await expect.poll(() => server.requests.filter(r => r.method === "listSessions").length).toBeGreaterThan(pollsBefore + 2);
    expect((await adapter.getSession(created.id))?.connection?.available).toBe(true);
    // Unchanged poll cycles must not spam redundant catalog.updated broadcasts
    expect(catalogEventsDuringIdlePolls).toHaveLength(0);

    // Sending the first prompt routes directly to the newly created VS Code chat
    await adapter.sendMessage(created.id, [{ type: "text", text: "hello from CodeMux" }]);
    const createdChatUri = String(created.engineMeta?.ahpChat);
    expect(server.extraChats.get(createdChatUri)?.activeTurn?.message.text).toBe("hello from CodeMux");
  });
});

describe("native projection", () => {
  it("scopes chat and message identities by source while preserving ordered text, reasoning, and errors", () => {
    const chat = { resource: "ahp-chat:/same", title: "", modifiedAt: "2026-11-19T00:00:00Z", status: 2, turns: [{
      id: "turn", startedAt: "2026-11-19T00:00:00Z", state: "error", message: { text: "prompt", origin: { kind: "user" } },
      responseParts: [{ kind: "reasoning", id: "reason", content: "working" }, { kind: "markdown", id: "text", content: "answer" },
        { kind: "error", error: { errorType: "test", message: "failed" } }],
    }] } as ChatState;
    const a = nativeChatId("source-a", chat.resource), b = nativeChatId("source-b", chat.resource);
    const messages = projectChat(a, chat, "", "copilot");
    expect(a).not.toBe(b);
    expect(messages[1].id).not.toBe(projectChat(b, chat, "", "copilot")[1].id);
    expect(messages[1]).toMatchObject({ error: "failed", parts: [{ type: "reasoning", order: 0 }, { type: "text", order: 1 }] });
  });

  it("maps choice labels to native IDs and validates constrained answers without dropping whitespace", () => {
    const request = { id: "input", questions: [
      { id: "choice", kind: "single-select", message: "Pick", required: true, options: [{ id: "native-id", label: "Visible choice" }] },
      { id: "count", kind: "integer", message: "Count", min: 1, max: 3 },
      { id: "text", kind: "text", message: "Text", min: 1 },
    ] } as ChatInputRequest;
    expect(inputAnswers(request, [["Visible choice"], ["2"], [" x "]])).toMatchObject({
      choice: { state: "submitted", value: { kind: "selected", value: "native-id" } },
      count: { value: { kind: "number", value: 2 } }, text: { value: { value: " x " } },
    });
    expect(() => inputAnswers(request, [["bad"], ["2"], ["x"]])).toThrow();
    expect(() => inputAnswers(request, [["Visible choice"], ["2.5"], ["x"]])).toThrow();
    expect(() => inputAnswers(request, [[], ["2"], ["x"]])).toThrow();
  });

  it("projects optional ask_user questions as skippable without enabling invalid freeform empty strings", () => {
    const request: ChatInputRequest = {
      id: "ask-user-form",
      message: "Confirm mobile context menu design",
      questions: [
        {
          id: "desktopRightClick",
          kind: "single-select",
          title: "Desktop right click",
          message: "Enable desktop right click?",
          required: false,
          allowFreeformInput: true,
          options: [
            { id: "true", label: "True", recommended: true },
            { id: "false", label: "False" },
          ],
        },
        {
          id: "extraTargets",
          kind: "text",
          title: "Extra targets",
          message: "Optional extra areas",
          required: false,
        },
        {
          id: "menuStyle",
          kind: "single-select",
          title: "Menu style",
          message: "Choose menu style",
          required: false,
          options: [
            { id: "bottom_sheet", label: "Bottom Sheet" },
            { id: "popover", label: "Popover" },
          ],
        },
        {
          id: "requiredEmptyText",
          kind: "text",
          message: "Required text allowing empty",
          required: true,
          min: 0,
        },
      ],
    };
    const chat = {
      resource: "ahp-chat:/q",
      title: "Q",
      status: 6,
      modifiedAt: "2026-11-22T00:00:00Z",
      turns: [],
      activeTurn: {
        id: "t1",
        startedAt: "2026-11-22T00:00:00Z",
        message: { text: "hi", origin: { kind: "user" } },
        responseParts: [{ kind: "inputRequest", request }],
      },
    } as ChatState;

    const projected = projectInputs("conv-1", chat, "copilot").questions[0].question;
    expect(projected.questions[0]).toMatchObject({
      required: false,
      custom: true,
      allowEmptyAnswer: false,
      defaultSelected: ["True"],
    });
    expect(projected.questions[1]).toMatchObject({
      required: false,
      custom: true,
      preserveWhitespace: true,
      allowEmptyAnswer: false,
    });
    expect(projected.questions[2]).toMatchObject({
      required: false,
      custom: false,
      allowEmptyAnswer: false,
    });
    expect(projected.questions[3]).toMatchObject({
      required: true,
      custom: true,
      allowEmptyAnswer: true,
    });

    // Submitting with optional fields skipped ([]) and required empty text ([""]) succeeds cleanly.
    expect(inputAnswers(request, [["True"], [], [], [""]])).toEqual({
      desktopRightClick: { state: "submitted", value: { kind: "selected", value: "true" } },
      extraTargets: { state: "skipped" },
      menuStyle: { state: "skipped" },
      requiredEmptyText: { state: "submitted", value: { kind: "text", value: "" } },
    });
  });
});
