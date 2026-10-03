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

/**
 * Part types that carry nothing the user can read, read off the INSTALLED SDK.
 *
 * `streamText(...).fullStream` yields `TextStreamPart`, whose lifecycle vocabulary is
 * `start` / `start-step` / `finish-step` — NOT `stream-start` / `step-start`. Getting
 * this wrong is silent and self-defeating: the first `start` part is then classified as
 * model-visible, `committed` flips before the provider has rejected anything, and the
 * gate refuses recovery by its own fail-closed rule. The guard behaves correctly; the
 * vocabulary feeding it does not.
 *
 * Read from `node_modules/ai` rather than assumed, because this exact mistake was made
 * once already and cost a full wiring attempt.
 */
export const LIFECYCLE_PART_TYPES: ReadonlySet<string> = new Set([
  "start",
  "start-step",
  "finish-step",
]);

/**
 * ⚠️ THE ROUTE MUST NOT WIRE THIS GATE YET.
 *
 * The stream-level logic below is proven, but one blocker remains, and it is NOT
 * visible from inside this module:
 *
 * `streamText`'s own `onError` callback fires when the provider REJECTS — before the
 * error part reaches this gate. So a route that lets an attempt's `onError` publish
 * terminal state (settle the run, log `ai.error`, set `originalStreamError`) will
 * publish the failure of an attempt this gate is about to discard. A `discardedAttempt`
 * flag cannot fix this, because the callback has already run by the time the flag could
 * be set.
 *
 * The fix is an ownership change in the route, not here: an attempt's `onError` must
 * CAPTURE its error locally, and this gate must be the authority that publishes it for
 * the surviving attempt only. Before doing that, the route must establish whether the
 * composed `createUIMessageStream.onError` fires for a forwarded provider `error` chunk
 * — if it does not, moving publication out of the attempt callback would silently lose
 * terminal error logging for ordinary provider errors.
 */

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
  /**
   * Called immediately BEFORE an attempt's error part is forwarded, for the attempt the
   * gate has decided to KEEP.
   *
   * This is the gate's publication authority. The route's attempt-level `onError` cannot
   * do this itself: `streamText` invokes it when the provider rejects, which is BEFORE
   * the error part reaches this gate, so at that moment nobody yet knows whether the
   * attempt will be discarded. Publishing there announces the failure of an attempt that
   * is about to be thrown away; publishing here — after the decision — is what makes a
   * discarded attempt genuinely silent while leaving an ordinary provider error on
   * exactly the path it always had.
   */
  readonly onFinalError?: (attempt: number, error: unknown) => void;
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
          // The attempt is FINAL, so this is the one moment its error becomes the
          // logical request's terminal state.
          input.onFinalError?.(state.attempt, partError);
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
        // NOTE: `held` is deliberately NOT cleared yet. If recovery fails, this attempt
        // becomes final after all, and its markers must still reach the client — dropping
        // them here would emit a terminal `error` with no preceding `start`, which is not
        // a well-formed UI message stream.

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
          // secondary failure that hides the real cause. It is final, so it publishes.
          input.onFinalError?.(state.attempt, partError);
          yield* held;
          yield value;
          return;
        }

        input.onEvent?.({ type: "retry_started", attempt: MAX_PROVIDER_ATTEMPTS });
        // Recovery succeeded, so this attempt really is discarded: its markers go, and
        // attempt 2 emits its own.
        held = [];
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
