// Scroll position cache — persists across component mount/unmount cycles
// so navigating away (e.g. Settings) and back restores the scroll position.

const savedScrollPositions = new Map<string, number>();

export type ScrollAction =
  | { action: "restore"; position: number }
  | { action: "scrollToBottom" }
  | { action: "none" };

/**
 * Save scroll position for a session.
 */
export function saveScrollPosition(sessionId: string, scrollTop: number): void {
  savedScrollPositions.set(sessionId, scrollTop);
}

/**
 * Delete scroll position for a session (e.g. when session is deleted).
 */
export function deleteScrollPosition(sessionId: string): void {
  savedScrollPositions.delete(sessionId);
}

/**
 * Decide scroll behavior on component remount (e.g. returning from Settings).
 * Returns saved position if available, otherwise "none".
 */
export function resolveRemountScroll(currentSessionId: string | null): ScrollAction {
  if (!currentSessionId) return { action: "none" };
  const savedPos = savedScrollPositions.get(currentSessionId);
  if (savedPos !== undefined) {
    return { action: "restore", position: savedPos };
  }
  return { action: "none" };
}

/**
 * Decide scroll behavior when switching to a session that already has messages.
 * - Has saved position → restore it
 * - No saved position → scroll to bottom
 */
export function resolveSessionSwitchScroll(sessionId: string): ScrollAction {
  const savedPos = savedScrollPositions.get(sessionId);
  if (savedPos !== undefined) {
    return { action: "restore", position: savedPos };
  }
  return { action: "scrollToBottom" };
}

export function computeLastQuestionScrollTarget(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  viewportTop: number;
  targetTop: number;
  topPadding?: number;
}): number | null {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  if (maxScrollTop <= 24) return null;
  const rawTarget = metrics.scrollTop + (metrics.targetTop - metrics.viewportTop) - (metrics.topPadding ?? 16);
  return Math.min(Math.max(0, rawTarget), maxScrollTop);
}

export function resolveLastQuestionJumpDirection(
  scrollTop: number,
  targetScrollTop: number | null,
  threshold = 32,
): "up" | "down" | null {
  if (targetScrollTop === null || Math.abs(scrollTop - targetScrollTop) <= threshold) {
    return null;
  }
  return targetScrollTop < scrollTop ? "up" : "down";
}

export function shouldShowJumpToLastQuestion(
  scrollTop: number,
  targetScrollTop: number | null,
  threshold = 32,
): boolean {
  return resolveLastQuestionJumpDirection(scrollTop, targetScrollTop, threshold) !== null;
}

export interface MomentumScrollViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  readonly offsetHeight: number;
  style: { overflowY: string };
  scrollTo?: (options: ScrollToOptions) => void;
}

export function setViewportScrollTopInstant(viewport: MomentumScrollViewport, top: number): void {
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const clamped = Math.min(Math.max(0, top), maxScrollTop);
  if (typeof viewport.scrollTo === "function") {
    viewport.scrollTo({ top: clamped, behavior: "instant" });
  }
  viewport.scrollTop = clamped;
}

/**
 * Halts active touch/compositor momentum (inertial) scrolling when jumping
 * programmatically from floating controls outside the scroll container.
 *
 * Temporarily switches `overflow-y` to `hidden` across two animation frames so
 * WebKit (`UIScrollView` in UIProcess) and Blink (`FlingController`) tear down
 * active deceleration velocity before `overflow-y` returns to `auto`.
 */
export function createMomentumJumpController() {
  let lockedViewport: MomentumScrollViewport | null = null;
  let rafId: number | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  };

  const release = () => {
    clearTimers();
    if (!lockedViewport) return;
    const viewport = lockedViewport;
    const currentTop = viewport.scrollTop;
    lockedViewport = null;
    viewport.style.overflowY = "";
    void viewport.offsetHeight;
    setViewportScrollTopInstant(viewport, currentTop);
  };

  const jump = (
    viewport: MomentumScrollViewport,
    getTarget: (vp: MomentumScrollViewport) => number | null,
    onUpdate?: () => void,
  ) => {
    clearTimers();
    if (lockedViewport && lockedViewport !== viewport) {
      release();
    }
    const initialTarget = getTarget(viewport);
    if (initialTarget === null) {
      release();
      return;
    }

    lockedViewport = viewport;
    viewport.style.overflowY = "hidden";
    void viewport.offsetHeight;
    setViewportScrollTopInstant(viewport, initialTarget);
    onUpdate?.();

    const finish = () => {
      clearTimers();
      if (lockedViewport !== viewport) return;
      const fallbackTop = viewport.scrollTop;
      lockedViewport = null;
      viewport.style.overflowY = "";
      void viewport.offsetHeight;
      const finalTarget = getTarget(viewport) ?? fallbackTop;
      setViewportScrollTopInstant(viewport, finalTarget);
      onUpdate?.();
    };

    fallbackTimer = setTimeout(finish, 120);
    rafId = requestAnimationFrame(() => {
      if (lockedViewport !== viewport) return;
      const midTarget = getTarget(viewport);
      if (midTarget !== null) {
        setViewportScrollTopInstant(viewport, midTarget);
      }
      onUpdate?.();
      rafId = requestAnimationFrame(finish);
    });
  };

  return {
    jump,
    release,
    isLocked: () => lockedViewport !== null,
  };
}

