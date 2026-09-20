"use client";

import { useEffect } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  claimPendingFirstMessage,
  clearPendingFirstMessage,
  unclaimPendingFirstMessage,
} from "@/features/chat/state/pendingFirstMessage";
import { logger } from "@/lib/logger";

/**
 * First-prompt handoff boundary for OpenCode code mode.
 *
 * The stashed draft prompt may only enter the runtime AFTER the runtime's
 * main thread is actually bound to the bootstrapped OpenCode session id.
 * Firing while the main thread is still the TBAi draft thread would invoke
 * the frozen adapter's draft-thread initialize path, which creates a new
 * upstream session (empty session-create body → 400 from the session seam)
 * — or, if the adapter was just replaced, throws
 * `ThreadListAdapterChangedError` for the pending operation.
 *
 * Settled boundary (no timers, no polling): the component subscribes to the
 * main thread identity and fires exactly when
 * `(externalId ?? remoteId) === sessionId`. Claim semantics keep it
 * exactly-once across remounts/reconnects with no second state system.
 */

/** Minimal main-thread identity read from the OpenCode runtime state. */
export interface SessionThreadIdentity {
  remoteId?: string | null;
  externalId?: string | null;
}

/**
 * True only when the runtime's main thread IS the bootstrapped OpenCode
 * session. A draft/unbound thread (or a missing session id) never qualifies.
 */
export function isSessionThreadBound(
  item: SessionThreadIdentity | null | undefined,
  sessionId: string | undefined,
): boolean {
  if (!sessionId) return false;
  return (item?.externalId ?? item?.remoteId ?? undefined) === sessionId;
}

export type FirstPromptHandoffOutcome = "skipped" | "none" | "sent" | "failed";

/**
 * Claim → append → clear/unclaim exactly once for a settled session thread.
 *
 * - Returns "skipped" without touching the stash while the thread is still
 *   the draft (or the session id is unknown): the prompt stays staged.
 * - Returns "none" when a previous attempt already claimed/cleared it.
 * - Returns "sent" after the runtime accepts the prompt (stash cleared).
 * - Returns "failed" when the append rejects: the claim is RELEASED so a
 *   later settled attempt can retry instead of silently losing the prompt.
 */
export async function fireFirstPromptHandoff(args: {
  conversationId: string | undefined;
  sessionId: string | undefined;
  boundSessionId: string | undefined;
  append: (text: string) => Promise<unknown> | unknown;
}): Promise<FirstPromptHandoffOutcome> {
  const { conversationId, sessionId, boundSessionId, append } = args;
  if (!conversationId || !sessionId) return "skipped";
  if (boundSessionId !== sessionId) return "skipped";
  const text = claimPendingFirstMessage(conversationId);
  if (!text) return "none";
  try {
    await append(text);
  } catch (err) {
    unclaimPendingFirstMessage(conversationId);
    logger.warn("opencode", "pending first prompt handoff failed", {
      conversationId,
      errorType: err instanceof Error ? err.name : typeof err,
    });
    return "failed";
  }
  clearPendingFirstMessage(conversationId);
  return "sent";
}

/**
 * Null-render lifecycle boundary. Must be mounted INSIDE the existing
 * session runtime provider so the thread identity is read from the session
 * runtime (never the Direct runtime). Creates no runtime, provider, message,
 * navigation, or network traffic of its own.
 */
export function FirstPromptHandoff({
  conversationId,
  sessionId,
  runtime,
}: {
  /** The TBAi conversation that owns the stashed first prompt. */
  conversationId: string | undefined;
  /** The bootstrapped OpenCode session the main thread must be bound to. */
  sessionId: string;
  /** The session-bound OpenCode runtime (stable object, never re-created). */
  runtime: { thread: { append: (text: string) => unknown } };
}) {
  const boundSessionId = useAuiState(
    (s) => s.threadListItem.externalId ?? s.threadListItem.remoteId,
  );

  useEffect(() => {
    if (boundSessionId !== sessionId) return;
    void fireFirstPromptHandoff({
      conversationId,
      sessionId,
      boundSessionId: boundSessionId ?? undefined,
      append: (text) => runtime.thread.append(text),
    });
  }, [runtime, boundSessionId, conversationId, sessionId]);

  return null;
}
