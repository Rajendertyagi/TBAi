"use client";

import { useEffect } from "react";
import type { AppendMessage } from "@assistant-ui/react";
import { createV2MessageId, attachV2PromptMessageId } from "./v2ThreadController";
import { useAuiState } from "@assistant-ui/react";
import {
  claimPendingFirstMessage,
  clearPendingFirstMessage,
  peekPendingFirstMessage,
  setPendingFirstMessageIdentity,
  unclaimPendingFirstMessage,
} from "@/features/chat/state/pendingFirstMessage";
import { logger } from "@/lib/logger";
import { startOperation, type OperationHandle } from "@/lib/operation";

/**
 * First-prompt handoff boundary for OpenCode code mode.
 *
 * The stashed draft prompt may only enter the runtime AFTER the runtime's
 * main thread is actually bound to the bootstrapped OpenCode session id.
 * Firing while the main thread is still the TBAi draft thread would send the
 * prompt to the wrong conversation and could race the native runtime's first
 * thread switch or append.
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
 * The handoff as ONE operation.
 *
 * Deliberately NOT ended when the prompt is accepted: the accepted prompt is
 * what triggers the session's first run, so the requests that follow (session
 * bootstrap, prompt dispatch, SSE) belong to the same user action. It is ended
 * when the view that owns it goes away, which bounds it without pretending the
 * run is over the moment the text is handed over.
 */
let handoffOperation: OperationHandle | null = null;

function beginHandoffOperation(): void {
  handoffOperation?.end("superseded");
  handoffOperation = startOperation("opencode.first_prompt");
}

/** End the handoff operation (view unmount, session change, or failure). */
export function endHandoffOperation(reason: string): void {
  const op = handoffOperation;
  if (!op) return;
  handoffOperation = null;
  op.end(reason);
}

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
  sendWithId?: (message: AppendMessage) => Promise<unknown> | unknown;
}): Promise<FirstPromptHandoffOutcome> {
  const { conversationId, sessionId, boundSessionId, append, sendWithId } = args;
  if (!conversationId || !sessionId) return "skipped";
  if (boundSessionId !== sessionId) {
    // The staged prompt exists but the runtime's main thread is not bound to
    // the session yet. This was the invisible half of the historical
    // first-send bug: debug level, because it is re-evaluated on every render
    // until the binding settles.
    logger.debug("opencode", "handoff.not_bound", {
      conversationId,
      sessionId,
      boundSessionId: boundSessionId ?? null,
    });
    return "skipped";
  }
  const text = claimPendingFirstMessage(conversationId);
  if (!text) {
    logger.debug("opencode", "handoff.no_pending", { conversationId, sessionId });
    return "none";
  }
  beginHandoffOperation();
  logger.info("opencode", "handoff.start", { conversationId, sessionId });
  const claimedEntry = peekPendingFirstMessage(conversationId);
  const messageId = claimedEntry?.messageId ?? createV2MessageId();
  setPendingFirstMessageIdentity(conversationId, messageId);
  try {
    if (sendWithId) {
      await sendWithId(attachV2PromptMessageId({ role: "user", content: [{ type: "text", text }], parentId: null, sourceId: null, runConfig: undefined, createdAt: new Date(), metadata: { custom: {} } }, messageId));
    } else {
      await append(text);
    }
  } catch (err) {
    unclaimPendingFirstMessage(conversationId);
    logger.warn("opencode", "handoff.failed", {
      conversationId,
      sessionId,
      errorType: err instanceof Error ? err.name : typeof err,
    });
    endHandoffOperation("failed");
    return "failed";
  }
  clearPendingFirstMessage(conversationId);
  // Accepted, not finished: the operation stays open for the run it starts.
  logger.info("opencode", "handoff.accepted", { conversationId, sessionId });
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
  sendWithId,
}: {
  /** The TBAi conversation that owns the stashed first prompt. */
  conversationId: string | undefined;
  /** The bootstrapped OpenCode session the main thread must be bound to. */
  sessionId: string;
  /** The session-bound OpenCode runtime (stable object, never re-created). */
  runtime: { thread: { append: (text: string) => unknown } };
  sendWithId?: (message: AppendMessage) => Promise<unknown> | unknown;
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
      sendWithId,
    });
  }, [runtime, sendWithId, boundSessionId, conversationId, sessionId]);

  // Bound the handoff operation to the view that owns it, so a run it started
  // stops inheriting the operation once the session surface is gone.
  useEffect(() => () => endHandoffOperation("view-unmounted"), [sessionId]);

  return null;
}
