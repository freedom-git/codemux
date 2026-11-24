import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { ChatModelPicker } from "./ChatModelPicker";
import { useI18n } from "../lib/i18n";
import type { CodexServiceTier, ContextWindowOption, ReasoningEffort, UnifiedModelInfo } from "../types/unified";

interface SessionControlsProps {
  models: UnifiedModelInfo[];
  selectedModelId: string | null;
  customModelInput: boolean;
  modelDisabled?: boolean;
  modelPlaceholder: string;
  modelAriaLabel: string;
  supportedEfforts: ReasoningEffort[];
  effortLabels?: Partial<Record<ReasoningEffort, string>>;
  selectedEffort: ReasoningEffort | null;
  contextWindowOptions?: ContextWindowOption[];
  selectedContextWindow?: string | null;
  allowAllSupported?: boolean;
  allowAllActive?: boolean;
  fastModeSupported: boolean;
  serviceTier: CodexServiceTier | null;
  scopeHint: string;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  onContextWindowChange?: (contextWindowId: string) => void;
  onAllowAllToggle?: (nextActive: boolean) => void;
  onFastModeToggle: (nextActive: boolean) => void;
}

interface PopoverPosition {
  left: number;
  top: number;
  width: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function SettingRow(props: { label: string; description?: string; children: JSX.Element }) {
  return (
    <div class="space-y-2">
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          {props.label}
        </div>
        <Show when={props.description}>
          <div class="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            {props.description}
          </div>
        </Show>
      </div>
      {props.children}
    </div>
  );
}

export function SessionControls(props: SessionControlsProps) {
  const { t } = useI18n();
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<PopoverPosition | null>(null);
  let triggerRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;

  const selectedModel = createMemo(() =>
    props.models.find((model) => model.modelId === props.selectedModelId),
  );

  const modelLabel = createMemo(() =>
    selectedModel()?.name || props.selectedModelId || props.modelPlaceholder,
  );

  const effortLabels: Record<ReasoningEffort, () => string> = {
    none: () => t().prompt.reasoningEffortNone,
    low: () => t().prompt.reasoningEffortLow,
    medium: () => t().prompt.reasoningEffortMedium,
    high: () => t().prompt.reasoningEffortHigh,
    xhigh: () => t().prompt.reasoningEffortXHigh,
    max: () => t().prompt.reasoningEffortMax,
    ultra: () => t().prompt.reasoningEffortUltra,
  };

  const resolveEffortLabel = (effort: ReasoningEffort): string =>
    props.effortLabels?.[effort] ?? effortLabels[effort]?.() ?? effort;

  const effortLabel = createMemo(() => {
    const effort = props.selectedEffort;
    return effort ? resolveEffortLabel(effort) : null;
  });

  const contextWindowOptions = createMemo(() => props.contextWindowOptions ?? []);

  const contextWindowLabel = createMemo(() => {
    if (contextWindowOptions().length <= 1 || !props.selectedContextWindow) return null;
    return contextWindowOptions().find((option) => option.id === props.selectedContextWindow)?.label ?? null;
  });

  const fastActive = createMemo(() => props.serviceTier === "fast");
  const allowAllActive = createMemo(() => props.allowAllActive === true);

  const summary = createMemo(() => {
    const parts = [modelLabel()];
    const effort = effortLabel();
    if (effort && props.supportedEfforts.length > 1) parts.push(effort);
    const contextLabel = contextWindowLabel();
    if (contextLabel) parts.push(contextLabel);
    if (props.fastModeSupported && fastActive()) parts.push(t().engine.fastMode);
    return parts.join(" · ");
  });

  const tooltipSummary = createMemo(() => {
    if (props.allowAllSupported && allowAllActive()) {
      return `${summary()} · ${t().engine.allowAllPermissions}`;
    }
    return summary();
  });

  const updatePosition = () => {
    if (!triggerRef) return;
    const rect = triggerRef.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 380;
    const width = Math.min(380, Math.max(280, viewportWidth - 24));
    const maxLeft = Math.max(12, viewportWidth - width - 12);
    setPosition({
      left: clamp(rect.left, 12, maxLeft),
      top: rect.top - 8,
      width,
    });
  };

  const toggleOpen = () => {
    if (open()) {
      setOpen(false);
      setPosition(null);
      return;
    }
    updatePosition();
    setOpen(true);
  };

  createEffect(() => {
    if (!open()) return;

    const closePopover = () => {
      setOpen(false);
      setPosition(null);
    };

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (triggerRef?.contains(target) || panelRef?.contains(target)) return;
      if (target.closest("#chat-model-picker-dropdown")) return;
      closePopover();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePopover();
    };

    const handleResize = () => updatePosition();

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    onCleanup(() => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    });
  });

  return (
    <div class="min-w-0">
      <button
        ref={triggerRef}
        type="button"
        class={`inline-flex h-7 max-w-[68vw] sm:max-w-[420px] items-center gap-2 rounded-full border px-2.5 text-[11px] font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-slate-300 dark:focus:ring-slate-600 ${
          open()
            ? "border-slate-300 bg-white text-slate-700 shadow-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
            : "border-slate-200/80 bg-white/50 text-slate-500 hover:border-slate-300 hover:bg-white dark:border-slate-700/80 dark:bg-slate-800/40 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:bg-slate-800"
        }`}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        title={tooltipSummary()}
        onClick={toggleOpen}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            setPosition(null);
          }
        }}
      >
        <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 7h16" />
          <path d="M7 12h10" />
          <path d="M10 17h4" />
        </svg>
        <span class="min-w-0 truncate">{summary()}</span>
        <Show when={props.allowAllSupported && allowAllActive()}>
          <svg
            class="h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        </Show>
        <svg class="h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <Show when={open() && position()}>
        <Portal>
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t().chat.sessionScopeHint}
            style={{
              left: `${position()!.left}px`,
              top: `${position()!.top}px`,
              width: `${position()!.width}px`,
            }}
            class="fixed z-[9998] -translate-y-full rounded-2xl p-3 backdrop-blur-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] shadow-[var(--cm-shadow-lg)]"
          >
            <div class="space-y-3">
              <SettingRow label={t().engine.defaultModel}>
                <ChatModelPicker
                  models={props.models}
                  selectedModelId={props.selectedModelId}
                  customModelInput={props.customModelInput}
                  disabled={props.modelDisabled}
                  fullWidth
                  placeholder={props.modelPlaceholder}
                  ariaLabel={props.modelAriaLabel}
                  onChange={props.onModelChange}
                />
              </SettingRow>

              <Show when={props.supportedEfforts.length > 1}>
                <SettingRow label={t().engine.reasoningEffort} description={t().engine.reasoningEffortDesc}>
                  <div class="flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
                    <For each={props.supportedEfforts}>
                      {(effort) => {
                        const active = () => props.selectedEffort === effort;
                        return (
                          <button
                            type="button"
                            aria-pressed={active()}
                            class={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                              active()
                                ? "bg-white text-slate-800 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                                : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                            }`}
                            onClick={() => props.onReasoningEffortChange(effort)}
                          >
                            {resolveEffortLabel(effort)}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </SettingRow>
              </Show>

              <Show when={contextWindowOptions().length > 1}>
                <SettingRow label={t().engine.contextWindow} description={t().engine.contextWindowDesc}>
                  <div class="flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
                    <For each={contextWindowOptions()}>
                      {(option) => {
                        const active = () => props.selectedContextWindow === option.id;
                        return (
                          <button
                            type="button"
                            aria-pressed={active()}
                            title={option.description}
                            class={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                              active()
                                ? "bg-white text-slate-800 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                                : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                            }`}
                            onClick={() => props.onContextWindowChange?.(option.id)}
                          >
                            {option.label}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </SettingRow>
              </Show>

              <Show when={props.allowAllSupported}>
                <SettingRow label={t().engine.permissions} description={t().engine.allowAllPermissionsDesc}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={allowAllActive() ? "true" : "false"}
                    data-testid="session-allow-all-switch"
                    class={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-[12px] transition-colors ${
                      allowAllActive()
                        ? "border-emerald-200 bg-emerald-50/80 text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200"
                        : "border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800"
                    }`}
                    onClick={() => props.onAllowAllToggle?.(!allowAllActive())}
                  >
                    <span class="inline-flex items-center gap-2 font-medium">
                      <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        <Show when={allowAllActive()}>
                          <path d="m9 12 2 2 4-4" />
                        </Show>
                      </svg>
                      <span>{t().engine.allowAllPermissions}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      class={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                        allowAllActive()
                          ? "bg-emerald-500 dark:bg-emerald-500"
                          : "bg-slate-300 dark:bg-slate-600"
                      }`}
                    >
                      <span
                        class={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                          allowAllActive() ? "translate-x-[18px]" : "translate-x-[3px]"
                        }`}
                      />
                    </span>
                  </button>
                </SettingRow>
              </Show>

              <Show when={props.fastModeSupported}>
                <SettingRow label={t().engine.fastMode} description={t().engine.fastModeDesc}>
                  <button
                    type="button"
                    aria-pressed={fastActive()}
                    class={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-[12px] transition-colors ${
                      fastActive()
                        ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300"
                        : "border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800"
                    }`}
                    onClick={() => props.onFastModeToggle(!fastActive())}
                  >
                    <span class="inline-flex items-center gap-2 font-medium">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
                      </svg>
                      <span>{t().engine.fastMode}</span>
                    </span>
                    <span class={`h-2 w-2 rounded-full ${fastActive() ? "bg-blue-500" : "bg-slate-300 dark:bg-slate-600"}`} />
                  </button>
                </SettingRow>
              </Show>

              <div class="rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                {props.scopeHint}
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
