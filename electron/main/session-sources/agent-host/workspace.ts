import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createTwoFilesPatch } from "diff";
import type {
  ChangesetFile,
  ChangesetState,
  ChatState,
  SessionState,
} from "@microsoft/agent-host-protocol";
import type {
  UnifiedBackgroundTask,
  UnifiedSessionChangesSummary,
  UnifiedSessionFileItem,
  UnifiedSessionFilePreview,
  UnifiedSessionWorkspaceState,
} from "../../../../src/types/unified";
import { AgentHostConnection, ROOT } from "./connection";
import { SESSION_FLAGS } from "./wire";
import {
  applySqlTodosMutation,
  extractStructuredTodos,
  isSqlTodosMutation,
  serializeTodoEntries,
  type NormalizedTodoItem,
  type StoredTodoEntry,
} from "../../../../shared/sql-todos";

const MAX_PREVIEW_CHARS = 512 * 1024;
const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

interface RawSessionArtifact {
  id: string;
  label: string;
  type: string;
  uri?: string;
  link?: string;
  isArtifact: boolean;
}

function parseSessionArtifacts(meta: Record<string, unknown> | undefined): RawSessionArtifact[] {
  const raw = meta?.["agentHost/sessionArtifacts"];
  if (!Array.isArray(raw)) return [];
  const artifacts: RawSessionArtifact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== "string" || typeof obj.label !== "string" || typeof obj.type !== "string") continue;
    const isArtifact = typeof obj.isArtifact === "boolean" ? obj.isArtifact : true;
    if (!isArtifact) continue;
    artifacts.push({
      id: obj.id,
      label: obj.label,
      type: obj.type,
      ...(typeof obj.uri === "string" && obj.uri ? { uri: obj.uri } : {}),
      ...(typeof obj.link === "string" && obj.link ? { link: obj.link } : {}),
      isArtifact,
    });
  }
  return artifacts.reverse();
}

export function uriToDisplayPath(uri: string, rootDir: string): { path: string; fullPath: string; label: string } {
  let fsPath = uri;
  try {
    if (uri.startsWith("file:")) {
      try {
        fsPath = fileURLToPath(uri);
      } catch {
        const parsed = new URL(uri);
        fsPath = decodeURIComponent(parsed.pathname || uri);
      }
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri)) {
      const parsed = new URL(uri);
      fsPath = decodeURIComponent(parsed.pathname || uri);
    }
  } catch {
    fsPath = uri;
  }
  const normalizedFull = fsPath.replaceAll("\\", "/");
  const normalizedRoot = rootDir.replaceAll("\\", "/").replace(/\/+$/, "");
  let relPath = normalizedFull;
  if (normalizedRoot) {
    const cmpFull = process.platform === "win32" ? normalizedFull.toLowerCase() : normalizedFull;
    const cmpRoot = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
    if (cmpFull.startsWith(`${cmpRoot}/`)) {
      relPath = normalizedFull.slice(normalizedRoot.length + 1);
    }
  }
  const cleanLabel = basename(relPath) || relPath;
  return { path: relPath, fullPath: normalizedFull, label: cleanLabel };
}

export function resolvePreferredChangesetUri(
  session: SessionState | undefined,
  chat: ChatState | undefined,
): string | undefined {
  const sessionStatic = (session?.changesets ?? []).filter((cs) => !cs.uriTemplate.includes("{"));
  const chatStatic = (chat?.changesets ?? []).filter((cs) => !cs.uriTemplate.includes("{"));

  const pick = (list: typeof sessionStatic, kind: string) =>
    list.find((cs) => cs.changeKind === kind)?.uriTemplate;

  return (
    pick(sessionStatic, "session")
    ?? pick(sessionStatic, "working-set")
    ?? pick(chatStatic, "uncommitted")
    ?? pick(chatStatic, "branch")
    ?? sessionStatic[0]?.uriTemplate
    ?? chatStatic[0]?.uriTemplate
  );
}

function classifyChangesetFile(file: ChangesetFile): UnifiedSessionFileItem["kind"] {
  const hasBefore = Boolean(file.edit?.before);
  const hasAfter = Boolean(file.edit?.after);
  if (!hasBefore && hasAfter) return "created";
  if (hasBefore && !hasAfter) return "deleted";
  if (hasBefore && hasAfter && file.edit.before!.uri !== file.edit.after!.uri) return "renamed";
  return "modified";
}

export function projectSessionWorkspace(
  sessionId: string,
  directory: string,
  session: SessionState | undefined,
  chat: ChatState | undefined,
  changeset: ChangesetState | undefined,
  chatUri: string,
): UnifiedSessionWorkspaceState {
  const effectiveDir = directory
    || ((chat?.workingDirectories ?? session?.workingDirectories)?.[0]
      ? uriToDisplayPath((chat?.workingDirectories ?? session?.workingDirectories)![0], "").fullPath
      : "");
  const backgroundTasks: UnifiedBackgroundTask[] = [];
  const seenSubagentChats = new Set<string>();

  for (const work of chat?.backgroundWork ?? []) {
    const meta = work._meta as Record<string, unknown> | undefined;
    const stoppable = meta?.["vscode.stopBackgroundWork"] === true;
    if (work.kind === "shell") {
      const shellId = typeof meta?.["vscode.copilot.shellId"] === "string"
        ? meta["vscode.copilot.shellId"]
        : undefined;
      const detached = meta?.["vscode.copilot.shellAttachment"] === "detached";
      const firstLine = work.command?.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
      const label = work.label?.trim() || firstLine || shellId || work.id;
      backgroundTasks.push({
        id: work.id,
        kind: "shell",
        label,
        ...(work.command?.trim() ? { command: work.command.trim() } : {}),
        ...(work.startedAt ? { startedAt: work.startedAt } : {}),
        status: "running",
        ...(detached ? { detached: true } : {}),
        ...(stoppable ? { stoppable: true } : {}),
      });
    } else {
      if ("chat" in work && typeof work.chat === "string") {
        seenSubagentChats.add(work.chat);
      }
      backgroundTasks.push({
        id: work.id,
        kind: "subagent",
        label: work.label?.trim() || work.id,
        ...(work.startedAt ? { startedAt: work.startedAt } : {}),
        status: "running",
        ...(stoppable ? { stoppable: true } : {}),
      });
    }
  }

  for (const sub of session?.chats ?? []) {
    if (sub.origin?.kind !== "tool" || sub.origin.chat !== chatUri || sub.interactivity === "hidden") continue;
    if (seenSubagentChats.has(sub.resource)) continue;
    const isRunning = (sub.status & SESSION_FLAGS.active) !== 0;
    backgroundTasks.push({
      id: sub.resource,
      kind: "subagent",
      label: sub.title?.trim() || "Subagent",
      ...(sub.modifiedAt ? { startedAt: sub.modifiedAt } : {}),
      status: isRunning ? "running" : "completed",
    });
  }

  const files: UnifiedSessionFileItem[] = [];
  const seenFullPaths = new Set<string>();
  const changesetFiles = Array.isArray(changeset?.files) ? changeset.files : [];

  for (const file of changesetFiles) {
    const targetUri = file.edit?.after?.uri ?? file.edit?.before?.uri ?? file.id;
    const { path, fullPath, label } = uriToDisplayPath(targetUri, effectiveDir);
    const normKey = process.platform === "win32" ? fullPath.toLowerCase() : fullPath;
    seenFullPaths.add(normKey);
    const previewable = Boolean(
      file.edit?.after?.content?.uri
      || file.edit?.before?.content?.uri
      || file.edit?.after?.uri
      || file.edit?.before?.uri,
    );
    files.push({
      id: file.id,
      path,
      label,
      kind: classifyChangesetFile(file),
      ...(file.edit?.diff?.added !== undefined ? { additions: file.edit.diff.added } : {}),
      ...(file.edit?.diff?.removed !== undefined ? { deletions: file.edit.diff.removed } : {}),
      previewable,
    });
  }

  for (const art of parseSessionArtifacts(session?._meta as Record<string, unknown> | undefined)) {
    const rawTarget = art.uri ?? art.link ?? art.label;
    const display = art.uri ? uriToDisplayPath(art.uri, effectiveDir) : { path: art.label, fullPath: rawTarget, label: art.label };
    const normKey = process.platform === "win32" ? display.fullPath.toLowerCase() : display.fullPath;
    if (art.uri && seenFullPaths.has(normKey)) continue;
    files.push({
      id: `artifact:${art.id}`,
      path: display.path,
      label: art.label || display.label,
      kind: "artifact",
      artifactType: art.type,
      ...(art.link ? { externalUrl: art.link } : {}),
      previewable: Boolean(art.uri),
    });
  }

  let changesSummary: UnifiedSessionChangesSummary | undefined;
  if (changesetFiles.length > 0) {
    let additions = 0;
    let deletions = 0;
    for (const file of changesetFiles) {
      additions += file.edit?.diff?.added ?? 0;
      deletions += file.edit?.diff?.removed ?? 0;
    }
    changesSummary = {
      files: changesetFiles.length,
      additions,
      deletions,
    };
  } else if (chat?.changes && (chat.changes.files ?? 0) > 0) {
    changesSummary = {
      files: chat.changes.files ?? 0,
      additions: chat.changes.additions ?? 0,
      deletions: chat.changes.deletions ?? 0,
    };
  }

  const loadingFiles = changeset?.status === "computing"
    || (Boolean(chat?.changes && (chat.changes.files ?? 0) > 0) && !changeset);

  const todos = extractLatestChatTodos(chat);

  return {
    sessionId,
    backgroundTasks,
    ...(changesSummary ? { changesSummary } : {}),
    files,
    ...(loadingFiles ? { loadingFiles: true } : {}),
    ...(todos.length > 0 ? { todos } : {}),
  };
}

function parseRawToolInput(rawInput: unknown): unknown {
  if (!rawInput) return undefined;
  if (typeof rawInput !== "string") {
    return typeof rawInput === "object" && "uri" in (rawInput as Record<string, unknown>)
      ? { uri: (rawInput as Record<string, unknown>).uri }
      : rawInput;
  }
  try {
    return JSON.parse(rawInput);
  } catch {
    return { raw: rawInput };
  }
}

function extractLatestChatTodos(chat: ChatState | undefined): NormalizedTodoItem[] {
  if (!chat) return [];
  const turns = [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])];
  const sqlTodos = new Map<string, StoredTodoEntry>();
  let latestTodos: NormalizedTodoItem[] = [];
  for (const turn of turns) {
    for (const part of turn.responseParts) {
      if (part.kind !== "toolCall") continue;
      const tool = part.toolCall;
      if (tool.status !== "completed" && tool.status !== "running") continue;
      const rawToolInput = "toolInput" in tool ? parseRawToolInput(tool.toolInput) : undefined;
      const sqlQuery = rawToolInput && typeof rawToolInput === "object"
        ? (rawToolInput as Record<string, unknown>).query
        : undefined;
      if ((tool.toolName === "sql" || tool.toolName.endsWith("/sql") || tool.toolName.endsWith("_sql"))
        && typeof sqlQuery === "string" && isSqlTodosMutation(sqlQuery)) {
        applySqlTodosMutation(sqlTodos, sqlQuery);
        latestTodos = serializeTodoEntries(sqlTodos);
      } else if (tool.toolName === "todo" || tool.toolName === "manage_todo_list" || tool.toolName === "TodoWrite") {
        const structured = extractStructuredTodos(rawToolInput);
        if (structured) {
          latestTodos = structured;
        }
      }
    }
  }
  return latestTodos;
}

interface DecodedResource {
  kind: "text" | "image" | "binary";
  text?: string;
  imageBase64?: string;
  mimeType?: string;
  truncated?: boolean;
}

function guessImageMime(uriOrPath: string, contentType?: string): string | undefined {
  if (contentType && /^image\/(png|jpeg|gif|webp|svg\+xml)$/i.test(contentType)) {
    return contentType.toLowerCase();
  }
  const clean = uriOrPath.split("?")[0].split("#")[0];
  const ext = clean.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXT_MIME[ext];
}

async function readResourceDecoded(
  host: AgentHostConnection,
  uri: string,
  hintPath: string,
): Promise<DecodedResource> {
  const res = await host.request("resourceRead", { channel: ROOT, uri });
  const imageMime = guessImageMime(hintPath, res.contentType);
  if (imageMime) {
    const base64 = res.encoding === "base64"
      ? res.data
      : Buffer.from(res.data, "utf8").toString("base64");
    return { kind: "image", imageBase64: base64, mimeType: imageMime };
  }

  if (res.encoding === "base64") {
    const buf = Buffer.from(res.data, "base64");
    const checkLen = Math.min(buf.length, 8192);
    for (let i = 0; i < checkLen; i++) {
      if (buf[i] === 0) {
        return { kind: "binary", mimeType: res.contentType };
      }
    }
    const fullText = buf.toString("utf8");
    const truncated = fullText.length > MAX_PREVIEW_CHARS;
    return {
      kind: "text",
      text: truncated ? fullText.slice(0, MAX_PREVIEW_CHARS) : fullText,
      mimeType: res.contentType,
      truncated,
    };
  }

  const truncated = res.data.length > MAX_PREVIEW_CHARS;
  return {
    kind: "text",
    text: truncated ? res.data.slice(0, MAX_PREVIEW_CHARS) : res.data,
    mimeType: res.contentType,
    truncated,
  };
}

export async function readAgentHostFilePreview(
  host: AgentHostConnection,
  directory: string,
  session: SessionState | undefined,
  changeset: ChangesetState | undefined,
  fileId: string,
): Promise<UnifiedSessionFilePreview> {
  const effectiveDir = directory
    || (session?.workingDirectories?.[0]
      ? uriToDisplayPath(session.workingDirectories[0], "").fullPath
      : "");
  if (fileId.startsWith("artifact:")) {
    const rawId = fileId.slice("artifact:".length);
    const art = parseSessionArtifacts(session?._meta as Record<string, unknown> | undefined)
      .find((candidate) => candidate.id === rawId);
    if (!art) throw new Error("Artifact not found in session.");
    const display = art.uri
      ? uriToDisplayPath(art.uri, effectiveDir)
      : { path: art.label, label: art.label };
    if (!art.uri) {
      return {
        id: fileId,
        path: display.path,
        label: art.label || display.label,
        kind: "artifact",
        ...(art.link ? { externalUrl: art.link } : {}),
      };
    }
    const decoded = await readResourceDecoded(host, art.uri, display.path);
    return {
      id: fileId,
      path: display.path,
      label: art.label || display.label,
      kind: "artifact",
      ...(decoded.kind === "text" ? { content: decoded.text, truncated: decoded.truncated } : {}),
      ...(decoded.kind === "image" ? { imageBase64: decoded.imageBase64, mimeType: decoded.mimeType } : {}),
      ...(decoded.kind === "binary" ? { binary: true, mimeType: decoded.mimeType } : {}),
      ...(art.link ? { externalUrl: art.link } : {}),
    };
  }

  const file = changeset?.files.find((candidate) => candidate.id === fileId);
  if (!file) throw new Error("File not found in session changes.");

  const targetUri = file.edit?.after?.uri ?? file.edit?.before?.uri ?? file.id;
  const { path, label } = uriToDisplayPath(targetUri, effectiveDir);
  const kind = classifyChangesetFile(file);

  const beforeUri = file.edit?.before?.content?.uri;
  const afterUri = file.edit?.after?.content?.uri ?? file.edit?.after?.uri;

  const [beforeRes, afterRes] = await Promise.all([
    beforeUri ? readResourceDecoded(host, beforeUri, path).catch(() => undefined) : Promise.resolve(undefined),
    afterUri ? readResourceDecoded(host, afterUri, path).catch(() => undefined) : Promise.resolve(undefined),
  ]);

  const primary = afterRes ?? beforeRes;
  if (!primary) {
    throw new Error("Unable to read file content from VS Code Agent Host.");
  }

  if (primary.kind === "image") {
    return {
      id: file.id,
      path,
      label,
      kind,
      imageBase64: primary.imageBase64,
      mimeType: primary.mimeType,
    };
  }

  if (primary.kind === "binary") {
    return {
      id: file.id,
      path,
      label,
      kind,
      binary: true,
      mimeType: primary.mimeType,
    };
  }

  const beforeText = beforeRes?.kind === "text" ? (beforeRes.text ?? "") : "";
  const afterText = afterRes?.kind === "text" ? (afterRes.text ?? "") : "";
  const hasBeforeSide = Boolean(file.edit?.before);
  const hasAfterSide = Boolean(file.edit?.after);

  let diff: string | undefined;
  if (beforeText !== afterText || (hasBeforeSide !== hasAfterSide)) {
    diff = createTwoFilesPatch(
      hasBeforeSide ? `a/${path}` : "/dev/null",
      hasAfterSide ? `b/${path}` : "/dev/null",
      hasBeforeSide ? beforeText : "",
      hasAfterSide ? afterText : "",
      "",
      "",
      { context: 3 },
    );
  }

  return {
    id: file.id,
    path,
    label,
    kind,
    ...(diff ? { diff } : {}),
    content: kind === "deleted" ? beforeText : afterText,
    ...(beforeRes?.truncated || afterRes?.truncated ? { truncated: true } : {}),
  };
}
