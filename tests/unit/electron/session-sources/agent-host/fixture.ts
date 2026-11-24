import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket, { WebSocketServer } from "ws";
import { chatReducer, sessionReducer, type ChatAction, type ChatState, type SessionAction, type SessionState, type StateAction, type RootState } from "@microsoft/agent-host-protocol";
import type { Wire } from "../../../../../electron/main/session-sources/agent-host/wire";
import type { AgentHostEndpoint } from "../../../../../electron/main/session-sources/agent-host/discovery";

export async function createAgentHostFixture(provider = "copilotcli", transport: "socket" | "tcp" = "socket") {
  const instance = randomUUID();
  const path = process.platform === "win32" ? `\\\\.\\pipe\\vscode-agent-host-codemux-test-${instance}` : join(tmpdir(), `cm-ahp-${instance}.sock`);
  const endpoint: AgentHostEndpoint = { source: "a".repeat(64), type: transport === "tcp" ? "standalone" : "editor",
    instanceId: instance, pid: process.pid, transport: { type: "socket", path }, token: "test-token-for-local-fixture" };
  const sessionUri = "ahp-session:/fixture";
  const chatUri = "ahp-chat:/fixture";
  const now = "2026-11-19T00:00:00.000Z";
  let session = {
    provider, title: "Native editor chat", status: 1, lifecycle: "ready", activeClients: [],
    chats: [{ resource: chatUri, title: "Native editor chat", status: 1, modifiedAt: now }], defaultChat: chatUri,
    config: {
      schema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["interactive", "plan"], sessionMutable: true, chatMutable: true },
          autoApprove: { type: "string", enum: ["default", "assisted", "autoApprove"], sessionMutable: true, chatMutable: true },
        },
      },
      values: { mode: "interactive", autoApprove: "default", availableApprovalModes: ["default", "assisted", "autoApprove"] },
    },
  } as SessionState;
  let chat = { resource: chatUri, title: "Native editor chat", status: 1, modifiedAt: now, turns: [] } as ChatState;
  const extraChats = new Map<string, ChatState>();
  const extraSessions = new Map<string, SessionState>();
  let rootConfig: RootState["config"] | undefined;
  let seq = 0;
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url!, "http://localhost").searchParams.get("tkn") !== endpoint.token) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });
  const clients = new Map<WebSocket, { id: string; subscriptions: Set<string> }>();
  const broadcast = (channel: string, action: Wire<StateAction>, origin?: { clientId: string; clientSeq: number }, rejectionReason?: string) => {
    if (!rejectionReason) {
      if (channel === "ahp-root://" && (action as { type?: string }).type === "root/configChanged" && rootConfig) {
        const next = action as { config: Record<string, unknown>; replace?: boolean };
        rootConfig = { ...rootConfig, values: next.replace ? { ...next.config } : { ...rootConfig.values, ...next.config } };
      }
      if (channel === chatUri) chat = chatReducer(chat, action as ChatAction);
      else if (extraChats.has(channel)) extraChats.set(channel, chatReducer(extraChats.get(channel)!, action as ChatAction));
      if (channel === sessionUri) session = sessionReducer(session, action as SessionAction);
      else if (extraSessions.has(channel)) extraSessions.set(channel, sessionReducer(extraSessions.get(channel)!, action as SessionAction));
    }
    const params = { channel, action, serverSeq: ++seq, ...(origin ? { origin } : {}), ...(rejectionReason ? { rejectionReason } : {}) };
    for (const [ws, client] of clients) if (ws.readyState === WebSocket.OPEN && client.subscriptions.has(channel)) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "action", params }));
  };
  const fixture = {
    endpoint, sessionUri, chatUri, requests, broadcast, extraChats, extraSessions,
    get rootConfig() { return rootConfig; },
    set rootConfig(value: RootState["config"] | undefined) { rootConfig = value; },
    models: [{ id: "test-model", name: "Test", provider }] as NonNullable<RootState["agents"][number]["models"]>,
    providers: [provider],
    worktreeSupported: true,
    defaultBaseBranch: "origin/main",
    unavailableSession: false,
    get connectionCount() { return clients.size; },
    rejectNext: false,
    get chat() { return chat; },
    get session() { return session; },
    snapshotInterleave: undefined as (() => void) | undefined,
    dropConnections() { for (const ws of wss.clients) ws.terminate(); },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
  wss.on("connection", ws => {
    const client = { id: "", subscriptions: new Set<string>() };
    clients.set(ws, client);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", data => {
      const { id, method, params } = JSON.parse(data.toString());
      requests.push({ method, params });
      const result = (value: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: value }));
      if (method === "initialize") {
        client.id = params.clientId;
        client.subscriptions.add("ahp-root://");
        result({ protocolVersion: "1.1.0", serverSeq: seq, snapshots: [{ resource: "ahp-root://", fromSeq: seq, state: {
          agents: fixture.providers.map(provider => ({ provider, displayName: provider, models: fixture.models.filter(model => model.provider === provider) })),
          activeSessions: [],
          ...(rootConfig ? { config: rootConfig } : {}),
        } }] });
      } else if (method === "listSessions") result({ items: [
        ...(fixture.unavailableSession ? [{ resource: "ahp-session:/unavailable", provider: "other-harness" }] : []),
        { resource: sessionUri, ...session },
        ...[...extraSessions.entries()]
          .filter(([, state]) => {
            const meta = state._meta as Record<string, unknown> | undefined;
            const isExt = meta?.["vscode.external"] === true && meta?.["ehcliAdoptable"] !== true;
            if (isExt && rootConfig?.values?.showExternalSessions === "none") return false;
            const defChat = state.defaultChat ? extraChats.get(state.defaultChat) : undefined;
            const isIdleProvisional = state.lifecycle === "creating" && !defChat?.activeTurn && (defChat?.turns.length ?? 0) === 0;
            return !isIdleProvisional;
          })
          .map(([resource, state]) => ({ resource, ...state })),
      ] });
      else if (method === "resolveSessionConfig") {
        const requestedIsolation = (params.config as Record<string, unknown> | undefined)?.isolation;
        const canWorktree = Boolean(params.workingDirectory) && fixture.worktreeSupported;
        const isolationEnum = canWorktree ? ["folder", "worktree"] : ["folder"];
        const resolvedIsolation = requestedIsolation === "folder" || !canWorktree
          ? "folder"
          : "worktree";
        result({
          schema: {
            type: "object",
            properties: {
              isolation: { type: "string", enum: isolationEnum, default: canWorktree ? "worktree" : "folder", readOnly: !canWorktree },
              ...(canWorktree ? { branch: { type: "string", enum: [fixture.defaultBaseBranch], default: fixture.defaultBaseBranch } } : {}),
            },
          },
          values: {
            isolation: resolvedIsolation,
            ...(canWorktree ? { branch: resolvedIsolation === "worktree" ? fixture.defaultBaseBranch : "main" } : {}),
          },
        });
      }
      else if (method === "createSession") {
        const createdUri = String(params.channel);
        const createdChatUri = createdUri.replace("ahp-session:", "ahp-chat:");
        const createdProvider = typeof params.provider === "string" ? params.provider : provider;
        const rawWorkingDirectories = Array.isArray(params.workingDirectories) ? params.workingDirectories as string[] : undefined;
        const createConfig = params.config as Record<string, unknown> | undefined;
        const useWorktree = fixture.worktreeSupported && createConfig?.isolation === "worktree";
        const workingDirectories = rawWorkingDirectories?.map((uri) =>
          useWorktree ? `${uri.replace(/\/+$/, "")}.worktrees/created-branch` : uri,
        );
        extraChats.set(createdChatUri, {
          resource: createdChatUri,
          title: "New chat",
          status: 1,
          modifiedAt: now,
          turns: [],
          ...(workingDirectories ? { workingDirectories } : {}),
        } as ChatState);
        extraSessions.set(createdUri, {
          provider: createdProvider,
          title: "New chat",
          status: 1,
          lifecycle: "creating",
          activeClients: [],
          ...(workingDirectories ? { workingDirectories } : {}),
          chats: [{ resource: createdChatUri, title: "New chat", status: 1, modifiedAt: now, ...(workingDirectories ? { workingDirectories } : {}) }],
          defaultChat: createdChatUri,
          config: {
            schema: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["interactive", "plan"], sessionMutable: true, chatMutable: true },
                autoApprove: { type: "string", enum: ["default", "assisted", "autoApprove"], sessionMutable: true, chatMutable: true },
              },
            },
            values: { mode: "interactive", autoApprove: "default", availableApprovalModes: ["default", "assisted", "autoApprove"] },
          },
        } as SessionState);
        result(null);
      }
      else if (method === "ping") result(null);
      else if (method === "subscribe") {
        if (params.channel === "ahp-session:/unavailable") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Session unavailable" } }));
          return;
        }
        client.subscriptions.add(params.channel);
        const snapshot = { resource: params.channel, fromSeq: seq, state: structuredClone(params.channel === chatUri ? chat : extraChats.get(params.channel) ?? extraSessions.get(params.channel) ?? session) };
        const interleave = fixture.snapshotInterleave;
        fixture.snapshotInterleave = undefined;
        interleave?.();
        result({ snapshot });
      } else if (method === "dispatchAction") {
        const reject = fixture.rejectNext;
        fixture.rejectNext = false;
        broadcast(params.channel, params.action, { clientId: client.id, clientSeq: params.clientSeq }, reject ? "not-allowed" : undefined);
      } else if (method === "unsubscribe") client.subscriptions.delete(params.channel);
      else if (id !== undefined) ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported fixture method" } }));
    });
  });
  await new Promise<void>(resolve => transport === "tcp" ? server.listen(0, "127.0.0.1", resolve) : server.listen(path, resolve));
  const address = server.address();
  if (typeof address === "object" && address) endpoint.transport = { type: "tcp", host: address.address, port: address.port };
  return fixture;
}
