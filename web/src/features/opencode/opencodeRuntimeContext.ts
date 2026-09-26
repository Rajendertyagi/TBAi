import { createContext, useContext } from "react";

/**
 * Runtime-scoped OpenCode values the composer surface needs but cannot derive
 * from the route or the assistant-ui runtime.
 *
 * The Shield chip (rendered deep inside the OpenCode runtime provider) needs
 * the real OpenCode `sessionId` and the runtime's reconcile seam to call
 * `persistAutoApprove`. Both live in `OpenCodeView`'s `AgentRuntime`, which
 * owns the runtime client — so they are provided here rather than threaded
 * through `ChatWindow`/`Composer` props (which stay engine-agnostic).
 *
 * `null` means "no OpenCode runtime" — the welcome draft, or any non-Code
 * surface. Consumers must treat null as "no session" and never call
 * auto-approval runtime functions without one.
 */
export interface OpenCodeRuntimeContextValue {
  /** The OpenCode session that owns this runtime. */
  sessionId: string;
  /** The runtime's reconcile seam (from `useOpenCodeRuntime`). */
  reconcileAutoApprove?: () => Promise<number>;
  /**
   * The session's directory scope (from the backend session seam), or null
   * when the server did not report one. Directory-scoped calls omit it
   * rather than guessing a path.
   */
  directory?: string | null;
  /**
   * The session's current provider/model (the runtime's prompt-level
   * defaults). Absent while unresolved — callers then let the server
   * default apply rather than guessing.
   */
  providerID?: string;
  modelID?: string;
  /** Native V2 compaction admission seam. */
  compact?: () => Promise<void>;
  /** Native V2 selection and recovery seams. */
  setDesiredSelection?: (selection: { model: { providerID: string; modelID: string; variant?: string } | null; agent: string | null }) => void;
  reconcileStagedRevert?: () => Promise<void>;
  /** The optional live model variant selected by the native runtime. */
  variant?: string;
}

export const OpenCodeRuntimeContext = createContext<OpenCodeRuntimeContextValue | null>(null);

/**
 * Reads the ambient OpenCode runtime context.
 *
 * @returns The session id + reconcile seam, or `null` outside a Code surface.
 */
export function useOpenCodeRuntimeContext(): OpenCodeRuntimeContextValue | null {
  return useContext(OpenCodeRuntimeContext);
}