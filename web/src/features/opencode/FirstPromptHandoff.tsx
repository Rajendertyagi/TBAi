"use client";

import { useEffect, useRef, useState } from "react";
import type { AppendMessage } from "@assistant-ui/react";
import { attachV2PromptMessageId } from "./v2ThreadController";
import { useAuiState } from "@assistant-ui/react";
import {
  claimPendingFirstMessage,
  clearPendingFirstMessage,
  markPendingFirstMessageFailed,
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
 * The handoff as ONE operation, bounded to the FIRST run it starts.
 *
 * It stays active through the first run's requests (bootstrap, dispatch, SSE)
 * and is ended as soon as that run settles (isRunning true → false). It must
 * NOT stay active until unmount: `v2Client` attaches the session's current
 * operation id to every request, so a long-lived handoff id would be inherited
 * by later, unrelated prompts in the same session.
 */
const handoffOperations = new Map<string, OperationHandle>();

function beginHandoffOperation(sessionId: string): string {
  handoffOperations.get(sessionId)?.end("superseded");
  const op = startOperation("opencode.first_prompt", sessionId);
  handoffOperations.set(sessionId, op);
  return op.id;
}

/** End the handoff operation for a session (view unmount, session change, or failure). */
export function endHandoffOperation(sessionId: string, reason: string): void {
  const op = handoffOperations.get(sessionId);
  if (!op) return;
  handoffOperations.delete(sessionId);
  op.end(reason);
}

/**
 * Claim → dispatch → clear exactly once for a settled session thread.
 *
 * - Returns "skipped" without touching the stash while the thread is still
 *   the draft (or the session id is unknown): the prompt stays staged.
 * - Returns "none" when there is nothing to dispatch: no stash, or a dispatch
 *   that already failed.
 * - Returns "sent" after the runtime accepts the prompt (stash cleared).
 * - Returns "failed" when the dispatch rejects: the entry is marked FAILED
 *   and is never dispatched again automatically, because the dispatch may
 *   have reached the server (M19).
 *
 * The claim carries the message id, so a dispatch that is resumed after a
 * crash can resume the same logical prompt attempt (M13). TBAi reuses the same
 * message id and does not auto-resubmit on ambiguity; server-side same-ID
 * idempotency is unverified and not relied upon.
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
  const claimed = claimPendingFirstMessage(conversationId);
  if (!claimed) {
    logger.debug("opencode", "handoff.no_pending", { conversationId, sessionId });
    return "none";
  }
  const { text, messageId } = claimed;
  const operationId = beginHandoffOperation(sessionId);
  logger.info("opencode", "handoff.start", { conversationId, sessionId, operationId });
  try {
    if (sendWithId) {
      await sendWithId(
        attachV2PromptMessageId(
          {
            role: "user",
            content: [{ type: "text", text }],
            parentId: null,
            sourceId: null,
            runConfig: undefined,
            createdAt: new Date(),
            metadata: { custom: {} },
          },
          messageId,
        ),
      );
    } else {
      await append(text);
    }
  } catch (err) {
    // The dispatch FAILED, and that is not the same as "the prompt was not
    // sent": the request may have reached the server and only its answer was
    // lost. The entry is therefore marked failed, and a failed entry is never
    // dispatched again automatically - the user's next send replaces it. The
    // old behaviour released the claim, and the next settled observation
    // re-dispatched the same prompt: a message delivered twice (M19).
    markPendingFirstMessageFailed(conversationId);
    logger.warn("opencode", "handoff.failed", {
      conversationId,
      sessionId,
      operationId,
      errorType: err instanceof Error ? err.name : typeof err,
    });
    endHandoffOperation(sessionId, "failed");
    return "failed";
  }
  clearPendingFirstMessage(conversationId);
  // Accepted, not finished: the operation stays open for the run it starts.
  logger.info("opencode", "handoff.accepted", { conversationId, sessionId, operationId });
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
  const isRunning = useAuiState((s) => s.thread.isRunning);
  // The watcher is armed by STATE, not a ref: a ref write does not re-render,
  // so a watcher reading only refs never re-evaluates `isRunning` after dispatch
  // and misses the true→false settle (the original defect). The state carries
  // the session id so a session switch re-arms with a fresh value (a boolean
  // would stay `true` and skip the re-render), and stale state from a previous
  // session cannot end the new session's just-started operation.
  const [armedSession, setArmedSession] = useState<string | null>(null);
  const runObserved = useRef(false);
  const currentSessionRef = useRef(sessionId);
  currentSessionRef.current = sessionId;

  useEffect(() => {
    if (boundSessionId !== sessionId) return;
    void fireFirstPromptHandoff({
      conversationId,
      sessionId,
      boundSessionId: boundSessionId ?? undefined,
      append: (text) => runtime.thread.append(text),
      sendWithId,
    }).then((outcome) => {
      if (outcome !== "sent") return;
      // A dispatch from a session we have since left must not arm the watcher.
      if (currentSessionRef.current !== sessionId) return;
      runObserved.current = false;
      setArmedSession(sessionId);
    });
  }, [runtime, sendWithId, boundSessionId, conversationId, sessionId]);

  // End the handoff operation when the first run it started settles, so later
  // prompts in the same session do not inherit its id. `armedSession` is a
  // dependency so arming re-runs the watcher with the CURRENT isRunning value.
  useEffect(() => {
    if (armedSession !== sessionId) return;
    if (isRunning) {
      runObserved.current = true;
      return;
    }
    if (runObserved.current) {
      setArmedSession(null);
      endHandoffOperation(sessionId, "first-run-complete");
    }
  }, [isRunning, sessionId, armedSession]);

  // Safety net: if the view goes away before the run settles, end the operation
  // for THIS session so it cannot outlive its owner.
  useEffect(() => () => endHandoffOperation(sessionId, "view-unmounted"), [sessionId]);

  return null;
}
