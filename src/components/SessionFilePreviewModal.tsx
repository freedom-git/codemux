import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";
import { ContentCode } from "./share/content-code";
import { ContentDiff } from "./share/content-diff";
import { ContentMarkdown } from "./share/content-markdown";
import { FileIcon } from "./FileIcon";
import { Spinner } from "./Spinner";
import { useI18n } from "../lib/i18n";
import { systemAPI } from "../lib/electron-api";
import { isElectron } from "../lib/platform";
import type {
  UnifiedSessionFileItem,
  UnifiedSessionFilePreview,
} from "../types/unified";

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  html: "html",
  css: "css",
  scss: "scss",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  graphql: "graphql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  xml: "xml",
  svg: "xml",
  dockerfile: "dockerfile",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  ini: "ini",
  conf: "ini",
};

function detectLanguage(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower === "dockerfile" || lower === "containerfile") return "dockerfile";
  if (lower === "makefile") return "bash";
  const ext = lower.split(".").pop() || "";
  return EXT_TO_LANG[ext] || "plaintext";
}

function isMarkdownFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx");
}

export interface SessionFilePreviewModalProps {
  file: UnifiedSessionFileItem | null;
  files: UnifiedSessionFileItem[];
  loadPreview: (fileId: string) => Promise<UnifiedSessionFilePreview>;
  onSelectFile: (file: UnifiedSessionFileItem) => void;
  onClose: () => void;
}

export function SessionFilePreviewModal(props: SessionFilePreviewModalProps) {
  const { t } = useI18n();
  const [preview, setPreview] = createSignal<UnifiedSessionFilePreview | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [mode, setMode] = createSignal<"diff" | "content" | "rendered">("diff");

  let requestSeq = 0;

  const previewableFiles = createMemo(() =>
    props.files.filter((item) => item.previewable),
  );

  const currentIndex = createMemo(() => {
    const active = props.file;
    if (!active) return -1;
    return previewableFiles().findIndex((item) => item.id === active.id);
  });

  const hasPrev = createMemo(() => currentIndex() > 0);
  const hasNext = createMemo(() => {
    const idx = currentIndex();
    return idx >= 0 && idx < previewableFiles().length - 1;
  });

  const handlePrev = () => {
    const idx = currentIndex();
    if (idx > 0) props.onSelectFile(previewableFiles()[idx - 1]);
  };

  const handleNext = () => {
    const idx = currentIndex();
    const list = previewableFiles();
    if (idx >= 0 && idx < list.length - 1) props.onSelectFile(list[idx + 1]);
  };

  createEffect(
    on(
      () => props.file?.id,
      (fileId) => {
        const seq = ++requestSeq;
        if (!fileId) {
          setPreview(null);
          setLoading(false);
          setError(null);
          return;
        }
        setLoading(true);
        setError(null);
        setPreview(null);
        void props.loadPreview(fileId).then(
          (loaded) => {
            if (seq !== requestSeq) return;
            setPreview(loaded);
            setLoading(false);
            if (loaded.diff) {
              setMode("diff");
            } else if (loaded.content !== undefined && isMarkdownFile(loaded.label || loaded.path)) {
              setMode("rendered");
            } else {
              setMode("content");
            }
          },
          (err) => {
            if (seq !== requestSeq) return;
            setError(err instanceof Error && err.message ? err.message : t().sessionWorkspace.previewLoadFailed);
            setLoading(false);
          },
        );
      },
    ),
  );

  onMount(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!props.file) return;
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      } else if (e.altKey && e.key === "ArrowLeft" && hasPrev()) {
        e.preventDefault();
        handlePrev();
      } else if (e.altKey && e.key === "ArrowRight" && hasNext()) {
        e.preventDefault();
        handleNext();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  const openExternalLink = (url: string) => {
    if (isElectron()) {
      void systemAPI.openExternal(url);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const kindMeta = (kind: UnifiedSessionFileItem["kind"]) => {
    const sw = t().sessionWorkspace;
    switch (kind) {
      case "created":
        return { label: sw.kindCreated, cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" };
      case "deleted":
        return { label: sw.kindDeleted, cls: "bg-rose-500/15 text-rose-600 dark:text-rose-400" };
      case "renamed":
        return { label: sw.kindRenamed, cls: "bg-purple-500/15 text-purple-600 dark:text-purple-400" };
      case "artifact":
        return { label: sw.kindArtifact, cls: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400" };
      default:
        return { label: sw.kindModified, cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
    }
  };

  return (
    <Show when={props.file}>
      {(activeFile) => {
        const isMd = createMemo(() => isMarkdownFile(activeFile().label || activeFile().path));
        const lang = createMemo(() => detectLanguage(activeFile().label || activeFile().path));
        const badge = createMemo(() => kindMeta(activeFile().kind));

        return (
          <Portal>
            <div
              class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-[2px] p-0 sm:p-4"
              onClick={(e) => {
                if (e.target === e.currentTarget) props.onClose();
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={activeFile().path}
                class="flex flex-col w-full sm:max-w-4xl h-[90dvh] sm:h-[82vh] rounded-t-2xl sm:rounded-xl border border-gray-200 dark:border-slate-700/80 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
              >
                {/* Header */}
                <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-3.5 py-2.5 border-b border-gray-200 dark:border-slate-800 bg-gray-50/80 dark:bg-slate-900/90 shrink-0">
                  <div class="flex items-start sm:items-center justify-between gap-2 min-w-0 flex-1">
                    <div class="flex items-center gap-2 min-w-0 flex-1">
                      <FileIcon name={activeFile().label} type="file" size={16} class="shrink-0" />
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 min-w-0">
                          <span class="font-medium text-sm text-gray-900 dark:text-slate-100 truncate">
                            {activeFile().label}
                          </span>
                          <span class={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${badge().cls}`}>
                            {badge().label}
                          </span>
                          <Show when={activeFile().additions !== undefined || activeFile().deletions !== undefined}>
                            <span class="shrink-0 text-[11px] font-mono tabular-nums flex items-center gap-1">
                              <Show when={(activeFile().additions ?? 0) > 0}>
                                <span class="text-emerald-600 dark:text-emerald-400">+{activeFile().additions}</span>
                              </Show>
                              <Show when={(activeFile().deletions ?? 0) > 0}>
                                <span class="text-rose-600 dark:text-rose-400">-{activeFile().deletions}</span>
                              </Show>
                            </span>
                          </Show>
                        </div>
                        <div class="text-[11px] font-mono text-gray-500 dark:text-slate-400 truncate" title={activeFile().path}>
                          {activeFile().path}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => props.onClose()}
                      aria-label={t().common.cancel}
                      class="sm:hidden p-1.5 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-slate-100 hover:bg-gray-100 dark:hover:bg-slate-800 shrink-0"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  </div>

                  {/* Controls */}
                  <div class="flex items-center justify-between sm:justify-end gap-1.5 shrink-0">
                    <Show when={preview()?.diff || preview()?.content !== undefined}>
                      <div class="inline-flex rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-100/70 dark:bg-slate-800/80 p-0.5 text-xs">
                        <Show when={preview()?.diff}>
                          <button
                            type="button"
                            onClick={() => setMode("diff")}
                            class={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                              mode() === "diff"
                                ? "bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 shadow-xs"
                                : "text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-slate-200"
                            }`}
                          >
                            {t().sessionWorkspace.viewDiff}
                          </button>
                        </Show>
                        <Show when={preview()?.content !== undefined && isMd()}>
                          <button
                            type="button"
                            onClick={() => setMode("rendered")}
                            class={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                              mode() === "rendered"
                                ? "bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 shadow-xs"
                                : "text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-slate-200"
                            }`}
                          >
                            {t().sessionWorkspace.viewRendered}
                          </button>
                        </Show>
                        <Show when={preview()?.content !== undefined}>
                          <button
                            type="button"
                            onClick={() => setMode("content")}
                            class={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                              mode() === "content"
                                ? "bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 shadow-xs"
                                : "text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-slate-200"
                            }`}
                          >
                            {t().sessionWorkspace.viewContent}
                          </button>
                        </Show>
                      </div>
                    </Show>

                    <Show when={preview()?.externalUrl || activeFile().externalUrl}>
                      {(extUrl) => (
                        <button
                          type="button"
                          onClick={() => openExternalLink(extUrl())}
                          class="px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-slate-700 text-xs font-medium text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800"
                        >
                          {t().sessionWorkspace.openExternal}
                        </button>
                      )}
                    </Show>

                    <Show when={previewableFiles().length > 1}>
                      <div class="inline-flex items-center rounded-lg border border-gray-200 dark:border-slate-700">
                        <button
                          type="button"
                          disabled={!hasPrev()}
                          onClick={handlePrev}
                          title={t().sessionWorkspace.prevFile}
                          aria-label={t().sessionWorkspace.prevFile}
                          class="p-1.5 text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 disabled:opacity-35 rounded-l-lg"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="m15 18-6-6 6-6" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          disabled={!hasNext()}
                          onClick={handleNext}
                          title={t().sessionWorkspace.nextFile}
                          aria-label={t().sessionWorkspace.nextFile}
                          class="p-1.5 text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 disabled:opacity-35 rounded-r-lg border-l border-gray-200 dark:border-slate-700"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                        </button>
                      </div>
                    </Show>

                    <button
                      type="button"
                      onClick={() => props.onClose()}
                      aria-label={t().common.cancel}
                      class="hidden sm:inline-flex p-1.5 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-slate-100 hover:bg-gray-100 dark:hover:bg-slate-800"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Truncation notice */}
                <Show when={preview()?.truncated}>
                  <div class="px-3.5 py-1.5 text-xs bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-b border-amber-200/60 dark:border-amber-800/50 shrink-0">
                    {t().sessionWorkspace.contentTruncated}
                  </div>
                </Show>

                {/* Body */}
                <div class="conversation flex-1 min-h-0 overflow-auto p-3 sm:p-4 bg-white dark:bg-slate-950/60">
                  <Show when={loading()}>
                    <div class="flex items-center justify-center h-full gap-2 text-sm text-gray-500 dark:text-slate-400">
                      <Spinner class="w-4 h-4" />
                      <span>{t().common.loading}</span>
                    </div>
                  </Show>

                  <Show when={!loading() && error()}>
                    <div class="flex items-center justify-center h-full text-sm text-rose-600 dark:text-rose-400 px-4 text-center">
                      {error()}
                    </div>
                  </Show>

                  <Show when={!loading() && !error() && preview()}>
                    {(loaded) => (
                      <>
                        <Show when={loaded().imageBase64}>
                          <div class="flex items-center justify-center min-h-full p-2">
                            <img
                              src={`data:${loaded().mimeType || "image/png"};base64,${loaded().imageBase64}`}
                              alt={loaded().label}
                              class="max-w-full max-h-[70vh] object-contain rounded-lg border border-gray-200 dark:border-slate-800"
                            />
                          </div>
                        </Show>

                        <Show when={!loaded().imageBase64 && loaded().binary}>
                          <div class="flex items-center justify-center h-full text-sm text-gray-500 dark:text-slate-400">
                            {t().sessionWorkspace.binaryNotPreviewable}
                          </div>
                        </Show>

                        <Show when={!loaded().imageBase64 && !loaded().binary}>
                          <Show
                            when={mode() === "diff" && loaded().diff}
                            fallback={
                              <Show
                                when={mode() === "rendered" && isMd() && loaded().content !== undefined}
                                fallback={
                                  <ContentCode
                                    code={loaded().content ?? ""}
                                    lang={lang()}
                                    showLineNumbers={true}
                                  />
                                }
                              >
                                <div class="prose dark:prose-invert max-w-none px-1">
                                  <ContentMarkdown text={loaded().content ?? ""} expand />
                                </div>
                              </Show>
                            }
                          >
                            <ContentDiff diff={loaded().diff!} />
                          </Show>
                        </Show>
                      </>
                    )}
                  </Show>
                </div>
              </div>
            </div>
          </Portal>
        );
      }}
    </Show>
  );
}
