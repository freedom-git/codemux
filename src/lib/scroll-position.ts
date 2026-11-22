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
