import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  computeContextMenuPosition,
  createContextMenuTrigger,
  type ContextMenuItem,
  type ContextMenuState,
  type ContextMenuTriggerHandlers,
} from "./context-menu-trigger";

export {
  computeContextMenuPosition,
  createContextMenuTrigger,
  type ContextMenuItem,
  type ContextMenuState,
  type ContextMenuTriggerHandlers,
};

interface ContextMenuProps {
  state: ContextMenuState | null;
  onClose: () => void;
}

export function ContextMenu(props: ContextMenuProps) {
  let menuRef: HTMLDivElement | undefined;
  const [coords, setCoords] = createSignal<{ left: number; top: number }>({ left: 0, top: 0 });
  const [confirmingId, setConfirmingId] = createSignal<string | null>(null);
  let openedAt = 0;

  createEffect(() => {
    const current = props.state;
    setConfirmingId(null);
    if (!current) return;
    openedAt = Date.now();
    setCoords({ left: current.x, top: current.y });

    const adjustPosition = () => {
      if (!menuRef) return;
      const rect = menuRef.getBoundingClientRect();
      setCoords(computeContextMenuPosition(
        { x: current.x, y: current.y },
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };

    const frame = requestAnimationFrame(adjustPosition);

    const handlePointerDown = (event: PointerEvent) => {
      if (Date.now() - openedAt < 120) return;
      if (menuRef && event.target instanceof Node && menuRef.contains(event.target)) return;
      props.onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }
    };

    const handleViewportChange = () => props.onClose();

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    onCleanup(() => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    });
  });

  return (
    <Show when={props.state}>
      {(menu) => (
        <Portal>
          <div
            data-component="context-menu-backdrop"
            class="fixed inset-0 z-[9998] bg-transparent"
            onContextMenu={(e) => {
              e.preventDefault();
              if (Date.now() - openedAt >= 150) props.onClose();
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (Date.now() - openedAt >= 200) props.onClose();
            }}
          />
          <div
            ref={menuRef}
            role="menu"
            data-component="context-menu"
            style={{
              left: `${coords().left}px`,
              top: `${coords().top}px`,
            }}
            class="fixed z-[9999] min-w-[200px] max-w-[272px] p-1 rounded-xl border border-[var(--cm-hairline-strong)] bg-[var(--cm-surface)] dark:bg-[var(--cm-surface-2)] shadow-[var(--cm-shadow-lg)] select-none animate-[cm-context-in_0.12s_ease-out]"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Show when={menu().title}>
              <div class="px-2.5 pt-1.5 pb-1.5 mb-0.5 border-b border-[var(--cm-hairline)]">
                <div class="text-[11px] font-medium text-gray-500 dark:text-gray-400 truncate">
                  {menu().title}
                </div>
              </div>
            </Show>
            <div class="space-y-0.5">
              <For each={menu().items}>
                {(item) => (
                  <>
                    <Show when={item.separatorBefore}>
                      <div class="my-1 border-t border-[var(--cm-hairline)]" />
                    </Show>
                    <Show
                      when={confirmingId() === item.id}
                      fallback={
                        <button
                          type="button"
                          role="menuitem"
                          data-menu-item={item.id}
                          disabled={item.disabled}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (item.disabled) return;
                            if (item.confirmLabel) {
                              setConfirmingId(item.id);
                              return;
                            }
                            props.onClose();
                            item.onSelect();
                          }}
                          class={`w-full flex items-center gap-2.5 px-2.5 min-h-[34px] [@media(pointer:coarse)]:min-h-[40px] rounded-lg text-left text-[13px] [@media(pointer:coarse)]:text-[14px] transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${
                            item.danger
                              ? "text-red-600 dark:text-red-400 hover:bg-red-500/10 active:bg-red-500/15"
                              : "text-gray-700 dark:text-gray-200 hover:bg-gray-900/[0.05] dark:hover:bg-white/[0.07] active:bg-gray-900/[0.08] dark:active:bg-white/[0.1]"
                          }`}
                        >
                          <Show when={item.icon}>
                            <span class="w-4 h-4 flex items-center justify-center shrink-0 opacity-85">
                              {item.icon}
                            </span>
                          </Show>
                          <span class="flex-1 truncate">{item.label}</span>
                        </button>
                      }
                    >
                      <div class="flex items-center gap-1.5 px-2.5 py-1 min-h-[34px] [@media(pointer:coarse)]:min-h-[42px]">
                        <button
                          type="button"
                          data-menu-confirm={item.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onClose();
                            item.onSelect();
                          }}
                          class="flex-1 min-h-[28px] [@media(pointer:coarse)]:min-h-[34px] px-2.5 rounded-lg text-xs font-medium text-white bg-red-500 hover:bg-red-600 active:bg-red-700 transition-colors"
                        >
                          {item.confirmLabel}
                        </button>
                        <button
                          type="button"
                          data-menu-cancel={item.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmingId(null);
                          }}
                          class="min-h-[28px] [@media(pointer:coarse)]:min-h-[34px] px-2.5 rounded-lg text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                        >
                          {item.cancelLabel}
                        </button>
                      </div>
                    </Show>
                  </>
                )}
              </For>
            </div>
          </div>
          <style>{`
            @keyframes cm-context-in {
              from { opacity: 0; transform: scale(0.96); }
              to { opacity: 1; transform: scale(1); }
            }
          `}</style>
        </Portal>
      )}
    </Show>
  );
}
