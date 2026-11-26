import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ChatState, ChatSummary, SessionState, RootState, SessionConfigPropertySchema, ModelSelection, Message, ActionEnvelope,
} from "@microsoft/agent-host-protocol";
import type { SendMessageOptions, SessionBackendEvents } from "../../../../shared/session-backend";
import type { CreateSessionSourceOptions, SessionSource } from "../session-source";
import {
  formatContextWindowTokens,
  type ContextWindowOption,
  type EngineType, type EngineCapabilities, type EngineCatalogSnapshot, type SessionSourceState, type MessagePromptContent,
  type PermissionReply, type ReasoningEffort, type UnifiedMessage, type UnifiedSession, type UnifiedModelInfo,
  type UnifiedSessionFilePreview, type UnifiedSessionWorkspaceState,
} from "../../../../src/types/unified";
import { agentHostEndpointKey, discoverAgentHosts, type AgentHostEndpoint } from "./discovery";
import { AgentHostConnection, ROOT } from "./connection";
import { activity, inputAnswers, nativeChatId, projectChat, projectInputs, scopedId, type PermissionRoute, type QuestionRoute, type TurnProjectionCache } from "./projection";
import { projectSessionWorkspace, readAgentHostFilePreview, resolvePreferredChangesetUri } from "./workspace";
import { SESSION_FLAGS, type Wire } from "./wire";
import { engineProvider, providerEngine, supportedEngines, agentHostCatalogId } from "./providers";

function unifiedEffort(value: unknown): ReasoningEffort | undefined {
  if (value === "balance") return "medium";
  if (value === "hydrafusion") return "high";
  if (value === "hydrafusion-max") return "max";
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}
function nativeTierEffort(effort: ReasoningEffort): string {
  if (effort === "medium") return "balance";
  if (effort === "high") return "hydrafusion";
  if (effort === "max") return "hydrafusion-max";
  return effort;
}
function isExternalCliSession(session: SessionState): boolean {
  const meta = session._meta as Record<string, unknown> | undefined;
  return meta?.["vscode.external"] === true && meta?.["ehcliAdoptable"] !== true;
}

interface ApprovalPropertyResolution {
  key: string;
  prop: SessionConfigPropertySchema;
  supported: boolean;
  active: boolean;
  onValue: string;
  offValue: string;
}

function resolveApprovalProperty(
  session: SessionState,
  chat: ChatSummary | ChatState,
  root?: RootState,
): ApprovalPropertyResolution | undefined {
  const chatConfig = "config" in chat ? chat.config : undefined;
  const schemaProps = chatConfig?.schema?.properties ?? session.config?.schema?.properties;
  if (!schemaProps) return undefined;
  const values = { ...session.config?.values, ...chatConfig?.values };
  const policyRestricted = root?.config?.values?.autoApprovePolicyRestricted === true;
  const isWritable = (prop: SessionConfigPropertySchema | undefined) =>
    Boolean(prop && !prop.readOnly && (prop.sessionMutable || (chatConfig && prop.chatMutable)));

  if (schemaProps.autoApprove) {
    const prop = schemaProps.autoApprove;
    const available = Array.isArray(values.availableApprovalModes) ? values.availableApprovalModes : prop.enum;
    const supported = isWritable(prop) && !policyRestricted && (!available || available.includes("autoApprove"));
    const active = !policyRestricted && (
      values.autoApprove !== undefined
        ? values.autoApprove === "autoApprove"
        : values.effectiveApprovalMode === "autoApprove"
    );
    return { key: "autoApprove", prop, supported, active, onValue: "autoApprove", offValue: "default" };
  }

  if (schemaProps.approvalMode) {
    const prop = schemaProps.approvalMode;
    const available = Array.isArray(values.availableApprovalModes) ? values.availableApprovalModes : prop.enum;
    const supported = isWritable(prop) && !policyRestricted && (!available || available.includes("allow-all"));
    const active = !policyRestricted && values.approvalMode === "allow-all";
    return { key: "approvalMode", prop, supported, active, onValue: "allow-all", offValue: "manual" };
  }

  if (schemaProps.permissionMode) {
    const prop = schemaProps.permissionMode;
    const supported = isWritable(prop) && (!prop.enum || prop.enum.includes("bypassPermissions"));
    const active = values.permissionMode === "bypassPermissions";
    return { key: "permissionMode", prop, supported, active, onValue: "bypassPermissions", offValue: "default" };
  }

  const codexPreset = schemaProps["codex.permissionsPreset"];
  if (codexPreset) {
    const supported = isWritable(codexPreset) && (!codexPreset.enum || codexPreset.enum.includes("full-access"));
    const active = values["codex.permissionsPreset"] === "full-access";
    return { key: "codex.permissionsPreset", prop: codexPreset, supported, active, onValue: "full-access", offValue: "default" };
  }

  return undefined;
}
interface Entry {
  provider: string;
  source: string;
  sessionUri: string;
  chatUri: string;
  changesetUri?: string;
  workspaceDigest?: string;
  session: UnifiedSession;
  host?: AgentHostConnection;
  attached: boolean;
  emptySeededDraft?: boolean;
  messages: Map<string, UnifiedMessage>;
  turns: TurnProjectionCache;
}
export interface AgentHostServiceOptions {
  enabled?: boolean;
  isWorktreeEnabled?: () => boolean;
  knownSessions?: () => UnifiedSession[];
  persistEnabled?: (enabled: boolean) => Promise<void>;
  discover?: () => Promise<AgentHostEndpoint[]>;
  createConnection?: (endpoint: AgentHostEndpoint, options: ConstructorParameters<typeof AgentHostConnection>[1]) => AgentHostConnection;
  pollMs?: number;
}

/** One connection pool and discovery loop per source, shared by every harness. */
export class AgentHostService extends EventEmitter<{ [K in keyof SessionBackendEvents]: Parameters<SessionBackendEvents[K]> }> implements SessionSource {
  private enabled: boolean;
  private running = false;
  private hosts = new Map<string, AgentHostConnection>();
  private entries = new Map<string, Entry>();
  private permissions = new Map<string, PermissionRoute>();
  private questions = new Map<string, QuestionRoute>();
  private queued = new Map<string, { sessionId: string; clientMessageId?: string; announced: boolean }>();
  private timer?: ReturnType<typeof setTimeout>;
  private publishing?: ReturnType<typeof setTimeout>;
  private dirty = new Set<string>();
  private refresh?: Promise<void>;
  private transition?: Promise<SessionSourceState>;
  private generation = 0;
  private revision = 0;
  private initialized = false;
  private initialRefreshDone = false;
  private configuredHosts = new WeakSet<AgentHostConnection>();
  private createdSessions = new Set<string>();
  private suppressedStandaloneKeys = new Map<string, string>();
  private publishedCatalogDigests = new Map<EngineType, string>();

  constructor(private readonly options: AgentHostServiceOptions = {}) { super(); this.enabled = options.enabled === true; }
  async start() { this.running = true; this.seed(); if (this.enabled) await this.refreshHosts(); else this.publishCatalog(); }
  async stop() {
    this.running = false;
    this.initialRefreshDone = false;
    this.createdSessions.clear();
    this.suppressedStandaloneKeys.clear();
    this.publishedCatalogDigests.clear();
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.publishing);
    this.publishing = undefined;
    this.dirty.clear();
    await Promise.all([...this.hosts.values()].map(host => host.close()));
    this.hosts.clear();
    await this.refresh;
    this.publishCatalog();
  }
  getCapabilities(): EngineCapabilities {
    return { authoritativeSessionState: true, sourceScopedMessageIds: true, confirmedSessionRemoval: true, providerModelHierarchy: false,
      dynamicModes: true, messageCancellation: true, permissionAlways: false, imageAttachment: true,
      loadSession: true, listSessions: true, modelSwitchable: true, customModelInput: false,
      messageEnqueue: true, slashCommands: false, allowAllPermissionsSupported: true, availableModes: [],
      reasoningEffortOptions: ["none", "low", "medium", "high", "xhigh", "max"] };
  }
  getSessionCapabilities(id: string): EngineCapabilities {
    return this.entries.get(id)?.session.connection?.capabilities ?? this.getCapabilities();
  }
  getState(): SessionSourceState {
    const hosts = [...this.hosts.values()].filter(host => host.connected);
    const syncingInitial = this.enabled && !this.initialRefreshDone && Boolean(this.refresh);
    const available = this.enabled && !syncingInitial && hosts.length > 0;
    const providers = [...new Set(hosts.flatMap(host => host.root?.agents.map(agent => agent.provider) ?? []))];
    return { id: "vscode", enabled: this.enabled, available, peerName: "VS Code", kind: "attach",
      canCreateSession: available && providers.some(id => providerEngine(id) !== undefined),
      providers: providers.map(id => ({ id, engineType: providerEngine(id), supported: providerEngine(id) !== undefined })),
      status: !this.enabled ? "disabled" : syncingInitial ? "connecting" : available ? "connected" : this.refresh ? "connecting" : "unavailable" };
  }
  async setEnabled(enabled: boolean): Promise<SessionSourceState> {
    const previous = this.transition;
    const operation = (async () => {
      await previous?.catch(() => undefined);
      await this.options.persistEnabled?.(enabled);
      this.enabled = enabled;
      if (enabled) await this.start();
      else { await this.stop(); this.running = true; }
      return this.getState();
    })();
    this.transition = operation;
    try { return await operation; } finally { if (this.transition === operation) this.transition = undefined; }
  }

  private seed() {
    if (this.initialized) return;
    this.initialized = true;
    for (const session of this.options.knownSessions?.() ?? []) {
      const { ahpSource: source, ahpSession: sessionUri, ahpChat: chatUri } = session.engineMeta ?? {};
      // Old Copilot mirrors predate provider metadata; preserve their identities.
      const provider = session.engineMeta?.ahpProvider ?? (session.engineType === "copilot" ? "copilotcli" : undefined);
      if (typeof source !== "string" || typeof sessionUri !== "string" || typeof chatUri !== "string"
        || typeof provider !== "string" || providerEngine(provider) !== session.engineType
        || session.id !== nativeChatId(source, chatUri)) continue;
      const localMessageCount = typeof session.engineMeta?.localMessageCount === "number"
        ? session.engineMeta.localMessageCount
        : 0;
      const { localMessageCount: _dropCount, ...cleanMeta } = session.engineMeta ?? {};
      this.entries.set(session.id, { provider, source, sessionUri, chatUri, session: { ...session,
        engineMeta: cleanMeta,
        projectId: scopedId(source, session.directory), connection: this.connection() },
        attached: false, emptySeededDraft: localMessageCount === 0, messages: new Map(), turns: new Map() });
    }
  }
  private isTombstonedSessionError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: unknown }).code;
    const message = String((error as { message?: unknown }).message ?? "");
    return code === -32001 || /explicitly deleted|tombstoned|Session not found/i.test(message);
  }
  private async resurrectDeletedEmptyDraft(entry: Entry, host: AgentHostConnection): Promise<Entry | undefined> {
    const oldId = entry.session.id;
    const oldTitle = entry.session.title?.trim();
    const oldDir = entry.session.directory?.trim();
    const isScratchCopilotChatDir = Boolean(oldDir && /[\\/]\.copilot[\\/]chats[\\/]/i.test(oldDir));
    const resolvedDir = oldDir && oldDir !== "." && !isScratchCopilotChatDir ? resolvePath(oldDir) : undefined;
    const workingDirectories = resolvedDir ? [pathToFileURL(resolvedDir).href] : undefined;
    const isExistingWorktree = Boolean(resolvedDir && /\.worktrees[\\/]/i.test(resolvedDir));
    const useWorktree = isExistingWorktree ? false : this.options.isWorktreeEnabled?.() === true;
    const config = await this.resolveInitialSessionConfig(host, entry.provider, workingDirectories?.[0], useWorktree);
    const newSessionUri = `ahp-session:/${randomUUID()}`;
    await host.request("createSession", {
      channel: newSessionUri,
      provider: entry.provider,
      ...(workingDirectories ? { workingDirectories } : {}),
      config,
    });
    this.createdSessions.add(newSessionUri);
    await host.subscribe(newSessionUri);
    let session = host.sessions.get(newSessionUri);
    const newChatUri = session?.defaultChat ?? session?.chats?.[0]?.resource;
    if (!session || !newChatUri) {
      this.createdSessions.delete(newSessionUri);
      return undefined;
    }
    if (oldTitle && session.defaultChat === newChatUri) {
      await host.dispatch(newSessionUri, { type: "session/titleChanged", title: oldTitle }).catch(() => {});
      session = host.sessions.get(newSessionUri) ?? session;
    }
    this.catalogSession(host, newSessionUri, session);
    const newId = nativeChatId(host.endpoint.source, newChatUri);
    const nextEntry = this.entries.get(newId);
    if (!nextEntry) {
      this.createdSessions.delete(newSessionUri);
      return undefined;
    }
    nextEntry.emptySeededDraft = true;
    this.createdSessions.add(newSessionUri);
    this.entries.delete(oldId);
    this.emit("session.rebound", { previousSessionId: oldId, session: nextEntry.session });
    this.publishCatalog();
    await host.subscribe(newChatUri);
    nextEntry.attached = true;
    const createdSession = host.sessions.get(newSessionUri);
    const createdChat = host.chats.get(newChatUri);
    if (createdSession && createdChat) {
      const approval = resolveApprovalProperty(createdSession, createdChat, host.root);
      const wantApprove = entry.session.allowAllPermissions ?? true;
      if (approval?.supported && approval.active !== wantApprove) {
        await this.dispatchConfigProperty(
          nextEntry,
          host,
          createdSession,
          createdChat,
          approval.key,
          approval.prop,
          wantApprove ? approval.onValue : approval.offValue,
        ).catch(() => {});
      }
    }
    this.publishChat(nextEntry);
    return nextEntry;
  }
  private async reconcileOmittedEntriesForSource(source: string): Promise<void> {
    const candidates = [...this.hosts.values()].filter(h => h.connected && h.endpoint.source === source);
    if (!candidates.length) return;
    for (const [id, entry] of [...this.entries.entries()]) {
      if (entry.source !== source || entry.host?.connected) continue;
      if (this.createdSessions.has(entry.sessionUri)) continue;
      const probeHost = this.selectHostForSession(candidates, entry.provider, entry.session.directory) ?? candidates[0];
      if (!probeHost) continue;
      try {
        await probeHost.subscribe(entry.sessionUri);
        const session = probeHost.sessions.get(entry.sessionUri);
        if (session && !isExternalCliSession(session)) {
          // Idle provisional drafts (`lifecycle: "creating"`) are omitted from `listSessions`
          // until their first turn starts — register them in `createdSessions` so subsequent
          // poll cycles keep `entry.host` attached instead of marking them unavailable!
          if (entry.emptySeededDraft || session.lifecycle === "creating") {
            this.createdSessions.add(entry.sessionUri);
          }
          this.catalogSession(probeHost, entry.sessionUri, session);
          // Keep empty unused drafts subscribed so Agent Host's 30s unused-draft GC does not reap them.
          if (entry.emptySeededDraft || session.lifecycle === "creating") {
            const cUri = entry.chatUri;
            await probeHost.subscribe(cUri).catch(() => {});
            entry.attached = true;
          }
        }
      } catch (error) {
        if (!this.isTombstonedSessionError(error)) continue;
        if (entry.emptySeededDraft && entry.messages.size === 0) {
          await this.resurrectDeletedEmptyDraft(entry, probeHost).catch(() => {
            this.clearInputs(id);
            this.entries.delete(id);
          });
        } else {
          this.clearInputs(id);
          this.entries.delete(id);
        }
      }
    }
  }
  private connection(host?: AgentHostConnection, writable = true) {
    return { source: "VS Code", origin: undefined, executor: "VS Code", shared: true, authoritative: true, localRemovalOnly: true,
      available: this.enabled && host?.connected === true, readOnly: !writable,
      models: [], modes: [],
      capabilities: { ...this.getCapabilities(), imageAttachment: false, modelSwitchable: false, dynamicModes: false, allowAllPermissionsSupported: false },
      sharingStatus: this.enabled ? host?.connected ? "connected" as const : "unavailable" as const : "disabled" as const,
      runtimeVersion: host?.version };
  }
  private hasExternalSessionActivity(host: AgentHostConnection, session: SessionState, chat?: ChatSummary | ChatState): boolean {
    if ((session.activeClients ?? []).some(client => client.clientId !== host.id)) return true;
    if ((session.status & SESSION_FLAGS.active) !== 0) return true;
    if (chat && (chat.status & SESSION_FLAGS.active) !== 0) return true;
    if (chat && "activeTurn" in chat && Boolean(chat.activeTurn)) return true;
    return false;
  }
  private hostLiveScore(host: AgentHostConnection): number {
    let score = (host.root?.activeSessions ?? 0) * 10;
    for (const [uri, session] of host.sessions) {
      if (isExternalCliSession(session)) continue;
      if ((session.activeClients ?? []).some(client => client.clientId !== host.id)) score += 100;
      if ((session.status & SESSION_FLAGS.active) !== 0) score += 20;
      if (this.createdSessions.has(uri)) score += 50;
    }
    for (const entry of this.entries.values()) {
      if (entry.host === host && entry.attached) score += 5;
    }
    return score;
  }
  private resolveOwnerHost(source: string, chatUri: string): { owner?: AgentHostConnection; sessionUri?: string; session?: SessionState; competing: boolean } {
    const candidates: Array<{
      host: AgentHostConnection;
      sessionUri: string;
      session: SessionState;
      chat: ChatSummary | ChatState;
      chatLive: number;
      hostLive: number;
      standalone: number;
    }> = [];
    for (const candidate of this.hosts.values()) {
      if (!candidate.connected || candidate.endpoint.source !== source) continue;
      for (const [sUri, state] of candidate.sessions) {
        if (isExternalCliSession(state)) continue;
        const summary = state.chats?.find(c => c.resource === chatUri);
        if (!summary) continue;
        const fullChat = candidate.chats.get(chatUri) ?? summary;
        candidates.push({
          host: candidate,
          sessionUri: sUri,
          session: state,
          chat: fullChat,
          chatLive: this.hasExternalSessionActivity(candidate, state, fullChat) || (this.createdSessions.has(sUri) && candidate.sessions.has(sUri)) ? 1 : 0,
          hostLive: this.hostLiveScore(candidate) > 0 ? 1 : 0,
          standalone: candidate.endpoint.type === "standalone" ? 1 : 0,
        });
        break;
      }
    }
    if (candidates.length === 0) return { competing: false };
    if (candidates.length === 1) {
      const only = candidates[0];
      return { owner: only.host, sessionUri: only.sessionUri, session: only.session, competing: false };
    }
    candidates.sort((a, b) => (b.chatLive - a.chatLive) || (b.hostLive - a.hostLive) || (b.standalone - a.standalone));
    const [best, second] = candidates;
    const tied = best.chatLive === second.chatLive
      && best.hostLive === second.hostLive
      && best.standalone === second.standalone;
    if (tied) return { competing: true };
    return { owner: best.host, sessionUri: best.sessionUri, session: best.session, competing: false };
  }
  private reconcileSourceCatalog(source: string) {
    for (const host of this.hosts.values()) {
      if (!host.connected || host.endpoint.source !== source) continue;
      for (const [uri, session] of host.sessions) {
        this.catalogSession(host, uri, session);
      }
    }
  }
  private async pruneRedundantStandaloneHosts(endpoints: AgentHostEndpoint[]): Promise<void> {
    const order = new Map(endpoints.map((ep, idx) => [agentHostEndpointKey(ep), idx]));
    const bySource = new Map<string, AgentHostConnection[]>();
    for (const host of this.hosts.values()) {
      if (!host.connected || host.endpoint.type !== "standalone") continue;
      const list = bySource.get(host.endpoint.source) ?? [];
      list.push(host);
      bySource.set(host.endpoint.source, list);
    }
    for (const [source, list] of bySource) {
      if (list.length <= 1) continue;
      list.sort((a, b) => {
        const diff = this.hostLiveScore(b) - this.hostLiveScore(a);
        if (diff !== 0) return diff;
        return (order.get(agentHostEndpointKey(a.endpoint)) ?? 0) - (order.get(agentHostEndpointKey(b.endpoint)) ?? 0);
      });
      const primary = list[0];
      const primaryKey = agentHostEndpointKey(primary.endpoint);
      let pruned = false;
      for (const extra of list.slice(1)) {
        if (this.hostLiveScore(extra) > 0) continue;
        const extraKey = agentHostEndpointKey(extra.endpoint);
        this.suppressedStandaloneKeys.set(extraKey, primaryKey);
        this.hosts.delete(extraKey);
        for (const entry of this.entries.values()) {
          if (entry.host === extra) entry.host = undefined;
        }
        await extra.close();
        pruned = true;
      }
      if (pruned) this.reconcileSourceCatalog(source);
    }
  }
  private async refreshHosts(): Promise<void> {
    if (this.refresh) return this.refresh;
    const generation = this.generation;
    this.refresh = (async () => {
      const endpoints = await (this.options.discover ?? discoverAgentHosts)();
      if (!this.running || !this.enabled || generation !== this.generation) return;
      const present = new Set(endpoints.map(agentHostEndpointKey));
      for (const [key, host] of this.hosts) {
        if (!present.has(key) || !host.connected) { this.hosts.delete(key); await host.close(); }
      }
      for (const [suppressedKey, primaryKey] of this.suppressedStandaloneKeys) {
        if (!present.has(suppressedKey) || !present.has(primaryKey) || !this.hosts.get(primaryKey)?.connected) {
          this.suppressedStandaloneKeys.delete(suppressedKey);
        }
      }
      for (const endpoint of endpoints) {
        if (generation !== this.generation || !this.enabled) return;
        const key = agentHostEndpointKey(endpoint);
        const primaryKey = this.suppressedStandaloneKeys.get(key);
        if (primaryKey && this.hosts.get(primaryKey)?.connected) continue;
        let host = this.hosts.get(key);
        if (!host) {
          const created = (this.options.createConnection ?? ((entry, options) => new AgentHostConnection(entry, options)))(endpoint, {
            onChange: (channel, action) => this.changed(created, channel, action),
            onCatalogChange: () => this.scheduleRefresh(),
            onClose: () => {
              if (this.hosts.get(key) === created) this.hosts.delete(key);
              for (const [suppressedKey, winnerKey] of this.suppressedStandaloneKeys) {
                if (winnerKey === key) this.suppressedStandaloneKeys.delete(suppressedKey);
              }
              for (const entry of this.entries.values()) if (entry.host === created) {
                entry.host = undefined;
                entry.session = { ...entry.session, connection: this.connection(), activityStatus: "idle" };
                this.clearInputs(entry.session.id);
              }
              this.reconcileSourceCatalog(created.endpoint.source);
              this.publishCatalog();
              if (!this.suppressedStandaloneKeys.has(key)) this.scheduleRefresh();
            },
          });
          host = created;
          this.hosts.set(key, host);
          try { await host.connect(); } catch { await host.close(); continue; }
          if (generation !== this.generation || !this.enabled) { await host.close(); return; }
        }
        try {
          if (!this.configuredHosts.has(host)) {
            this.configuredHosts.add(host);
            if (host.root?.config?.schema?.properties?.showExternalSessions && host.root.config.values?.showExternalSessions !== "none") {
              await host.dispatch(ROOT, { type: "root/configChanged", config: { showExternalSessions: "none" } }).catch(() => undefined);
            }
          }
          await host.request("ping", { channel: ROOT });
          const seen = new Set<string>(), cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = await host.request("listSessions", { channel: ROOT, limit: 100, ...(cursor ? { cursor } : {}) });
            const items = [...page.items];
            const concurrency = Math.min(8, items.length);
            let nextIndex = 0;
            await Promise.all(Array.from({ length: concurrency }, async () => {
              while (nextIndex < items.length && generation === this.generation && this.enabled) {
                const summary = items[nextIndex++];
                try {
                  await host.subscribe(summary.resource);
                  const session = host.sessions.get(summary.resource);
                  if (session && !isExternalCliSession(session)) {
                    seen.add(summary.resource);
                    this.createdSessions.delete(summary.resource);
                    this.catalogSession(host, summary.resource, session);
                  }
                } catch { /* One inaccessible session must not disconnect other providers. */ }
              }
            }));
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor)) throw new Error("Repeated catalogue cursor.");
            if (cursor) cursors.add(cursor);
          } while (cursor && generation === this.generation);
          for (const [id, entry] of this.entries) {
            if (entry.host === host && !seen.has(entry.sessionUri)) {
              const session = host.sessions.get(entry.sessionUri);
              if (session && isExternalCliSession(session)) {
                this.clearInputs(id);
                this.entries.delete(id);
                continue;
              }
              if (this.createdSessions.has(entry.sessionUri) && host.connected && session) {
                seen.add(entry.sessionUri);
                this.catalogSession(host, entry.sessionUri, session);
                continue;
              }
              entry.host = undefined;
              entry.session = { ...entry.session, connection: this.connection(), activityStatus: "idle" };
              this.clearInputs(entry.session.id);
              this.reconcileSourceCatalog(host.endpoint.source);
            }
          }
          for (const entry of this.entries.values()) {
            if (entry.host === host && entry.attached) {
              try { await host.subscribe(entry.chatUri); }
              catch {
                entry.host = undefined;
                entry.session = { ...entry.session, connection: this.connection(), activityStatus: "idle" };
                this.clearInputs(entry.session.id);
              }
            }
          }
        } catch { await host.close(); }
      }
      if (generation === this.generation && this.enabled) {
        await this.pruneRedundantStandaloneHosts(endpoints);
        const sources = new Set([...this.hosts.values()].filter(h => h.connected).map(h => h.endpoint.source));
        for (const source of sources) {
          this.reconcileSourceCatalog(source);
          await this.reconcileOmittedEntriesForSource(source);
        }
        this.initialRefreshDone = true;
      }
    })().finally(() => {
      this.refresh = undefined;
      this.publishCatalog();
      this.scheduleRefresh(this.options.pollMs ?? 5000);
    });
    return this.refresh;
  }
  private scheduleRefresh(delay = 200) {
    if (!this.running || !this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.refreshHosts().catch(() => this.scheduleRefresh(5000)); }, delay);
    this.timer.unref?.();
  }
  private catalogSession(host: AgentHostConnection, uri: string, session: SessionState) {
    if (isExternalCliSession(session)) {
      for (const [id, entry] of this.entries) {
        if (entry.host === host && entry.sessionUri === uri) {
          this.clearInputs(id);
          this.entries.delete(id);
        }
      }
      return;
    }
    const chats = session.chats ?? [];
    const admitted = new Set<string>();
    for (const chat of chats) {
      const provider = host.chats.get(chat.resource)?.provider ?? chat.provider ?? session.provider;
      if (!providerEngine(provider) || !host.root?.agents.some(agent => agent.provider === provider) || chat.interactivity === "hidden") continue;
      const id = nativeChatId(host.endpoint.source, chat.resource);
      const old = this.entries.get(id);
      const resolution = this.resolveOwnerHost(host.endpoint.source, chat.resource);
      const competing = resolution.competing;
      const winningHost = competing ? undefined : (resolution.owner ?? host);
      if (!competing && winningHost && winningHost !== host) {
        admitted.add(chat.resource);
        if (old?.host !== winningHost && resolution.session && resolution.sessionUri) {
          this.catalogSession(winningHost, resolution.sessionUri, resolution.session);
        }
        continue;
      }
      // A native chat changing harness must not silently reuse a saved engine binding.
      if (old && old.provider !== provider) {
        old.host = undefined;
        old.session = { ...old.session, connection: this.connection(), activityStatus: "idle" };
        this.clearInputs(id);
        continue;
      }
      const entry: Entry = old ?? { provider, source: host.endpoint.source, sessionUri: uri, chatUri: chat.resource,
        session: {} as UnifiedSession, attached: false, messages: new Map(), turns: new Map() };
      entry.host = competing ? undefined : winningHost;
      entry.sessionUri = uri;
      const fullChat = host.chats.get(chat.resource);
      if (fullChat && (fullChat.turns.length > 0 || Boolean(fullChat.activeTurn))) {
        entry.emptySeededDraft = false;
      }
      entry.session = this.describe(entry, session, fullChat ?? chat);
      if (competing) this.clearInputs(id);
      this.entries.set(id, entry);
      admitted.add(chat.resource);
    }
    for (const entry of this.entries.values()) {
      if (entry.host === host && entry.sessionUri === uri && !admitted.has(entry.chatUri)) {
        entry.host = undefined;
        entry.session = { ...entry.session, connection: this.connection(), activityStatus: "idle" };
        this.clearInputs(entry.session.id);
      }
    }
  }
  private describe(entry: Entry, session: SessionState, chat: ChatSummary | ChatState): UnifiedSession {
    const id = nativeChatId(entry.source, entry.chatUri);
    let directory = "";
    try { directory = fileURLToPath((chat.workingDirectories ?? session.workingDirectories ?? [])[0]).replaceAll("\\", "/"); } catch { /* An empty workspace is valid. */ }
    const model = "draft" in chat ? chat.draft?.model : undefined;
    const values = { ...session.config?.values, ...("config" in chat ? chat.config?.values : {}) };
    const mode = typeof values.mode === "string" ? values.mode : undefined;
    const updated = Date.parse(chat.modifiedAt) || entry.session.time?.updated || Date.now();
    const last = "turns" in chat ? chat.activeTurn?.message.model ?? chat.turns.at(-1)?.message.model : undefined;
    const activeConfig = (model ?? last)?.config;
    const effort = activeConfig?.thinkingLevel ?? activeConfig?.reasoningEffort ?? activeConfig?.tier;
    const rawContextSize = activeConfig?.contextSize;
    const modeSchema = ("config" in chat ? chat.config?.schema : undefined)?.properties?.mode ?? session.config?.schema?.properties?.mode;
    const models = entry.host ? this.hostModels(entry.host, entry.provider) : entry.session.connection?.models ?? [];
    const modes = modeSchema?.enum?.filter((value): value is string => typeof value === "string")
      .map(id => ({ id, label: id })) ?? [];
    const resolvedModelId = (model ?? last)?.id ?? entry.session.modelId;
    const selectedModel = entry.host?.root?.agents.find(agent => agent.provider === entry.provider)?.models
      .find(candidate => candidate.id === resolvedModelId);
    const modelEfforts = resolvedModelId
      ? models.find(candidate => candidate.modelId === resolvedModelId)?.capabilities?.supportedReasoningEfforts
      : undefined;
    const approval = resolveApprovalProperty(session, chat, entry.host?.root);
    return { id, engineType: providerEngine(entry.provider)!, title: chat.resource === session.defaultChat ? session.title : chat.title,
      directory, projectId: scopedId(entry.source, directory), time: { created: entry.session.time?.created ?? updated, updated },
      connection: { ...this.connection(entry.host, (chat.interactivity === undefined || chat.interactivity === "full")
        && !(chat.status & SESSION_FLAGS.archived)), canRename: chat.resource === session.defaultChat,
        models, modes,
        capabilities: { ...this.getCapabilities(), availableModes: modes,
          dynamicModes: !!(modeSchema?.chatMutable || modeSchema?.sessionMutable),
          modelSwitchable: models.length > 0, imageAttachment: selectedModel?.supportsVision === true,
          allowAllPermissionsSupported: approval?.supported === true,
          reasoningEffortOptions: modelEfforts?.length ? modelEfforts : ["none", "low", "medium", "high", "xhigh", "max"],
        },
      },
      activityStatus: activity(chat.status), mode, modelId: resolvedModelId,
      reasoningEffort: unifiedEffort(effort),
      contextWindow: rawContextSize !== undefined && rawContextSize !== null ? String(rawContextSize) : undefined,
      ...(approval ? { allowAllPermissions: approval.active } : {}),
      engineMeta: { ahpSource: entry.source, ahpSession: entry.sessionUri, ahpChat: entry.chatUri, ahpProvider: entry.provider },
    };
  }
  private changed(host: AgentHostConnection, channel: string, envelope?: ActionEnvelope) {
    if (channel === ROOT) {
      for (const [uri, session] of host.sessions) this.catalogSession(host, uri, session);
      this.publishCatalog();
    }
    const action = envelope?.action;
    const queueId = action?.type === "chat/turnStarted" ? action.queuedMessageId
      : action?.type === "chat/pendingMessageRemoved" ? action.id : undefined;
    const queued = queueId ? this.queued.get(queueId) : undefined;
    if (queueId && queued && this.entries.get(queued.sessionId)?.host === host) {
      this.queued.delete(queueId);
      if (queued.announced) this.emit("message.queued.consumed", { sessionId: queued.sessionId,
        messageId: scopedId(queued.sessionId, queueId), clientMessageId: queued.clientMessageId });
    }
    const session = host.sessions.get(channel);
    if (session) { this.catalogSession(host, channel, session); this.publishCatalog(); }
    for (const entry of this.entries.values()) {
      if (
        entry.host === host
        && (
          entry.chatUri === channel
          || (entry.attached && (entry.sessionUri === channel || entry.changesetUri === channel))
        )
      ) {
        this.dirty.add(entry.session.id);
      }
    }
    if (this.dirty.size && !this.publishing) this.publishing = setTimeout(() => {
      this.publishing = undefined;
      for (const id of this.dirty) { const entry = this.entries.get(id); if (entry) this.publishChat(entry); }
      this.dirty.clear();
    }, 30);
  }
  private async ensureChangesetSubscription(entry: Entry, host: AgentHostConnection): Promise<void> {
    const session = host.sessions.get(entry.sessionUri);
    const chat = host.chats.get(entry.chatUri);
    const uri = resolvePreferredChangesetUri(session, chat);
    if (!uri) return;
    entry.changesetUri = uri;
    if (!host.changesets.has(uri)) {
      await host.subscribe(uri);
    }
  }
  private publishWorkspace(entry: Entry) {
    if (!entry.attached || !entry.host?.connected) return;
    const host = entry.host;
    const session = host.sessions.get(entry.sessionUri);
    const chat = host.chats.get(entry.chatUri);
    void this.ensureChangesetSubscription(entry, host).catch(() => {});
    const changeset = entry.changesetUri ? host.changesets.get(entry.changesetUri) : undefined;
    const workspace = projectSessionWorkspace(
      entry.session.id,
      entry.session.directory,
      session,
      chat,
      changeset,
      entry.chatUri,
    );
    const digest = JSON.stringify(workspace);
    if (digest === entry.workspaceDigest) return;
    entry.workspaceDigest = digest;
    this.emit("session.workspace.updated", workspace);
  }
  private publishChat(entry: Entry) {
    const chat = entry.host?.chats.get(entry.chatUri), session = entry.host?.sessions.get(entry.sessionUri);
    if (!chat || !session || !entry.host?.connected) return;
    if ((chat.provider ?? session.chats?.find(summary => summary.resource === entry.chatUri)?.provider ?? session.provider) !== entry.provider
      || !entry.host.root?.agents.some(agent => agent.provider === entry.provider) || chat.interactivity === "hidden") {
      entry.host = undefined;
      entry.session = { ...entry.session, connection: this.connection(), activityStatus: "idle" };
      this.clearInputs(entry.session.id);
      this.publishCatalog();
      return;
    }
    entry.session = this.describe(entry, session, chat);
    this.emit("session.updated", { session: entry.session });
    const messages = projectChat(entry.session.id, chat, entry.session.directory, entry.session.engineType, entry.turns);
    const present = new Set(messages.map(message => message.id));
    for (const id of entry.messages.keys()) if (!present.has(id)) {
      entry.messages.delete(id);
      this.emit("message.removed", { sessionId: entry.session.id, messageId: id });
    }
    for (const message of messages) {
      if (entry.messages.get(message.id) === message) continue;
      entry.messages.set(message.id, message);
      this.emit("message.updated", { sessionId: entry.session.id, message });
    }
    const inputs = projectInputs(entry.session.id, chat, entry.session.engineType);
    for (const [id, route] of this.permissions) if (route.permission.sessionId === entry.session.id && !inputs.permissions.some(next => next.permission.id === id)) {
      this.permissions.delete(id);
      this.emit("permission.replied", { permissionId: id, optionId: "" });
    }
    for (const [id, route] of this.questions) if (route.question.sessionId === entry.session.id && !inputs.questions.some(next => next.question.id === id)) {
      this.questions.delete(id);
      this.emit("question.replied", { questionId: id, answers: [] });
    }
    for (const route of inputs.permissions) {
      const previous = this.permissions.get(route.permission.id);
      this.permissions.set(route.permission.id, route);
      if (JSON.stringify(previous?.permission) !== JSON.stringify(route.permission)) this.emit("permission.asked", { permission: route.permission });
    }
    for (const route of inputs.questions) {
      const previous = this.questions.get(route.question.id);
      this.questions.set(route.question.id, route);
      if (JSON.stringify(previous?.question) !== JSON.stringify(route.question)) this.emit("question.asked", { question: route.question });
    }
    this.publishWorkspace(entry);
  }
  private clearInputs(id: string) {
    for (const [key, queued] of this.queued) if (queued.sessionId === id) {
      this.queued.delete(key);
      if (queued.announced) this.emit("message.queued.consumed", { sessionId: id, messageId: scopedId(id, key), clientMessageId: queued.clientMessageId });
    }
    for (const [key, route] of this.permissions) if (route.permission.sessionId === id) {
      this.permissions.delete(key); this.emit("permission.replied", { permissionId: key, optionId: "" });
    }
    for (const [key, route] of this.questions) if (route.question.sessionId === id) {
      this.questions.delete(key); this.emit("question.replied", { questionId: key, answers: [] });
    }
  }
  private publishCatalog() {
    if (!this.initialized) return;
    const complete = !this.enabled || this.initialRefreshDone;
    for (const engine of supportedEngines) {
      const { projects, sessions } = this.catalogEntries(engine);
      const digest = JSON.stringify({ enabled: this.enabled, complete, projects, sessions });
      if (this.publishedCatalogDigests.get(engine) === digest) continue;
      this.publishedCatalogDigests.set(engine, digest);
      this.emit("catalog.updated", {
        sourceId: agentHostCatalogId(engine),
        engineType: engine,
        revision: String(++this.revision),
        complete,
        projects,
        sessions,
      });
    }
  }
  private catalogEntries(engineType: EngineType): Pick<EngineCatalogSnapshot, "projects" | "sessions"> {
    const sessions = [...this.entries.values()].filter(entry => entry.session.engineType === engineType).map(entry => ({
      ...entry.session, ...(!this.enabled || !entry.host?.connected ? { connection: { ...entry.session.connection, ...this.connection() }, activityStatus: "idle" as const } : {}),
    }));
    const projects = [...new Map(sessions.map(session => [session.projectId!, {
      id: session.projectId!, directory: session.directory, roots: session.directory ? [session.directory] : [],
      name: session.directory ? `${basename(session.directory)} (VS Code)` : "VS Code",
    }])).values()];
    return { projects, sessions };
  }
  private catalog(engineType: EngineType): EngineCatalogSnapshot {
    const { projects, sessions } = this.catalogEntries(engineType);
    const complete = !this.enabled || this.initialRefreshDone;
    return { sourceId: agentHostCatalogId(engineType), engineType, revision: String(++this.revision), complete, projects, sessions };
  }
  async getCatalog(engineType: EngineType) { this.seed(); return this.catalog(engineType); }
  async listSessions(engineType: EngineType, directory?: string) { return this.catalog(engineType).sessions.filter(session => !directory || session.directory === directory.replaceAll("\\", "/")); }
  sessionEngine(id: string) { return this.entries.get(id)?.session.engineType; }
  hasSession(id: string) { const entry = this.entries.get(id); return this.enabled && entry?.host?.connected === true && entry.attached; }
  assertSessionCompatible(id: string, meta?: Record<string, unknown>) {
    if (!id.startsWith("ahp:v1:")) throw new Error("Unknown VS Code session identity.");
    if (meta?.ahpSource && meta.ahpChat && id !== nativeChatId(String(meta.ahpSource), String(meta.ahpChat))) throw new Error("VS Code session source does not match.");
  }
  private async attach(id: string, writable = false) {
    let entry = this.entries.get(id);
    if (entry && (!entry.host?.connected) && this.enabled && entry.emptySeededDraft && entry.messages.size === 0) {
      const candidates = [...this.hosts.values()].filter(h => h.connected && h.endpoint.source === entry!.source);
      const probeHost = this.selectHostForSession(candidates, entry.provider, entry.session.directory) ?? candidates[0];
      if (probeHost) {
        const resurrected = await this.resurrectDeletedEmptyDraft(entry, probeHost).catch(() => undefined);
        if (resurrected) {
          this.publishCatalog();
          entry = resurrected;
        }
      }
    }
    if (!entry || !this.enabled || !entry.host?.connected || (writable && !entry.session.connection?.available))
      throw new Error("The original VS Code session is unavailable. Reopen VS Code and enable sharing to continue.");
    const host = entry.host;
    await host.subscribe(entry.sessionUri);
    await host.subscribe(entry.chatUri);
    if (entry.host !== host || !host.connected) throw new Error("The original VS Code executor changed. Refresh before continuing.");
    entry.attached = true;
    this.publishChat(entry);
    if (entry.host !== host) throw new Error("The original VS Code provider is unavailable.");
    if (writable && entry.session.connection?.readOnly) throw new Error("This VS Code chat is read-only.");
    return { entry, host, chat: host.chats.get(entry.chatUri)! };
  }
  private selectHostForSession(
    hosts: AgentHostConnection[],
    provider: string,
    directory?: string,
  ): AgentHostConnection | undefined {
    const eligible = hosts.filter(candidate => candidate.root?.agents.some(agent => agent.provider === provider));
    if (eligible.length <= 1) return eligible[0];
    const normalizedDir = directory
      ? resolvePath(directory).replaceAll("\\", "/").replace(/\/+$/, "")
      : undefined;
    const normCmp = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    const targetKey = normalizedDir ? normCmp(normalizedDir) : undefined;

    const scoreHost = (candidate: AgentHostConnection): number => {
      let matchesDirectory = false;
      let sessionCount = 0;
      for (const entry of this.entries.values()) {
        if (entry.host !== candidate) continue;
        sessionCount++;
        if (targetKey && entry.session.directory) {
          const entryKey = normCmp(entry.session.directory.replaceAll("\\", "/").replace(/\/+$/, ""));
          if (entryKey === targetKey || entryKey.startsWith(`${targetKey}.worktrees/`)) {
            matchesDirectory = true;
          }
        }
      }
      return (matchesDirectory ? 1_000_000 : 0)
        + (candidate.endpoint.type === "standalone" ? 1_000 : 0)
        + sessionCount;
    };

    return [...eligible].sort((a, b) => scoreHost(b) - scoreHost(a))[0];
  }

  private async resolveInitialSessionConfig(
    host: AgentHostConnection,
    provider: string,
    workingDirectory: string | undefined,
    useWorktree: boolean,
  ): Promise<Record<string, unknown>> {
    const desiredIsolation = useWorktree ? "worktree" : "folder";
    try {
      const resolved = await host.request("resolveSessionConfig", {
        channel: ROOT,
        provider,
        ...(workingDirectory ? { workingDirectory } : {}),
        config: { isolation: desiredIsolation },
      });
      const props = resolved?.schema?.properties;
      const values = resolved?.values ?? {};
      if (props?.target && !props?.isolation) {
        const targetOptions = Array.isArray(props.target.enum) ? props.target.enum : [];
        const canWorktree = useWorktree && targetOptions.includes("worktree");
        const next: Record<string, unknown> = { target: canWorktree ? "worktree" : "workspace" };
        if (canWorktree && typeof values.baseBranch === "string" && values.baseBranch) {
          next.baseBranch = values.baseBranch;
        }
        return next;
      }
      const isolationOptions = Array.isArray(props?.isolation?.enum) ? props.isolation.enum : [];
      const canWorktree = useWorktree && (isolationOptions.length === 0
        ? values.isolation === "worktree"
        : isolationOptions.includes("worktree"));
      const next: Record<string, unknown> = { isolation: canWorktree ? "worktree" : "folder" };
      if (canWorktree && typeof values.branch === "string" && values.branch) {
        next.branch = values.branch;
      }
      return next;
    } catch {
      return { isolation: desiredIsolation };
    }
  }

  async createSession(
    engineType: EngineType | undefined,
    directory: string,
    options?: CreateSessionSourceOptions,
  ): Promise<UnifiedSession> {
    if (!this.enabled) throw new Error("VS Code session sharing is disabled.");
    this.seed();
    let hosts = [...this.hosts.values()].filter(candidate => candidate.connected);
    if (!hosts.length) {
      await this.refreshHosts();
      hosts = [...this.hosts.values()].filter(candidate => candidate.connected);
    }
    if (!hosts.length) throw new Error("VS Code is not connected. Open VS Code and enable sharing first.");

    const trimmedDir = directory?.trim();
    const resolvedDir = trimmedDir && trimmedDir !== "." ? resolvePath(trimmedDir) : undefined;
    const preferredProvider = engineType ? engineProvider(engineType) : undefined;
    let host: AgentHostConnection | undefined;
    let provider: string | undefined;
    if (preferredProvider) {
      host = this.selectHostForSession(hosts, preferredProvider, resolvedDir);
      if (host) provider = preferredProvider;
    }
    if (!host || !provider) {
      for (const candidateEngine of supportedEngines) {
        const candidateProvider = engineProvider(candidateEngine);
        if (!candidateProvider) continue;
        const matched = this.selectHostForSession(hosts, candidateProvider, resolvedDir);
        if (matched) {
          host = matched;
          provider = candidateProvider;
          break;
        }
      }
    }
    if (!host || !provider) throw new Error("No supported AI provider is available in VS Code.");

    const workingDirectories = resolvedDir
      ? [pathToFileURL(resolvedDir).href]
      : undefined;
    const useWorktree = typeof options?.useWorktree === "boolean"
      ? options.useWorktree
      : this.options.isWorktreeEnabled?.() === true;
    const config = await this.resolveInitialSessionConfig(host, provider, workingDirectories?.[0], useWorktree);
    const sessionUri = `ahp-session:/${randomUUID()}`;
    await host.request("createSession", {
      channel: sessionUri,
      provider,
      ...(workingDirectories ? { workingDirectories } : {}),
      config,
    });
    this.createdSessions.add(sessionUri);
    await host.subscribe(sessionUri);
    const session = host.sessions.get(sessionUri);
    const chatUri = session?.defaultChat ?? session?.chats?.[0]?.resource;
    if (!session || !chatUri) {
      this.createdSessions.delete(sessionUri);
      throw new Error("VS Code did not initialize a default chat for the new session.");
    }
    this.catalogSession(host, sessionUri, session);
    const id = nativeChatId(host.endpoint.source, chatUri);
    const entry = this.entries.get(id);
    if (!entry) {
      this.createdSessions.delete(sessionUri);
      throw new Error("The newly created VS Code chat could not be registered.");
    }
    await host.subscribe(chatUri);
    entry.attached = true;
    const createdSession = host.sessions.get(sessionUri);
    const createdChat = host.chats.get(chatUri);
    if (createdSession && createdChat) {
      const approval = resolveApprovalProperty(createdSession, createdChat, host.root);
      if (approval?.supported && !approval.active) {
        await this.dispatchConfigProperty(entry, host, createdSession, createdChat, approval.key, approval.prop, approval.onValue).catch(() => {});
      }
    }
    this.publishChat(entry);
    this.publishCatalog();
    return entry.session;
  }
  async restoreSession(id: string) { return (await this.attach(id)).entry.session; }
  async getSession(id: string) { return this.entries.get(id)?.session ?? null; }
  async deleteSession(id: string) {
    const entry = this.entries.get(id);
    if (entry) this.createdSessions.delete(entry.sessionUri);
    this.clearInputs(id);
    this.entries.delete(id);
  }
  async removeSession(id: string): Promise<"local"> { await this.deleteSession(id); return "local"; }
  async listMessages(id: string): Promise<UnifiedMessage[]> {
    const { entry, host } = await this.attach(id);
    const seen = new Set<string>();
    let cursor = host.chats.get(entry.chatUri)?.turnsNextCursor;
    while (cursor) {
      if (seen.has(cursor)) throw new Error("VS Code did not advance its history cursor.");
      seen.add(cursor);
      await host.request("fetchTurns", { channel: entry.chatUri, cursor });
      cursor = host.chats.get(entry.chatUri)?.turnsNextCursor;
    }
    this.publishChat(entry);
    return projectChat(id, host.chats.get(entry.chatUri)!, entry.session.directory, entry.session.engineType);
  }
  async getHistoricalMessages(id: string) { return this.listMessages(id); }
  async sendMessage(id: string, content: MessagePromptContent[], options?: SendMessageOptions) {
    const { entry, host, chat } = await this.attach(id, true);
    const activeId = entry.session.id;
    entry.emptySeededDraft = false;
    if (options?.mode && options.mode !== entry.session.mode) await this.setMode(activeId, options.mode);
    if (typeof options?.allowAllPermissions === "boolean" && options.allowAllPermissions !== entry.session.allowAllPermissions) {
      await this.setAllowAllPermissions(activeId, options.allowAllPermissions);
    }
    const modelId = options?.modelId ?? chat.draft?.model?.id ?? entry.session.modelId;
    const previous = chat.draft?.model ?? chat.activeTurn?.message.model ?? chat.turns.at(-1)?.message.model;
    const model = modelId ? this.model(host, entry.provider, modelId, options?.reasoningEffort, previous, options?.contextWindow) : undefined;
    const images = content.filter(part => part.type === "image");
    if (images.some(image => !image.data || !image.mimeType || !/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType))) throw new Error("Invalid image attachment.");
    if (images.length && !host.root?.agents.find(agent => agent.provider === entry.provider)?.models
      .some(candidate => candidate.id === modelId && candidate.supportsVision === true)) throw new Error("This VS Code model does not advertise image support.");
    const message: Wire<Message> = { text: content.filter(part => part.type === "text").map(part => part.text).join("\n"),
      origin: { kind: "user" }, ...(model ? { model } : {}),
      attachments: images.map((image, index) => ({
        type: "embeddedResource", data: image.data!, contentType: image.mimeType!, label: `image-${index + 1}`,
      })),
    };
    const turnId = randomUUID();
    if (host.chats.get(entry.chatUri)?.activeTurn) {
      this.queued.set(turnId, { sessionId: activeId, clientMessageId: options?.clientMessageId, announced: false });
      try { await host.dispatch(entry.chatUri, { type: "chat/pendingMessageSet", kind: "queued", id: turnId, message }); }
      catch (error) { this.queued.delete(turnId); throw error; }
      const queued = this.queued.get(turnId);
      if (queued) {
        queued.announced = true;
        this.emit("message.queued", { sessionId: activeId, messageId: scopedId(activeId, turnId), queuePosition: host.chats.get(entry.chatUri)?.queuedMessages?.length ?? 1, clientMessageId: options?.clientMessageId });
      }
    } else await host.dispatch(entry.chatUri, { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message });
    this.publishChat(entry);
    return projectChat(activeId, host.chats.get(entry.chatUri)!, entry.session.directory, entry.session.engineType).find(message => message.id === scopedId(activeId, turnId, "assistant"))
      ?? { id: scopedId(activeId, turnId), sessionId: activeId, role: "user" as const, parts: [], time: { created: Date.now() } };
  }
  async cancelMessage(id: string) {
    const { entry, host, chat } = await this.attach(id, true);
    if (chat.activeTurn) await host.dispatch(entry.chatUri, { type: "chat/turnCancelled",
      turnId: chat.activeTurn.id, duration: Math.max(0, Date.now() - Date.parse(chat.activeTurn.startedAt)) });
  }
  async renameSession(id: string, title: string) {
    const { entry, host } = await this.attach(id, true);
    if (host.sessions.get(entry.sessionUri)?.defaultChat !== entry.chatUri) throw new Error("Rename side chats in VS Code.");
    await host.dispatch(entry.sessionUri, { type: "session/titleChanged", title });
    this.catalogSession(host, entry.sessionUri, host.sessions.get(entry.sessionUri)!);
  }
  private hostModels(host: AgentHostConnection, provider: string): UnifiedModelInfo[] {
    return (host.root?.agents.find(agent => agent.provider === provider)?.models ?? []).filter(model => model.provider === provider).map(model => {
      const props = model.configSchema?.properties;
      const effortKey = props?.thinkingLevel ? "thinkingLevel" : props?.reasoningEffort ? "reasoningEffort" : props?.tier ? "tier" : undefined;
      const property = effortKey ? props?.[effortKey] : undefined;
      const rawEnum = property?.enum ?? [];
      const rawLabels = (property as { enumLabels?: string[] } | undefined)?.enumLabels;
      const efforts: ReasoningEffort[] = [];
      const reasoningEffortLabels: Partial<Record<ReasoningEffort, string>> = {};
      rawEnum.forEach((rawVal, idx) => {
        const mapped = unifiedEffort(rawVal);
        if (!mapped || efforts.includes(mapped)) return;
        efforts.push(mapped);
        if (effortKey === "tier" && rawLabels?.[idx]) {
          reasoningEffortLabels[mapped] = rawLabels[idx];
        }
      });

      const contextProp = props?.contextSize;
      const contextEnum = Array.isArray(contextProp?.enum) ? contextProp.enum : undefined;
      const contextLabels = (contextProp as { enumLabels?: string[] } | undefined)?.enumLabels;
      const contextDescriptions = (contextProp as { enumDescriptions?: string[] } | undefined)?.enumDescriptions;
      const contextWindowOptions: ContextWindowOption[] | undefined = contextEnum && contextEnum.length > 1
        ? contextEnum.map((val, idx) => {
          const num = typeof val === "number" ? val : Number(val);
          const label = contextLabels?.[idx] || (Number.isFinite(num) ? formatContextWindowTokens(num) : String(val));
          const description = contextDescriptions?.[idx];
          return {
            id: String(val),
            label,
            ...(Number.isFinite(num) ? { tokens: num } : {}),
            ...(description ? { description } : {}),
          };
        })
        : undefined;
      const defaultContextWindow = contextWindowOptions
        ? (contextProp?.default !== undefined ? String(contextProp.default) : contextWindowOptions[0]?.id)
        : undefined;

      return {
        modelId: model.id,
        name: model.name,
        engineType: providerEngine(provider)!,
        capabilities: {
          attachment: model.supportsVision === true,
          reasoning: efforts.length > 0,
          supportedReasoningEfforts: efforts,
          defaultReasoningEffort: unifiedEffort(property?.default),
          ...(Object.keys(reasoningEffortLabels).length > 0 ? { reasoningEffortLabels } : {}),
          ...(contextWindowOptions ? { contextWindowOptions, defaultContextWindow } : {}),
        },
      };
    });
  }
  private model(
    host: AgentHostConnection,
    provider: string,
    id: string,
    effort?: ReasoningEffort | null,
    previous?: ModelSelection,
    contextWindow?: string | null,
  ): ModelSelection {
    const model = host.root?.agents.find(agent => agent.provider === provider)?.models?.find(model => model.id === id && model.provider === provider);
    if (!model) throw new Error("This model is not available in the connected VS Code Host.");
    const config = { ...(previous?.id === id ? previous.config : {}) };
    if (effort !== undefined) {
      delete config.thinkingLevel;
      delete config.reasoningEffort;
      delete config.tier;
      if (effort) {
        const props = model.configSchema?.properties;
        const key = props?.thinkingLevel ? "thinkingLevel" : props?.reasoningEffort ? "reasoningEffort" : props?.tier ? "tier" : "thinkingLevel";
        const property = props?.[key];
        const value = key === "tier" ? nativeTierEffort(effort) : effort;
        if (!property || (property.enum && !property.enum.includes(value))) throw new Error("This reasoning effort is not supported by the VS Code model.");
        config[key] = value;
      }
    }
    if (contextWindow !== undefined) {
      delete config.contextSize;
      if (contextWindow !== null) {
        const contextProp = model.configSchema?.properties?.contextSize;
        const coerced = contextProp?.type === "number" ? Number(contextWindow) : contextWindow;
        if (!contextProp || (contextProp.enum && !contextProp.enum.includes(coerced))) {
          throw new Error("This context window size is not supported by the VS Code model.");
        }
        config.contextSize = coerced;
      }
    }
    return { id, ...(Object.keys(config).length ? { config } : {}) };
  }
  async setModel(id: string, modelId: string) {
    const { entry, host, chat } = await this.attach(id, true);
    await host.dispatch(entry.chatUri, { type: "chat/draftChanged",
      draft: { ...chat.draft, text: chat.draft?.text ?? "", origin: { kind: "user" },
        model: this.model(host, entry.provider, modelId, undefined, chat.draft?.model) } });
    this.publishChat(entry);
  }
  private async dispatchConfigProperty(
    entry: Entry,
    host: AgentHostConnection,
    session: SessionState,
    chat: ChatState,
    key: string,
    property: SessionConfigPropertySchema,
    value: unknown,
  ) {
    const preferSessionConfig = (chat.resource === session.defaultChat || !chat.config) && Boolean(property.sessionMutable);
    if (preferSessionConfig) {
      await host.dispatch(entry.sessionUri, { type: "session/configChanged", config: { [key]: value } });
      if (chat.config?.values && Object.prototype.hasOwnProperty.call(chat.config.values, key) && property.chatMutable) {
        await host.dispatch(entry.chatUri, { type: "chat/configChanged", config: { [key]: value } });
      }
    } else if (chat.config && property.chatMutable) {
      await host.dispatch(entry.chatUri, { type: "chat/configChanged", config: { [key]: value } });
    } else if (property.sessionMutable) {
      await host.dispatch(entry.sessionUri, { type: "session/configChanged", config: { [key]: value } });
    } else {
      throw new Error("Change this setting in VS Code.");
    }
  }
  async setMode(id: string, mode: string) {
    const { entry, host, chat } = await this.attach(id, true);
    const session = host.sessions.get(entry.sessionUri)!;
    const property = chat.config?.schema?.properties?.mode ?? session.config?.schema?.properties?.mode;
    if (!property || !property.enum?.includes(mode)) throw new Error("This mode is not available in VS Code.");
    await this.dispatchConfigProperty(entry, host, session, chat, "mode", property, mode);
    this.publishChat(entry);
  }
  async setReasoningEffort(id: string, effort: ReasoningEffort | null) {
    const { entry, host, chat } = await this.attach(id, true);
    const modelId = chat.draft?.model?.id ?? entry.session.modelId;
    if (!modelId) { if (effort) throw new Error("Choose a model before changing reasoning effort."); return; }
    const model = this.model(host, entry.provider, modelId, effort, chat.draft?.model ?? chat.activeTurn?.message.model ?? chat.turns.at(-1)?.message.model);
    await host.dispatch(entry.chatUri, { type: "chat/draftChanged",
      draft: { ...chat.draft, text: chat.draft?.text ?? "", origin: { kind: "user" }, model } });
    this.publishChat(entry);
  }
  getReasoningEffort(id: string) { return this.entries.get(id)?.session.reasoningEffort ?? null; }
  async setContextWindow(id: string, contextWindow: string | null) {
    const { entry, host, chat } = await this.attach(id, true);
    const modelId = chat.draft?.model?.id ?? entry.session.modelId;
    if (!modelId) { if (contextWindow) throw new Error("Choose a model before changing context window."); return; }
    const model = this.model(host, entry.provider, modelId, undefined, chat.draft?.model ?? chat.activeTurn?.message.model ?? chat.turns.at(-1)?.message.model, contextWindow);
    await host.dispatch(entry.chatUri, { type: "chat/draftChanged",
      draft: { ...chat.draft, text: chat.draft?.text ?? "", origin: { kind: "user" }, model } });
    this.publishChat(entry);
  }
  getContextWindow(id: string) { return this.entries.get(id)?.session.contextWindow ?? null; }
  async setAllowAllPermissions(id: string, enabled: boolean | null) {
    const { entry, host, chat } = await this.attach(id, true);
    const session = host.sessions.get(entry.sessionUri)!;
    const approval = resolveApprovalProperty(session, chat, host.root);
    if (!approval || !approval.supported) {
      throw new Error("Allow all permissions is not available for this VS Code session.");
    }
    const nextValue = enabled ? approval.onValue : approval.offValue;
    await this.dispatchConfigProperty(entry, host, session, chat, approval.key, approval.prop, nextValue);
    if (enabled === true) {
      for (const pending of this.getPendingPermissions(id)) {
        const allowOpt = pending.options.find(opt => opt.type === "allow_once" || opt.type === "accept_once" || opt.type === "allow_always" || opt.type === "accept_always");
        if (allowOpt) await this.replyPermission(pending.id, { optionId: allowOpt.id }, id).catch(() => {});
      }
    }
    this.publishChat(entry);
    this.publishCatalog();
  }
  getAllowAllPermissions(id: string) { return this.entries.get(id)?.session.allowAllPermissions ?? null; }
  getPendingPermissions(id?: string) { return [...this.permissions.values()].filter(route => !id || route.permission.sessionId === id).map(route => route.permission); }
  getPendingQuestions(id?: string) { return [...this.questions.values()].filter(route => !id || route.question.sessionId === id).map(route => route.question); }
  async replyPermission(permissionId: string, reply: PermissionReply, sessionId?: string) {
    const pending = this.permissions.get(permissionId);
    if (!pending || (sessionId && pending.permission.sessionId !== sessionId)) throw new Error("This approval is no longer pending.");
    const { entry, host } = await this.attach(pending.permission.sessionId, true);
    const current = this.permissions.get(permissionId);
    const option = current?.permission.options.find(option => option.id === reply.optionId);
    if (!current || !option) throw new Error("This approval has changed. Refresh before replying.");
    const approved = option.type === "allow_once";
    if (current.tool.status === "pending-result-confirmation") await host.dispatch(entry.chatUri, {
      type: "chat/toolCallResultConfirmed", turnId: current.turnId, toolCallId: current.tool.toolCallId, approved,
    });
    else await host.dispatch(entry.chatUri, { type: "chat/toolCallConfirmed", turnId: current.turnId,
      toolCallId: current.tool.toolCallId, ...(current.tool.status === "pending-confirmation" && current.tool.options?.length ? { selectedOptionId: option.id } : {}),
      ...(approved ? { approved: true, confirmed: "user-action" } : { approved: false, reason: "denied" }) });
    this.publishChat(entry);
  }
  async replyQuestion(id: string, answers: string[][], sessionId?: string) {
    const pending = this.questions.get(id);
    if (!pending || (sessionId && pending.question.sessionId !== sessionId)) throw new Error("This question is no longer pending.");
    const { entry, host } = await this.attach(pending.question.sessionId, true);
    const current = this.questions.get(id);
    if (!current) throw new Error("This question has already been answered.");
    await host.dispatch(entry.chatUri, { type: "chat/inputCompleted", requestId: current.request.id,
      response: "accept", answers: inputAnswers(current.request, answers) });
    this.publishChat(entry);
  }
  async rejectQuestion(id: string, sessionId?: string) {
    const pending = this.questions.get(id);
    if (!pending || (sessionId && pending.question.sessionId !== sessionId)) throw new Error("This question is no longer pending.");
    const { entry, host } = await this.attach(pending.question.sessionId, true);
    if (!this.questions.has(id)) throw new Error("This question has already been answered.");
    await host.dispatch(entry.chatUri, { type: "chat/inputCompleted", requestId: pending.request.id, response: "decline" });
    this.publishChat(entry);
  }
  async getSessionWorkspace(id: string): Promise<UnifiedSessionWorkspaceState> {
    const { entry, host, chat } = await this.attach(id);
    await this.ensureChangesetSubscription(entry, host).catch(() => {});
    const session = host.sessions.get(entry.sessionUri);
    const changeset = entry.changesetUri ? host.changesets.get(entry.changesetUri) : undefined;
    const workspace = projectSessionWorkspace(
      id,
      entry.session.directory,
      session,
      chat,
      changeset,
      entry.chatUri,
    );
    entry.workspaceDigest = JSON.stringify(workspace);
    return workspace;
  }
  async previewSessionFile(id: string, fileId: string): Promise<UnifiedSessionFilePreview> {
    const { entry, host } = await this.attach(id);
    await this.ensureChangesetSubscription(entry, host).catch(() => {});
    const session = host.sessions.get(entry.sessionUri);
    const changeset = entry.changesetUri ? host.changesets.get(entry.changesetUri) : undefined;
    return readAgentHostFilePreview(host, entry.session.directory, session, changeset, fileId);
  }
  async stopBackgroundTask(id: string, taskId: string): Promise<{ stopped: boolean }> {
    const { entry, host } = await this.attach(id, true);
    const res = await host.requestExtension<{ stopped?: boolean }>("vscode/stopBackgroundWork", {
      chat: entry.chatUri,
      id: taskId,
    });
    return { stopped: res?.stopped === true };
  }
}
