/**
 * Bounded provider-overflow recovery for the Direct path.
 *
 * ## What this is
 *
 * The gate sits between a provider attempt and `toUIMessageStream`. It presents the
 * downstream pipeline with ONE logical stream, chosen from at most TWO provider
 * attempts:
 *
 * ```text
 *   startAttempt(1) ──► raw parts ──┬─ model-visible ──► commit, stream normally
 *                                    │
 *                                    └─ context_overflow ──► discard attempt 1
 *                                                          ──► recover() (compact + rebuild)
 *                                                          ──► startAttempt(2) ──► stream
 * ```
 *
 * ## Why it sits HERE and not around the UI stream
 *
 * Measured, not assumed (A0 spike, `tests/integration/direct-overflow-recovery.test.ts`):
 * the composed UI stream's `onError` already calls `settleRun("failed")` and emits the
 * terminal error chunk. So once an error chunk exists, the logical run has been settled
 * and the client has been told the turn failed. Recovering after that point would show
 * the user an error and then an answer for one turn.
 *
 * Gating the RAW provider stream instead means the composed `onError`/`onEnd` only ever
 * observe the attempt that is actually kept. That is what makes "no duplicate assistant
 * persistence" structural rather than something needing rollback.
 *
 * ## Why holding lifecycle markers is safe
 *
 * A0 established that a provider overflow surfaces as `stream-start` (and the route's
 * own progress chunk) and THEN the error — with no assistant-visible content in
 * between. A client that has seen only lifecycle markers has not been told anything
 * about the answer, so those markers may be held and replayed.
 *
 * That is a MEASURED property, not an assumption, and `committed` flips permanently at
 * the first non-lifecycle part. If a future provider emits content before rejecting,
 * this gate commits first and recovery simply does not trigger — the user sees one
 * normal turn, not two answers. Failing closed is the only safe direction here.
 *
 * ## The bound
 *
 * `decideOverflowRecovery` is the sole authority on whether a second attempt may happen
 * (see `src/context/recovery.ts`). This module never re-derives that policy, and never
 * permits a third attempt: after attempt 2, any failure is passed through as-is.
 */

import type { OverflowRecoveryDecision } from "../context/recovery";

/** Attempts this gate will ever make. The second is the recovery; there is no third. */
export const MAX_PROVIDER_ATTEMPTS = 2;

/** A diagnostic event, safe to log: no content, no credentials, no provider bodies. */
export type OverflowGateEvent =
  | { readonly type: "attempt_started"; readonly attempt: number }
  | { readonly type: "overflow_detected"; readonly attempt: number }
  | {
      readonly type: "recovery_decided";
      readonly attempt: number;
      readonly outcome: OverflowRecoveryDecision["outcome"];
      readonly shouldRecover: boolean;
    }
  | { readonly type: "recovery_failed"; readonly attempt: number; readonly failure: string }
  | { readonly type: "retry_started"; readonly attempt: number }
  | {
      readonly type: "recovery_unavailable";
      readonly attempt: number;
      readonly reason: "visible_content_already_committed";
    };

export interface OverflowRecoveryGateInput<TPart> {
  /**
   * Start one provider attempt and return its RAW part stream.
   *
   * Called at most twice. Attempt 2 must reflect the context rebuilt by `recover`.
   */
  readonly startAttempt: (attempt: number) => ReadableStream<TPart>;
  /** The error a part carries, or `undefined` when it is not an error part. */
  readonly isErrorPart: (part: TPart) => unknown | undefined;
  /** Whether a part is a replayable lifecycle marker carrying no model-visible content. */
  readonly isLifecyclePart: (part: TPart) => boolean;
  /** The existing bounded policy. Never re-implemented here. */
  readonly decide: (error: unknown) => OverflowRecoveryDecision;
  /**
   * Compact and rebuild, using the existing assembly seam.
   *
   * Rejecting means recovery did not happen; the original overflow is then surfaced
   * unchanged rather than being replaced by a confusing secondary failure.
   */
  readonly recover: () => Promise<void>;
  /**
   * Neutralise a discarded attempt's own callbacks.
   *
   * Called BEFORE `recover`, so the attempt that is being thrown away can no longer
   * settle the logical run, log a terminal provider error, or record usage.
   */
  readonly onAttemptDiscarded?: (attempt: number) => void;
  /** Structured diagnostics. */
  readonly onEvent?: (event: OverflowGateEvent) => void;
}

/** A reader plus the attempt it belongs to, so a swap cannot desynchronise the two. */
interface AttemptState<TPart> {
  readonly attempt: number;
  readonly reader: ReadableStreamDefaultReader<TPart>;
}

/**
 * Select at most two provider attempts behind one logical stream.
 *
 * @returns A single stream of the winning attempt's parts. Pure with respect to
 *          everything downstream: no error from a discarded attempt is ever forwarded.
 */
export function withOverflowRecovery<TPart>(
  input: OverflowRecoveryGateInput<TPart>,
): ReadableStream<TPart> {
  async function* select(): AsyncGenerator<TPart> {
    /** Lifecycle markers seen since the last commit point. Bounded by design. */
    let held: TPart[] = [];
    /** Flips permanently at the first model-visible part. After this, no recovery. */
    let committed = false;

    let state: AttemptState<TPart> = beginAttempt(1);

    function beginAttempt(attempt: number): AttemptState<TPart> {
      input.onEvent?.({ type: "attempt_started", attempt });
      return { attempt, reader: input.startAttempt(attempt).getReader() };
    }

    for (;;) {
      const { done, value } = await state.reader.read();

      if (done) {
        // The winning attempt ended normally. Anything still held is a marker the
        // client never saw, so it is replayed now to keep the stream well-formed.
        yield* held;
        return;
      }

      const partError = input.isErrorPart(value);

      if (partError !== undefined) {
        input.onEvent?.({ type: "overflow_detected", attempt: state.attempt });
        const decision = input.decide(partError);
        input.onEvent?.({
          type: "recovery_decided",
          attempt: state.attempt,
          outcome: decision.outcome,
          shouldRecover: decision.shouldRecover,
        });

        const recoverable =
          decision.shouldRecover && state.attempt < MAX_PROVIDER_ATTEMPTS && !committed;

        if (!recoverable) {
          // Not eligible, or already committed: the existing failure path, unchanged.
          yield* held;
          yield value;
          return;
        }

        // ── Discard attempt 1 ────────────────────────────────────────────────
        // Order matters. Callbacks are neutralised first so nothing this attempt still
        // has in flight can settle the logical run, then the stream is cancelled so the
        // provider connection is released rather than left dangling.
        input.onAttemptDiscarded?.(state.attempt);
        await state.reader.cancel().catch(() => undefined);
        // Its markers are discarded, not replayed: attempt 2 emits its own.
        held = [];

        try {
          await input.recover();
        } catch (failure) {
          input.onEvent?.({
            type: "recovery_failed",
            attempt: state.attempt,
            failure: failure instanceof Error ? failure.message : String(failure),
          });
          // Recovery is a remedy, not a new verdict. The conversation is still too
          // long, so the ORIGINAL overflow is what the user is told — never a
          // secondary failure that hides the real cause.
          yield* held;
          yield value;
          return;
        }

        input.onEvent?.({ type: "retry_started", attempt: MAX_PROVIDER_ATTEMPTS });
        state = beginAttempt(MAX_PROVIDER_ATTEMPTS);
        continue;
      }

      if (!committed && input.isLifecyclePart(value)) {
        held.push(value);
        continue;
      }

      // First model-visible part: this attempt is the answer. Replay the markers the
      // client has not seen, then stream from here with no further buffering.
      committed = true;
      if (held.length > 0) {
        yield* held;
        held = [];
      }
      yield value;
    }
  }

  const iterator = select();
  return new ReadableStream<TPart>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}
