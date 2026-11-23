import type { JSX } from "solid-js";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: JSX.Element;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  onSelect: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  title?: string;
  items: ContextMenuItem[];
}

export interface ContextMenuTriggerHandlers {
  onContextMenu: (e: MouseEvent) => void;
  onTouchStart: (e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: (e: TouchEvent) => void;
  onTouchCancel: () => void;
  onClickCapture: (e: MouseEvent) => void;
}

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;

function isInteractiveControl(target: EventTarget | null): boolean {
  return typeof Element !== "undefined"
    && target instanceof Element
    && Boolean(target.closest("input, textarea, select, a, [data-no-context-menu]"));
}

function isInlineButtonControl(target: EventTarget | null, currentTarget: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  const button = target.closest("button");
  return Boolean(button && button !== currentTarget);
}

export function computeContextMenuPosition(
  anchor: { x: number; y: number },
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 12,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewport.width - menuSize.width - margin);
  const left = Math.min(Math.max(margin, anchor.x), maxLeft);
  const fitsBelow = anchor.y + menuSize.height + margin <= viewport.height;
  const preferredTop = !fitsBelow && anchor.y - menuSize.height - 8 >= margin
    ? anchor.y - menuSize.height - 8
    : anchor.y + 4;
  const maxTop = Math.max(margin, viewport.height - menuSize.height - margin);
  const top = Math.min(Math.max(margin, preferredTop), maxTop);
  return { left, top };
}

/**
 * Binds both desktop right-click (`contextmenu`) and mobile touch long-press
 * to open the same ContextMenu without interfering with scrolling or clicks.
 */
export function createContextMenuTrigger(
  getMenu: () => { title?: string; items: ContextMenuItem[] } | null,
  openMenu: (state: ContextMenuState) => void,
): ContextMenuTriggerHandlers {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0;
  let startY = 0;
  let longPressFired = false;
  let suppressClickUntil = 0;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    onContextMenu(e: MouseEvent) {
      if (isInteractiveControl(e.target) || isInlineButtonControl(e.target, e.currentTarget)) return;
      const menu = getMenu();
      if (!menu) return;
      const visibleItems = menu.items.filter(Boolean);
      if (visibleItems.length === 0) return;
      clearTimer();
      e.preventDefault();
      e.stopPropagation();
      let x = e.clientX;
      let y = e.clientY;
      if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
        const el = e.currentTarget instanceof Element ? e.currentTarget : (e.target instanceof Element ? e.target : null);
        const rect = el?.getBoundingClientRect();
        x = rect ? rect.left + 16 : 16;
        y = rect ? rect.bottom : 16;
      }
      openMenu({ x, y, title: menu.title, items: visibleItems });
    },
    onTouchStart(e: TouchEvent) {
      clearTimer();
      longPressFired = false;
      if (e.touches.length !== 1) return;
      if (isInteractiveControl(e.target) || isInlineButtonControl(e.target, e.currentTarget)) return;
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      timer = setTimeout(() => {
        timer = undefined;
        const menu = getMenu();
        if (!menu || menu.items.length === 0) return;
        longPressFired = true;
        suppressClickUntil = Date.now() + 800;
        try { navigator.vibrate?.(10); } catch { /* Optional tactile feedback */ }
        openMenu({ x: startX, y: startY, title: menu.title, items: menu.items });
      }, LONG_PRESS_MS);
    },
    onTouchMove(e: TouchEvent) {
      if (timer === undefined) return;
      if (e.touches.length !== 1) {
        clearTimer();
        return;
      }
      const touch = e.touches[0];
      if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > MOVE_CANCEL_PX) {
        clearTimer();
      }
    },
    onTouchEnd(e: TouchEvent) {
      clearTimer();
      if (longPressFired) {
        longPressFired = false;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      }
    },
    onTouchCancel() {
      clearTimer();
      longPressFired = false;
    },
    onClickCapture(e: MouseEvent) {
      if (Date.now() < suppressClickUntil) {
        suppressClickUntil = 0;
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}
