export type SettingsSavedListener = (patch: Record<string, unknown>) => void;

const listeners = new Set<SettingsSavedListener>();

export function onSettingsSaved(listener: SettingsSavedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitSettingsSaved(patch: Record<string, unknown>): void {
  for (const listener of listeners) {
    try {
      listener(patch);
    } catch {
      // Listener errors must not break settings persistence
    }
  }
}
