import type { EngineType, SessionSourceState, UnifiedSession } from "../../../src/types/unified";

export interface CreateSessionSourceOptions {
  useWorktree?: boolean;
}

export interface SessionSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): SessionSourceState;
  setEnabled(enabled: boolean): Promise<SessionSourceState>;
  createSession?(
    engineType: EngineType | undefined,
    directory: string,
    options?: CreateSessionSourceOptions,
  ): Promise<UnifiedSession>;
}
