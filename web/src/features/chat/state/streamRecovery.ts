/**
 * Recovery state for a Direct run the app cannot finish (Phase 3).
 *
 * Owns ONE question: after an error, did a run die with the app, and may the
 * user safely re-send it? The answer is never guessed from client state.
 *
 * Why the server is asked (design §12 could not be met as written): the
 * installed AI SDK's `makeRequest` never rejects — a failed reconnect is
 * swallowed at `ai/dist/index.js:19176` and an errored replayed stream at
 * `:19273` — so the transport's `onResumeError` hook is unreachable and the
 * durable reason cannot be read off the error path. `/api/chat/stream-status`
 * projects the row the resume protocol already replays, so there is still one
 * source of truth.
 *
 * The safety rule (design §13): Retry is offered ONLY for a run the server
 * reports as `interrupted`. That is the one terminal kind that can only arise
 * when the process died mid-run, so it is self-filtering — a send that just
 * failed reports `failed`/`cancelled` and produces no strip, and a run that
 * actually completed reports `completed` and can never be retried into a second
 * assistant message. If the status cannot be read, `canRetry` is false: the
 * strip explains, and offers nothing.
 */

import { create } from "zustand";

/** Why a run cannot be shown as finished. Mirrors the server's terminal axis. */
export type StreamRecoveryReason = "interrupted" | "unavailable";

export interface StreamRecoveryState {
  threadId: string;
  /** The run the verdict came from, or null when the status was unreadable. */
  streamId: string | null;
  reason: StreamRecoveryReason;
  /** True only when the server confirmed the run is safe to re-send. */
  canRetry: boolean;
  /**
   * The user's prompt, captured while it was still in memory.
   *
   * It cannot be recovered later: the browser's history write for the user
   * message happens while the server is down, so a crashed run leaves NO user
   * message in SQLite and nothing to re-send. Retry is therefore offered only
   * when this is non-empty — an empty prompt must never become an empty message.
   */
  prompt: string;
  at: number;
}

interface StreamRecoveryStore {
  /** Latest recovery state per thread; a thread without one shows nothing. */
  byThread: Record<string, StreamRecoveryState | undefined>;
  report: (state: StreamRecoveryState) => void;
  clear: (threadId: string) => void;
  clearAll: () => void;
}

/** Pending re-read timers, one per thread. Cancelled whenever a thread settles. */
const recheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** How many attempts each thread has spent, so the chain is bounded. */
const recheckAttempts = new Map<string, number>();

/**
 * Backoff for re-reading an unconfirmed verdict.
 *
 * A crash is always detected while the backend is DOWN, so the first status read
 * is guaranteed to fail and the notice starts unconfirmed. Something has to ask
 * again once the backend is back.
 *
 * This chain is deliberately NOT the availability poller. That one answers "is
 * the backend reachable?" for the whole app; this one answers "has this
 * conversation's run verdict arrived?" for one thread. Keying the re-read off a
 * reachability *transition* was tried and does not work: the transition can be
 * missed entirely (observed live — a single `/readyz` poll across a crash and a
 * restart), and a recovery feature that silently stalls on a sibling subsystem's
 * edge case is not durable. So this converges on its own, with a bounded number of
 * attempts.
 */
const RECHECK_DELAYS_MS = [1_500, 3_000, 6_000, 12_000, 25_000] as const;

/**
 * Cadence override. Exists so the convergence loop is testable without waiting
 * ~48 real seconds, and so the backoff is stated in one obvious place.
 */
let recheckDelaysMs: readonly number[] = RECHECK_DELAYS_MS;

/** Test-only: shorten (or lengthen) the re-read backoff. Pass null to restore. */
export function setRecheckDelaysForTests(delays: readonly number[] | null): void {
  recheckDelaysMs = delays ?? RECHECK_DELAYS_MS;
  if (delays === null) {
    recheckTimers.clear();
    recheckAttempts.clear();
  }
}

function cancelRechecks(threadId: string): void {
  const timer = recheckTimers.get(threadId);
  if (timer !== undefined) {
    clearTimeout(timer);
    recheckTimers.delete(threadId);
  }
  recheckAttempts.delete(threadId);
}

/**
 * The ONE place a re-read is scheduled. `resolveStreamRecovery` calls this
 * whenever it ends up with an unconfirmed verdict, so the chain has a single
 * owner — two schedulers produced duplicate timers and an unbounded loop.
 */
function scheduleRecheck(threadId: string, prompt: string, fetchImpl: FetchLike): void {
  const attempt = recheckAttempts.get(threadId) ?? 0;
  const delay = recheckDelaysMs[attempt];
  if (delay === undefined) {
    // Attempts exhausted. The unconfirmed notice stays for the user; it simply
    // stops asking.
    return;
  }
  recheckAttempts.set(threadId, attempt + 1);
  cancelTimerOnly(threadId);
  const timer = setTimeout(() => {
    recheckTimers.delete(threadId);
    // `assumeRun` stays true: this thread already demonstrated a failed run, so an
    // unreadable status must not be re-read as "no evidence" and erase the notice
    // this chain exists to upgrade. Resolving re-schedules only if still unknown.
    void resolveStreamRecovery(threadId, prompt, { assumeRun: true, fetchImpl });
  }, delay);
  recheckTimers.set(threadId, timer);
}

function cancelTimerOnly(threadId: string): void {
  const timer = recheckTimers.get(threadId);
  if (timer !== undefined) {
    clearTimeout(timer);
    recheckTimers.delete(threadId);
  }
}

export const useStreamRecoveryStore = create<StreamRecoveryStore>((set) => ({
  byThread: {},
  report: (state) => set((s) => ({ byThread: { ...s.byThread, [state.threadId]: state } })),
  clear: (threadId) => {
    cancelRechecks(threadId);
    set((s) => {
      if (s.byThread[threadId] === undefined) return s;
      const next = { ...s.byThread };
      delete next[threadId];
      return { byThread: next };
    });
  },
  clearAll: () => {
    for (const threadId of [...recheckTimers.keys()]) cancelRechecks(threadId);
    set({ byThread: {} });
  },
}));

/** The server's durable projection of one run. Every field is a safe scalar. */
export interface StreamStatus {
  streamId: string;
  status: "streaming" | "done" | "error" | "missing";
  terminalKind: "completed" | "failed" | "cancelled" | "interrupted" | null;
  restarted: boolean;
  historyState: "pending" | "claimed" | "done" | "skipped" | null;
  chunkCount: number;
  byteLen: number;
  ageMs: number;
  finalizedAgeMs: number | null;
}

/** The endpoint's envelope: `run` is null for a conversation that has none. */
interface StreamStatusEnvelope {
  run: StreamStatus | null;
}

/**
 * Decide what the user is offered, from the server's answer alone.
 *
 * `interrupted` is the only reason that permits a Retry: the process died
 * mid-run, so the reply is genuinely unfinished and a NEW run cannot duplicate a
 * finished one. Everything else — including every failure to read the status —
 * is reported without a Retry, because offering one on an unconfirmed run is the
 * one failure mode that creates a duplicate assistant message.
 */
export function classifyStreamStatus(
  status: Pick<StreamStatus, "terminalKind"> | null,
  prompt = "",
): { reason: StreamRecoveryReason; canRetry: boolean } {
  // `interrupted` alone is not enough: without the prompt there is nothing to
  // re-send, and offering a Retry that silently does nothing is worse than
  // offering none.
  if (status?.terminalKind === "interrupted" && prompt.trim().length > 0) {
    return { reason: "interrupted", canRetry: true };
  }
  return {
    reason: status?.terminalKind === "interrupted" ? "interrupted" : "unavailable",
    canRetry: false,
  };
}

/**
 * The narrow fetch surface used here. Deliberately not `typeof fetch`: this
 * module only ever issues one GET and never touches `preconnect`, and a seam
 * that can be a plain async function is one a test can supply honestly.
 */
export type FetchLike = (input: string) => Promise<Response>;

/**
 * Read a run's durable status by CONVERSATION.
 *
 * The conversation is the durable key, and that is the entire point. A resumable
 * stream pointer cannot be relied on: the transport clears it when a send fails
 * (before the failure is reported) and it does not survive an app restart, so a
 * client that can only ask about a stream id it happens to still hold cannot
 * recognise a dead run. A conversation id is always known.
 *
 * Returns null both for "this conversation has no run" and for "the status could
 * not be read". They are deliberately the same answer: both mean *unconfirmed*,
 * and unconfirmed must never authorise a Retry.
 */
export async function fetchConversationRunStatus(
  conversationId: string,
  fetchImpl: FetchLike = (input) => fetch(input),
): Promise<StreamStatus | null> {
  try {
    const res = await fetchImpl(
      `/api/chat/stream-status?conversationId=${encodeURIComponent(conversationId)}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as StreamStatusEnvelope;
    return body.run ?? null;
  } catch {
    return null;
  }
}

export interface ResolveRecoveryOptions {
  /**
   * True when the caller KNOWS a run was in flight — a send or resume that just
   * failed. False when the caller is merely asking ("what happened on this
   * thread?").
   *
   * This distinction is the whole reason an unreadable status is not simply
   * "nothing happened": a failure detected while the backend is DOWN is exactly
   * when the status cannot be read, and erasing the notice there would leave the
   * later recovery check with nothing to re-check. Observed live as a crash that
   * produced no recovery state at all, and then no Retry once the server came back.
   */
  assumeRun?: boolean;
  fetchImpl?: FetchLike;
}

/**
 * Resolve a conversation's run against the server and publish the recovery state.
 *
 * Never throws. Returns the status so the caller can decide separately whether
 * the run is still worth resuming.
 */
export async function resolveStreamRecovery(
  threadId: string,
  prompt = "",
  options: ResolveRecoveryOptions = {},
): Promise<{ state: StreamRecoveryState; status: StreamStatus | null }> {
  const { assumeRun = false, fetchImpl = (input: string) => fetch(input) } = options;
  const status = await fetchConversationRunStatus(threadId, fetchImpl);
  const { reason, canRetry } = classifyStreamStatus(status, prompt);
  const state: StreamRecoveryState = {
    threadId,
    streamId: status?.streamId ?? null,
    reason,
    canRetry,
    prompt,
    at: Date.now(),
  };

  if (status && status.status !== "streaming") {
    // The durable answer: this conversation's last run is terminal, and the user
    // needs to know how it ended.
    useStreamRecoveryStore.getState().report(state);
  } else if (status) {
    // A `streaming` run is a healthy run in progress — not a recovery, and the
    // strip must not appear over a reply that is still arriving.
    useStreamRecoveryStore.getState().clear(threadId);
  } else if (assumeRun) {
    // Unreadable, but a run was demonstrably in flight. Keep an UNCONFIRMED notice
    // so the user is told something and no Retry is offered, and keep asking:
    // this read is what upgrades the notice to a real Retry once the backend can
    // answer, and the backend is exactly what just died.
    useStreamRecoveryStore.getState().report(state);
    scheduleRecheck(threadId, prompt, fetchImpl);
  } else {
    // No evidence at all: a thread nobody asked a question on, or a status we
    // simply could not read. Publishing here would nag on every fresh thread.
    useStreamRecoveryStore.getState().clear(threadId);
  }
  return { state, status };
}
