import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { FileIcon } from "./FileIcon";
import { IconQueueList } from "./icons";
import { Spinner } from "./Spinner";
import { SessionFilePreviewModal } from "./SessionFilePreviewModal";
import { formatMessage, useI18n } from "../lib/i18n";
import { systemAPI } from "../lib/electron-api";
import { isElectron } from "../lib/platform";
import type {
  UnifiedBackgroundTask,
  UnifiedSessionFileItem,
  UnifiedSessionFilePreview,
  UnifiedSessionWorkspaceState,
} from "../types/unified";

function formatElapsed(startedAt: string | undefined, nowMs: number): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const sec = Math.max(0, Math.floor((nowMs - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

function parentFolder(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx > 0 ? filePath.slice(0, idx) : "";
}

export interface WorkspaceTodoItem {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface SessionWorkspaceBarProps {
  workspace: UnifiedSessionWorkspaceState | undefined;
  todos?: WorkspaceTodoItem[];
  isWorking?: boolean;
  /** When true, renders inline inside PromptInput's top row (parent provides `relative` positioning). */
  inline?: boolean;
  onPreviewFile: (fileId: string) => Promise<UnifiedSessionFilePreview>;
  onStopTask: (taskId: string) => Promise<void>;
}

export function SessionWorkspaceBar(props: SessionWorkspaceBarProps) {
  const { t } = useI18n();
  const [openPanel, setOpenPanel] = createSignal<"todos" | "tasks" | "files" | null>(null);
  const [fileFilter, setFileFilter] = createSignal("");
  const [stoppingIds, setStoppingIds] = createSignal<Set<string>>(new Set());
  const [activePreviewFile, setActivePreviewFile] = createSignal<UnifiedSessionFileItem | null>(null);
  const [nowMs, setNowMs] = createSignal(Date.now());

  let containerRef: HTMLDivElement | undefined;

  // Reset popover and preview state on session switch
  createEffect(
    on(
      () => props.workspace?.sessionId,
      () => {
        setOpenPanel(null);
        setFileFilter("");
        setActivePreviewFile(null);
      },
      { defer: true },
    ),
  );

  // Tick elapsed timer only while the tasks popover is open
  createEffect(() => {
    if (openPanel() !== "tasks") return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });

  onMount(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (!openPanel()) return;
      if (containerRef && !containerRef.contains(e.target as Node)) {
        setOpenPanel(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openPanel() && !activePreviewFile()) {
        setOpenPanel(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    });
  });

  const todos = createMemo(() => props.todos ?? props.workspace?.todos ?? []);
  const completedTodosCount = createMemo(
    () => todos().filter((item) => item.status === "completed").length,
  );
  const inProgressTodosCount = createMemo(
    () => todos().filter((item) => item.status === "in_progress").length,
  );
  const sortedTodos = createMemo(() => {
    const priority: Record<string, number> = {
      in_progress: 0,
      pending: 1,
      completed: 2,
    };
    return [...todos()].sort(
      (a, b) => (priority[a.status] ?? 1) - (priority[b.status] ?? 1),
    );
  });

  const tasks = createMemo(() => props.workspace?.backgroundTasks ?? []);
  const runningTasks = createMemo(() =>
    tasks().filter((item) => item.status === "running"),
  );

  const files = createMemo(() => props.workspace?.files ?? []);
  const summary = createMemo(() => props.workspace?.changesSummary);
  const totalFilesCount = createMemo(() =>
    files().length > 0 ? files().length : (summary()?.files ?? 0),
  );

  const filteredFiles = createMemo(() => {
    const q = fileFilter().trim().toLowerCase();
    if (!q) return files();
    return files().filter(
      (item) =>
        item.path.toLowerCase().includes(q)
        || item.label.toLowerCase().includes(q),
    );
  });

  const visible = createMemo(
    () => todos().length > 0 || tasks().length > 0 || totalFilesCount() > 0,
  );

  const handleStopClick = async (task: UnifiedBackgroundTask, e: MouseEvent) => {
    e.stopPropagation();
    if (stoppingIds().has(task.id)) return;
    setStoppingIds((prev) => new Set(prev).add(task.id));
    try {
      await props.onStopTask(task.id);
    } finally {
      setStoppingIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  };

  const handleFileItemClick = (item: UnifiedSessionFileItem) => {
    if (item.previewable) {
      setOpenPanel(null);
      setActivePreviewFile(item);
      return;
    }
    if (item.externalUrl) {
      setOpenPanel(null);
      if (isElectron()) {
        void systemAPI.openExternal(item.externalUrl);
      } else {
        window.open(item.externalUrl, "_blank", "noopener,noreferrer");
      }
    }
  };

  const kindIndicator = (kind: UnifiedSessionFileItem["kind"]) => {
    switch (kind) {
      case "created":
        return { symbol: "+", cls: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10" };
      case "deleted":
        return { symbol: "−", cls: "text-rose-600 dark:text-rose-400 bg-rose-500/10" };
      case "renamed":
        return { symbol: "R", cls: "text-purple-600 dark:text-purple-400 bg-purple-500/10" };
      case "artifact":
        return { symbol: "★", cls: "text-indigo-600 dark:text-indigo-400 bg-indigo-500/10" };
      default:
        return { symbol: "M", cls: "text-amber-600 dark:text-amber-400 bg-amber-500/10" };
    }
  };

  return (
    <>
      <Show when={visible()}>
        <div ref={containerRef} class={`${props.inline ? "" : "relative mb-2 "}select-none`}>
          {/* Todos checklist popover */}
          <Show when={openPanel() === "todos" && todos().length > 0}>
            <div
              role="region"
              aria-label={t().parts.todoTitle || "Tasks"}
              class="absolute bottom-full left-0 right-0 z-30 mb-1.5 rounded-xl border border-gray-200 dark:border-slate-700/90 bg-white/98 dark:bg-slate-900/98 backdrop-blur-md shadow-2xl overflow-hidden"
            >
              <div class="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-slate-800">
                <div class="flex items-center gap-2">
                  <span class="text-indigo-600 dark:text-indigo-400 flex items-center">
                    <IconQueueList width={14} height={14} />
                  </span>
                  <span class="text-xs font-semibold text-gray-700 dark:text-slate-200">
                    {t().parts.todoTitle || "Tasks"}
                  </span>
                </div>
                <span class="text-[11px] font-mono text-gray-500 dark:text-slate-400 tabular-nums">
                  {completedTodosCount()}/{todos().length}
                </span>
              </div>
              <div class="max-h-60 overflow-y-auto p-1.5 space-y-0.5">
                <For each={sortedTodos()}>
                  {(todo) => (
                    <div class="flex items-start gap-2.5 px-2 py-1.5 rounded-lg text-xs hover:bg-gray-50/80 dark:hover:bg-slate-800/50">
                      <span
                        class={`mt-0.5 w-3.5 h-3.5 rounded-[4px] inline-flex items-center justify-center shrink-0 ${
                          todo.status === "completed"
                            ? "bg-indigo-600 dark:bg-indigo-500 text-white"
                            : todo.status === "in_progress"
                              ? "border-[1.5px] border-indigo-500 dark:border-indigo-400 ring-2 ring-indigo-500/20"
                              : "border-[1.5px] border-gray-300 dark:border-slate-600"
                        }`}
                      >
                        <Show when={todo.status === "completed"}>
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </Show>
                        <Show when={todo.status === "in_progress"}>
                          <span class="w-1.5 h-1.5 rounded-full bg-indigo-500 dark:bg-indigo-400 animate-pulse" />
                        </Show>
                      </span>
                      <span
                        class={`leading-relaxed break-words ${
                          todo.status === "completed"
                            ? "text-gray-400 dark:text-slate-500 line-through"
                            : todo.status === "in_progress"
                              ? "font-medium text-gray-900 dark:text-slate-100"
                              : "text-gray-700 dark:text-slate-300"
                        }`}
                      >
                        {todo.content}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Popover anchored directly above the pills */}
          <Show when={openPanel() === "tasks" && tasks().length > 0}>
            <div
              role="region"
              aria-label={t().sessionWorkspace.tasksTitle}
              class="absolute bottom-full left-0 right-0 z-30 mb-1.5 rounded-xl border border-gray-200 dark:border-slate-700/90 bg-white/98 dark:bg-slate-900/98 backdrop-blur-md shadow-2xl overflow-hidden"
            >
              <div class="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-slate-800">
                <span class="text-xs font-semibold text-gray-700 dark:text-slate-200">
                  {t().sessionWorkspace.tasksTitle}
                </span>
                <span class="text-[11px] font-mono text-gray-400 dark:text-slate-500 tabular-nums">
                  {runningTasks().length > 0
                    ? formatMessage(t().sessionWorkspace.runningTasks, { count: runningTasks().length })
                    : tasks().length}
                </span>
              </div>
              <div class="max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-slate-800/70">
                <For each={tasks()}>
                  {(task) => {
                    const elapsed = createMemo(() => formatElapsed(task.startedAt, nowMs()));
                    const isStopping = createMemo(() => stoppingIds().has(task.id));
                    return (
                      <div class="flex items-start justify-between gap-2.5 px-3 py-2 text-xs hover:bg-gray-50/80 dark:hover:bg-slate-800/40">
                        <div class="flex items-start gap-2 min-w-0 flex-1">
                          <span class="mt-0.5 shrink-0 text-gray-500 dark:text-slate-400">
                            <Show
                              when={task.kind === "shell"}
                              fallback={
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                  <path d="M12 8V4H8" />
                                  <rect width="16" height="12" x="4" y="8" rx="2" />
                                  <path d="M2 14h2" />
                                  <path d="M20 14h2" />
                                  <path d="M15 13v2" />
                                  <path d="M9 13v2" />
                                </svg>
                              }
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="4 17 10 11 4 5" />
                                <line x1="12" x2="20" y1="19" y2="19" />
                              </svg>
                            </Show>
                          </span>
                          <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-1.5 flex-wrap">
                              <span class="font-medium text-gray-800 dark:text-slate-100 break-words">
                                {task.label}
                              </span>
                              <Show when={task.kind === "subagent"}>
                                <span class="px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[10px]">
                                  {t().sessionWorkspace.subagentBadge}
                                </span>
                              </Show>
                              <Show when={task.detached}>
                                <span class="px-1.5 py-0.2 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 text-[10px]">
                                  {t().sessionWorkspace.detachedBadge}
                                </span>
                              </Show>
                              <Show when={task.status === "completed"}>
                                <span class="px-1.5 py-0.2 rounded bg-gray-500/10 text-gray-500 dark:text-slate-400 text-[10px]">
                                  {t().sessionWorkspace.completedBadge}
                                </span>
                              </Show>
                              <Show when={elapsed() && task.status === "running"}>
                                <span class="text-[11px] font-mono text-gray-400 dark:text-slate-500 tabular-nums">
                                  {elapsed()}
                                </span>
                              </Show>
                            </div>
                            <Show when={task.command && task.command !== task.label}>
                              <div class="mt-0.5 font-mono text-[11px] text-gray-500 dark:text-slate-400 truncate" title={task.command}>
                                {task.command!.split(/\r?\n/).find((l) => l.trim()) ?? task.command}
                              </div>
                            </Show>
                          </div>
                        </div>

                        <Show when={task.stoppable && task.status === "running"}>
                          <button
                            type="button"
                            disabled={isStopping()}
                            onClick={(e) => void handleStopClick(task, e)}
                            class="shrink-0 px-2 py-1 rounded-md border border-rose-200 dark:border-rose-800/60 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-[11px] font-medium disabled:opacity-50"
                          >
                            {isStopping() ? t().sessionWorkspace.stoppingTask : t().sessionWorkspace.stopTask}
                          </button>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          </Show>

          <Show when={openPanel() === "files" && totalFilesCount() > 0}>
            <div
              role="region"
              aria-label={t().sessionWorkspace.filesTitle}
              class="absolute bottom-full left-0 right-0 z-30 mb-1.5 rounded-xl border border-gray-200 dark:border-slate-700/90 bg-white/98 dark:bg-slate-900/98 backdrop-blur-md shadow-2xl overflow-hidden"
            >
              <div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-100 dark:border-slate-800">
                <span class="text-xs font-semibold text-gray-700 dark:text-slate-200">
                  {t().sessionWorkspace.filesTitle}
                </span>
                <div class="flex items-center gap-2 text-[11px] font-mono tabular-nums">
                  <span class="text-gray-500 dark:text-slate-400">
                    {formatMessage(t().sessionWorkspace.filesCount, { count: totalFilesCount() })}
                  </span>
                  <Show when={(summary()?.additions ?? 0) > 0}>
                    <span class="text-emerald-600 dark:text-emerald-400">+{summary()!.additions}</span>
                  </Show>
                  <Show when={(summary()?.deletions ?? 0) > 0}>
                    <span class="text-rose-600 dark:text-rose-400">-{summary()!.deletions}</span>
                  </Show>
                </div>
              </div>

              <Show when={files().length > 5}>
                <div class="px-2.5 py-1.5 border-b border-gray-100 dark:border-slate-800">
                  <input
                    type="text"
                    value={fileFilter()}
                    onInput={(e) => setFileFilter(e.currentTarget.value)}
                    placeholder={t().sessionWorkspace.filterFilesPlaceholder}
                    class="w-full px-2.5 py-1 rounded-lg bg-gray-100/80 dark:bg-slate-800/80 border border-transparent focus:border-blue-500/50 focus:outline-none text-[16px] sm:text-xs text-gray-800 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500"
                  />
                </div>
              </Show>

              <div class="max-h-[min(300px,46vh)] overflow-y-auto">
                <Show
                  when={files().length > 0}
                  fallback={
                    <div class="flex items-center justify-center gap-2 py-6 text-xs text-gray-500 dark:text-slate-400">
                      <Spinner class="w-3.5 h-3.5" />
                      <span>{t().sessionWorkspace.loadingFiles}</span>
                    </div>
                  }
                >
                  <Show
                    when={filteredFiles().length > 0}
                    fallback={
                      <div class="py-5 text-center text-xs text-gray-400 dark:text-slate-500">
                        {t().sessionWorkspace.noMatchingFiles}
                      </div>
                    }
                  >
                    <For each={filteredFiles()}>
                      {(file) => {
                        const badge = kindIndicator(file.kind);
                        const dir = parentFolder(file.path);
                        const clickable = file.previewable || Boolean(file.externalUrl);
                        return (
                          <button
                            type="button"
                            disabled={!clickable}
                            onClick={() => handleFileItemClick(file)}
                            class="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-slate-800/60 transition-colors disabled:opacity-60"
                          >
                            <div class="flex items-center gap-2 min-w-0 flex-1">
                              <FileIcon name={file.label} type="file" size={15} class="shrink-0" />
                              <span class="font-medium text-gray-800 dark:text-slate-100 truncate">
                                {file.label}
                              </span>
                              <Show when={dir}>
                                <span class="text-[11px] text-gray-400 dark:text-slate-500 truncate">
                                  {dir}
                                </span>
                              </Show>
                            </div>
                            <div class="flex items-center gap-1.5 shrink-0 font-mono text-[11px] tabular-nums">
                              <Show when={(file.additions ?? 0) > 0}>
                                <span class="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                              </Show>
                              <Show when={(file.deletions ?? 0) > 0}>
                                <span class="text-rose-600 dark:text-rose-400">-{file.deletions}</span>
                              </Show>
                              <span class={`w-4 h-4 inline-flex items-center justify-center rounded text-[10px] font-semibold ${badge.cls}`}>
                                {badge.symbol}
                              </span>
                            </div>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </Show>
              </div>
            </div>
          </Show>

          {/* Compact pill row */}
          <div class="flex items-center gap-1 sm:gap-1.5 flex-nowrap justify-end">
            <Show when={todos().length > 0}>
              <button
                type="button"
                aria-expanded={openPanel() === "todos"}
                aria-label={`${t().parts.todoTitle || "Tasks"} ${completedTodosCount()}/${todos().length}`}
                title={`${t().parts.todoTitle || "Tasks"} (${completedTodosCount()}/${todos().length})`}
                onClick={() => setOpenPanel((cur) => (cur === "todos" ? null : "todos"))}
                class={`inline-flex items-center gap-1 sm:gap-1.5 shrink-0 px-2 sm:px-2.5 py-1 min-h-[28px] sm:min-h-[30px] rounded-lg border text-[11px] sm:text-xs transition-colors ${
                  openPanel() === "todos"
                    ? "border-blue-500/40 bg-blue-50/80 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
                    : "border-gray-200/80 dark:border-slate-700/70 bg-gray-50/80 dark:bg-slate-800/60 text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800"
                }`}
              >
                <Show
                  when={inProgressTodosCount() > 0 || props.isWorking}
                  fallback={
                    <Show
                      when={completedTodosCount() === todos().length}
                      fallback={
                        <span class="shrink-0 opacity-75 flex items-center">
                          <IconQueueList width={12} height={12} />
                        </span>
                      }
                    >
                      <svg class="shrink-0 text-emerald-500" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </Show>
                  }
                >
                  <span class="w-1.5 h-1.5 rounded-full bg-indigo-500 dark:bg-indigo-400 animate-pulse shrink-0" />
                  <span class="shrink-0 opacity-75 flex items-center">
                    <IconQueueList width={12} height={12} />
                  </span>
                </Show>
                <span class="hidden lg:inline font-medium shrink-0">
                  {t().parts.todoTitle || "Tasks"}
                </span>
                <span class="font-mono font-medium shrink-0 tabular-nums">
                  {completedTodosCount()}/{todos().length}
                </span>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class={`hidden lg:block shrink-0 opacity-60 transition-transform ${openPanel() === "todos" ? "rotate-180" : ""}`}
                >
                  <path d="m18 15-6-6-6 6" />
                </svg>
              </button>
            </Show>

            <Show when={tasks().length > 0}>
              <button
                type="button"
                aria-expanded={openPanel() === "tasks"}
                aria-label={
                  runningTasks().length > 0
                    ? formatMessage(t().sessionWorkspace.runningTasks, { count: runningTasks().length })
                    : `${tasks().length} ${t().sessionWorkspace.subagentBadge}`
                }
                title={
                  runningTasks().length === 1
                    ? `${formatMessage(t().sessionWorkspace.runningTasks, { count: 1 })} · ${runningTasks()[0].label}`
                    : runningTasks().length > 1
                      ? formatMessage(t().sessionWorkspace.runningTasks, { count: runningTasks().length })
                      : `${tasks().length} ${t().sessionWorkspace.subagentBadge}`
                }
                onClick={() => setOpenPanel((cur) => (cur === "tasks" ? null : "tasks"))}
                class={`inline-flex items-center gap-1 sm:gap-1.5 shrink-0 px-2 sm:px-2.5 py-1 min-h-[28px] sm:min-h-[30px] rounded-lg border text-[11px] sm:text-xs transition-colors ${
                  openPanel() === "tasks"
                    ? "border-blue-500/40 bg-blue-50/80 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
                    : "border-gray-200/80 dark:border-slate-700/70 bg-gray-50/80 dark:bg-slate-800/60 text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800"
                }`}
              >
                <Show
                  when={runningTasks().length > 0}
                  fallback={
                    <span class="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-slate-500 shrink-0" />
                  }
                >
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                </Show>
                <svg class="shrink-0 opacity-75" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" x2="20" y1="19" y2="19" />
                </svg>
                <span class="lg:hidden font-mono font-medium shrink-0 tabular-nums">
                  {runningTasks().length > 0 ? runningTasks().length : tasks().length}
                </span>
                <span class="hidden lg:inline font-medium shrink-0 tabular-nums">
                  {runningTasks().length > 0
                    ? formatMessage(t().sessionWorkspace.runningTasks, { count: runningTasks().length })
                    : `${tasks().length} ${t().sessionWorkspace.subagentBadge}`}
                </span>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class={`hidden lg:block shrink-0 opacity-60 transition-transform ${openPanel() === "tasks" ? "rotate-180" : ""}`}
                >
                  <path d="m18 15-6-6-6 6" />
                </svg>
              </button>
            </Show>

            <Show when={totalFilesCount() > 0}>
              <button
                type="button"
                aria-expanded={openPanel() === "files"}
                aria-label={formatMessage(t().sessionWorkspace.filesCount, { count: totalFilesCount() })}
                title={formatMessage(t().sessionWorkspace.filesCount, { count: totalFilesCount() })}
                onClick={() => setOpenPanel((cur) => (cur === "files" ? null : "files"))}
                class={`inline-flex items-center gap-1 sm:gap-1.5 shrink-0 px-2 sm:px-2.5 py-1 min-h-[28px] sm:min-h-[30px] rounded-lg border text-[11px] sm:text-xs transition-colors ${
                  openPanel() === "files"
                    ? "border-blue-500/40 bg-blue-50/80 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
                    : "border-gray-200/80 dark:border-slate-700/70 bg-gray-50/80 dark:bg-slate-800/60 text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800"
                }`}
              >
                <svg class="shrink-0 opacity-75" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                  <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                  <path d="M9 15h6" />
                  <path d="M12 12v6" />
                </svg>
                <span class="lg:hidden font-mono font-medium shrink-0 tabular-nums">
                  {totalFilesCount()}
                </span>
                <span class="hidden lg:inline font-medium shrink-0 tabular-nums">
                  {formatMessage(t().sessionWorkspace.filesCount, { count: totalFilesCount() })}
                </span>
                <Show when={(summary()?.additions ?? 0) > 0 || (summary()?.deletions ?? 0) > 0}>
                  <span class="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums shrink-0">
                    <Show when={(summary()?.additions ?? 0) > 0}>
                      <span class="text-emerald-600 dark:text-emerald-400">+{summary()!.additions}</span>
                    </Show>
                    <Show when={(summary()?.deletions ?? 0) > 0}>
                      <span class="text-rose-600 dark:text-rose-400">-{summary()!.deletions}</span>
                    </Show>
                  </span>
                </Show>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class={`hidden lg:block shrink-0 opacity-60 transition-transform ${openPanel() === "files" ? "rotate-180" : ""}`}
                >
                  <path d="m18 15-6-6-6 6" />
                </svg>
              </button>
            </Show>
          </div>
        </div>
      </Show>

      <SessionFilePreviewModal
        file={activePreviewFile()}
        files={files()}
        loadPreview={props.onPreviewFile}
        onSelectFile={(file) => setActivePreviewFile(file)}
        onClose={() => setActivePreviewFile(null)}
      />
    </>
  );
}
