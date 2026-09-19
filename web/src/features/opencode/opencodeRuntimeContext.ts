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