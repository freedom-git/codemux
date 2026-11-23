import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useI18n } from "../lib/i18n";
import { systemAPI } from "../lib/electron-api";
import { gateway } from "../lib/gateway-api";
import { isElectron } from "../lib/platform";
import type { DirectoryBrowseResult, SessionSourceState } from "../types/unified";

interface AddProjectModalProps {
  isOpen: boolean;
  sessionSources?: SessionSourceState[];
  onClose: () => void;
  onAdd: (directory: string, sourceId?: string) => Promise<void>;
}

export function AddProjectModal(props: AddProjectModalProps) {
  const { t } = useI18n();
  const [directory, setDirectory] = createSignal("");
  const [selectedSourceId, setSelectedSourceId] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Server-side interactive directory browser state
  const [browseResult, setBrowseResult] = createSignal<DirectoryBrowseResult | null>(null);
  const [browseLoading, setBrowseLoading] = createSignal(false);
  const [browseError, setBrowseError] = createSignal<string | null>(null);
  const [folderFilter, setFolderFilter] = createSignal("");
  let browseSeq = 0;
  let breadcrumbScrollRef: HTMLDivElement | undefined;

  const creatableSources = createMemo(() =>
    (props.sessionSources ?? []).filter((source) => source.enabled && source.available && source.canCreateSession),
  );

  const effectiveSourceId = () => {
    const id = selectedSourceId();
    return id && creatableSources().some((source) => source.id === id) ? id : undefined;
  };

  const filteredEntries = createMemo(() => {
    const entries = browseResult()?.entries ?? [];
    const q = folderFilter().trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(q));
  });

  const browseTo = async (targetPath: string, syncInput: boolean) => {
    const seq = ++browseSeq;
    setBrowseLoading(true);
    setBrowseError(null);
    setFolderFilter("");
    if (syncInput) {
      setDirectory(targetPath);
      setError(null);
    }
    try {
      const res = await gateway.browseDirectories(targetPath || undefined);
      if (seq !== browseSeq) return;
      setBrowseResult(res);
      if (syncInput && res.currentPath) {
        setDirectory(res.currentPath);
      }
      requestAnimationFrame(() => {
        if (breadcrumbScrollRef) {
          breadcrumbScrollRef.scrollLeft = breadcrumbScrollRef.scrollWidth;
        }
      });
    } catch (e) {
      if (seq !== browseSeq) return;
      setBrowseError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === browseSeq) {
        setBrowseLoading(false);
      }
    }
  };

  createEffect(() => {
    if (props.isOpen) {
      void browseTo("", false);
    } else {
      browseSeq++;
      setBrowseResult(null);
      setBrowseError(null);
      setFolderFilter("");
    }
  });

  const handleAdd = async () => {
    const dir = directory().trim();
    if (!dir) return;

    setLoading(true);
    setError(null);

    try {
      await props.onAdd(dir, effectiveSourceId());
      setDirectory("");
      setSelectedSourceId("");
      props.onClose();
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "";
      setError(errorMessage || t().project.addFailed);
    } finally {
      setLoading(false);
    }
  };

  const handleBrowse = async () => {
    const selected = await systemAPI.selectDirectory();
    if (selected) {
      void browseTo(selected, true);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.isComposing && !loading()) {
      handleAdd();
    } else if (e.key === "Escape") {
      handleClose();
    }
  };

  const handleClose = () => {
    setDirectory("");
    setSelectedSourceId("");
    setError(null);
    props.onClose();
  };

  return (
    <Show when={props.isOpen}>
      <div class="fixed inset-0 z-50 flex items-center justify-center">
        <div
          class="absolute inset-0 bg-black/40 backdrop-blur-sm backdrop-blur-xs"
          onClick={handleClose}
          aria-hidden="true"
        />

        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-project-modal-title"
          class="relative bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] rounded-2xl shadow-[var(--cm-shadow-lg)] ring-1 ring-[var(--cm-hairline-strong)] w-full max-w-lg mx-3 sm:mx-4 overflow-hidden flex flex-col max-h-[calc(100dvh-1.5rem)]"
        >
          <div class="flex items-center justify-between px-4 sm:px-6 py-3.5 border-b border-[var(--cm-hairline-strong)]">
            <h2 id="add-project-modal-title" class="text-base sm:text-lg font-semibold text-gray-900 dark:text-white">
              {t().project.addTitle}
            </h2>
            <button
              type="button"
              onClick={handleClose}
              class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition-colors"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          <div class="p-4 sm:p-5 space-y-3.5 overflow-y-auto flex-1">
            {/* Interactive server directory picker (starts at C:\ / Q:\ on Windows, / on Linux/macOS) */}
            <div data-folder-browser class="rounded-xl border border-[var(--cm-hairline-strong)] bg-gray-50/70 dark:bg-black/20 overflow-hidden">
              {/* Breadcrumb + Up / Home navigation bar */}
              <div class="flex items-center justify-between gap-1.5 px-2.5 py-2 border-b border-[var(--cm-hairline)] bg-[var(--cm-surface)]/80 dark:bg-white/[0.02]">
                <div ref={breadcrumbScrollRef} class="flex items-center gap-0.5 overflow-x-auto min-w-0 text-xs py-0.5 [scrollbar-width:none]">
                  <Show when={browseResult()?.hasDriveRoot}>
                    <button
                      type="button"
                      data-folder-drives-root
                      onClick={() => void browseTo("", true)}
                      class={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md font-medium transition-colors ${
                        browseResult()?.currentPath === ""
                          ? "bg-blue-500/12 text-blue-600 dark:text-blue-300"
                          : "text-gray-600 dark:text-gray-300 hover:bg-gray-900/[0.05] dark:hover:bg-white/[0.06]"
                      }`}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect width="20" height="8" x="2" y="4" rx="2" />
                        <rect width="20" height="8" x="2" y="12" rx="2" />
                        <line x1="6" x2="6.01" y1="8" y2="8" />
                        <line x1="6" x2="6.01" y1="16" y2="16" />
                      </svg>
                      {t().project.drivesRoot}
                    </button>
                  </Show>
                  <For each={browseResult()?.breadcrumbs ?? []}>
                    {(crumb, idx) => (
                      <>
                        <Show when={idx() > 0 || browseResult()?.hasDriveRoot}>
                          <span class="text-gray-400 dark:text-gray-600 select-none px-0.5">/</span>
                        </Show>
                        <button
                          type="button"
                          onClick={() => void browseTo(crumb.path, true)}
                          class={`shrink-0 px-1.5 py-1 rounded-md font-medium transition-colors max-w-[140px] truncate ${
                            idx() === (browseResult()?.breadcrumbs.length ?? 0) - 1
                              ? "bg-blue-500/12 text-blue-600 dark:text-blue-300"
                              : "text-gray-600 dark:text-gray-300 hover:bg-gray-900/[0.05] dark:hover:bg-white/[0.06]"
                          }`}
                          title={crumb.path}
                        >
                          {crumb.label}
                        </button>
                      </>
                    )}
                  </For>
                </div>

                <div class="flex items-center gap-1 shrink-0">
                  <Show when={browseResult()?.homePath}>
                    {(home) => (
                      <button
                        type="button"
                        data-folder-home
                        onClick={() => void browseTo(home(), true)}
                        class="px-2 py-1 text-[11px] font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-900/[0.05] dark:hover:bg-white/[0.07] rounded-md transition-colors"
                        title={home()}
                      >
                        ~ {t().project.homeDir}
                      </button>
                    )}
                  </Show>
                  <Show when={browseResult()?.parentPath !== null && browseResult()?.parentPath !== undefined}>
                    <button
                      type="button"
                      data-folder-up
                      onClick={() => {
                        const parent = browseResult()?.parentPath;
                        if (parent !== null && parent !== undefined) void browseTo(parent, true);
                      }}
                      class="inline-flex items-center gap-0.5 px-2 py-1 text-[11px] font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-900/[0.05] dark:hover:bg-white/[0.07] rounded-md transition-colors"
                      title={t().project.parentDir}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="m18 15-6-6-6 6" />
                      </svg>
                      {t().project.parentDir}
                    </button>
                  </Show>
                </div>
              </div>

              {/* Optional quick filter when folder has > 8 subdirectories */}
              <Show when={(browseResult()?.entries.length ?? 0) > 8}>
                <div class="px-2.5 py-1.5 border-b border-[var(--cm-hairline)]">
                  <input
                    type="search"
                    value={folderFilter()}
                    onInput={(e) => setFolderFilter(e.currentTarget.value)}
                    placeholder={t().project.filterFolders}
                    class="w-full px-2.5 py-1 text-xs bg-[var(--cm-surface)] dark:bg-white/[0.04] border border-[var(--cm-hairline)] rounded-md text-gray-800 dark:text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </Show>

              {/* Folder / Drive rows */}
              <div class="max-h-52 sm:max-h-60 overflow-y-auto divide-y divide-[var(--cm-hairline)]/60">
                <Show
                  when={!browseLoading()}
                  fallback={
                    <div class="px-4 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
                      {t().project.loadingFolders}
                    </div>
                  }
                >
                  <Show
                    when={!browseError()}
                    fallback={
                      <div class="px-4 py-4 text-xs text-red-600 dark:text-red-400">
                        {browseError()}
                      </div>
                    }
                  >
                    <Show
                      when={filteredEntries().length > 0}
                      fallback={
                        <div class="px-4 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
                          {t().project.emptySubfolders}
                        </div>
                      }
                    >
                      <For each={filteredEntries()}>
                        {(entry) => (
                          <button
                            type="button"
                            data-folder-entry={entry.path}
                            onClick={() => void browseTo(entry.path, true)}
                            class={`w-full flex items-center gap-2.5 px-3 py-2.5 [@media(pointer:coarse)]:py-3 text-left text-sm hover:bg-gray-900/[0.04] dark:hover:bg-white/[0.06] active:bg-gray-900/[0.08] dark:active:bg-white/[0.1] transition-colors ${
                              entry.dimmed ? "opacity-60" : ""
                            }`}
                          >
                            <Show
                              when={entry.kind === "drive"}
                              fallback={
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={entry.isGitRepo ? "text-blue-500 dark:text-blue-400 shrink-0" : "text-amber-500/85 dark:text-amber-400/80 shrink-0"}>
                                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                                </svg>
                              }
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-blue-500 dark:text-blue-400 shrink-0">
                                <ellipse cx="12" cy="5" rx="9" ry="3" />
                                <path d="M3 5V19A9 3 0 0 0 21 19V5" />
                                <path d="M3 12A9 3 0 0 0 21 12" />
                              </svg>
                            </Show>
                            <span class="flex-1 truncate font-medium text-gray-800 dark:text-gray-100">
                              {entry.name}
                            </span>
                            <Show when={entry.isGitRepo}>
                              <span class="cm-mono shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-500/10 text-blue-600 dark:text-blue-300 ring-1 ring-inset ring-blue-500/20">
                                git
                              </span>
                            </Show>
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-gray-400 dark:text-gray-500 shrink-0">
                              <path d="m9 18 6-6-6-6" />
                            </svg>
                          </button>
                        )}
                      </For>
                    </Show>
                  </Show>
                </Show>
              </div>
            </div>

            {/* Selected path bar (also supports manual paste/edit & native Browse on Electron) */}
            <div>
              <label class="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t().project.inputPath}
              </label>
              <div class="flex gap-2">
                <input
                  type="text"
                  value={directory()}
                  onInput={(e) => setDirectory(e.currentTarget.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="/path/to/your/project"
                  class="cm-mono flex-1 px-3 py-2 text-xs sm:text-sm bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] border border-[var(--cm-hairline-strong)] rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <Show when={isElectron()}>
                  <button
                    type="button"
                    onClick={handleBrowse}
                    class="px-3 py-2 text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 border border-[var(--cm-hairline-strong)] rounded-lg transition-colors whitespace-nowrap"
                  >
                    {t().project.browse}
                  </button>
                </Show>
              </div>
              <p class="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                {t().project.pathHint}
              </p>
            </div>

            <Show when={creatableSources().length > 0}>
              <div data-add-project-target>
                <label class="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t().project.targetLabel}
                </label>
                <div
                  role="radiogroup"
                  aria-label={t().project.targetLabel}
                  class="grid grid-cols-2 gap-1.5 rounded-xl bg-gray-900/[0.04] dark:bg-white/[0.05] p-1 ring-1 ring-inset ring-[var(--cm-hairline)]"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={effectiveSourceId() === undefined}
                    onClick={() => setSelectedSourceId("")}
                    class={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                      effectiveSourceId() === undefined
                        ? "bg-[var(--cm-surface)] dark:bg-white/[0.12] text-gray-900 dark:text-white shadow-[var(--cm-shadow-sm)] ring-1 ring-[var(--cm-hairline)]"
                        : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
                    }`}
                  >
                    {t().project.targetLocal}
                  </button>
                  <For each={creatableSources()}>
                    {(source) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={effectiveSourceId() === source.id}
                        onClick={() => setSelectedSourceId(source.id)}
                        class={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                          effectiveSourceId() === source.id
                            ? "bg-[var(--cm-surface)] dark:bg-white/[0.12] text-gray-900 dark:text-white shadow-[var(--cm-shadow-sm)] ring-1 ring-[var(--cm-hairline)]"
                            : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
                        }`}
                      >
                        {source.peerName}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={error()}>
              <div class="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p class="text-sm text-red-700 dark:text-red-400">{error()}</p>
              </div>
            </Show>
          </div>

          <div class="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 px-4 sm:px-6 py-3.5 border-t border-[var(--cm-hairline-strong)] bg-gray-50 dark:bg-slate-900/50 flex-shrink-0">
            <button
              type="button"
              onClick={handleClose}
              class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-900/[0.04] dark:hover:bg-white/[0.05] rounded-lg transition-colors"
            >
              {t().common.cancel}
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={loading() || !directory().trim()}
              class="cm-btn-primary px-4 py-2 text-sm font-medium disabled:cursor-not-allowed rounded-lg"
            >
              {loading() ? t().project.adding : t().project.add}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
