/**
 * The registry of prompts this client has sent and the server has not
 * answered.
 *
 * ## WHAT THIS OWNS
 *
 * The **admission state** of a prompt: whether the server has taken it, what
 * it was admitted as, and the waiters blocked on that answer.
 *
 * ## WHAT THIS DOES NOT OWN
 *
 * - **The verdict.** Only the server can settle a prompt, and only a server
 *   event or a transport result settles one. This module records verdicts; it
 *   never invents them.
 * - **The prompt itself.** Sending it is the controller's business, and the
 *   transport call is the client's.
 * - **The transcript.** An admitted prompt becomes a domain event the
 *   controller dispatches; this module holds no domain state.
 *
 * ## THE FOUR OUTCOMES
 *
 * `admitted` · `definitive-failure` · `ambiguous` · `disposed`.
 *
 * `ambiguous` is the important one: a network result that cannot prove
 * whether the server took the prompt is **not** a rejection. The prompt may
 * still be executing on the server. Phase 5 of the remediation plan settled
 * `ambiguous` by splitting the watchers: the OUTCOME watch accepts "not
 * provably", and the ADMISSION watch does not - the server can still admit
 * the prompt after the request failed, so the client cannot claim it was
 * refused before the server says so. The sender waits on the ADMISSION watch
 * with a deadline, so the send always ends, and it ends with the truth.
 *
 * ## WHY IT IS A REGISTRY AND NOT A FLAG
 *
 * A prompt can be sent before the client knows whether an earlier one landed,
 * and more than one waiter can be waiting on the same prompt. The map is what
 * makes "which prompt is in flight, and what happened to it" a question with
 * one answer.
 *
 * ## WHY THE RECORDS ARE BOUNDED
 *
 * The registry is per-controller, and a long session sends many prompts. A
 * record that is only ever SETTLED - the prompt was answered, and nothing is
 * waiting on it - is evictable: the only question it answers is "what
 * happened to this prompt?", and the server can answer that too.
 *
 * So the settled records are swept by the same policy the controller's other
 * long-lived collections use (`sync/retention.ts`), and a record that still
 * has WAITERS on it is **protected**: evicting it would drop a waiter that
 * would then never be woken.
 *
 * This module was extracted from `v2ThreadController.ts` as part of Phase 2 of
 * the OpenCode runtime remediation plan. The extraction is behaviour
 * preserving: the same outcomes, the same guards, the same timing.
 */

import {
  OPENCODE_V2_RETENTION_CAP,
  OPENCODE_V2_RETENTION_TTL_MS,
} from "@/features/opencode/config";

/** How a prompt's admission ended. */
export type V2PromptAdmissionResult = "admitted" | "definitive-failure" | "ambiguous" | "disposed";

/** What the server admitted a prompt as. */
export type V2PromptSubmission = {
  readonly messageId: string;
  readonly inboxId: string;
  readonly delivery: "steer" | "queue";
};

/**
 * A handle on one prompt's admission.
 *
 * The record behind it is mutable; this view is not. A caller reads the
 * outcome, and never edits the record.
 */
export interface PromptAdmission {
  /** The local message id of the prompt. */
  readonly messageId: string;
  /** The outcome so far, or `null` while the prompt is unadmitted. */
  readonly result: V2PromptAdmissionResult | null;
  /** What the prompt was admitted as, once it was. */
  readonly submission: V2PromptSubmission | null;
}

/** The registry's surface. */
export interface PromptsInFlight {
  /**
   * The admission record for a prompt, created on first use.
   *
   * @param messageId - The local message id of the prompt.
   * @returns The handle for that prompt.
   */
  create(messageId: string): PromptAdmission;
  /**
   * Settles a prompt's admission.
   *
   * A prompt that has already settled is not settled again, except from
   * `ambiguous`, which the reconciler may still resolve.
   *
   * @param messageId - The local message id of the prompt.
   * @param result - The outcome.
   * @param submission - What the prompt was admitted as, when it was.
   */
  settle(messageId: string, result: V2PromptAdmissionResult, submission?: V2PromptSubmission): void;
  /**
   * Records that a prompt's admission cannot be decided from the wire.
   *
   * The prompt is NOT settled by this: the server may still admit it, and an
   * admission that arrives afterwards is the real answer. What this records is
   * that the request itself failed, so a waiter can give up on it.
   *
   * @param messageId - The local message id of the prompt.
   */
  markAmbiguous(messageId: string): void;
  /**
   * Waits for a prompt's admission.
   *
   * @param messageId - The local message id of the prompt.
   * @returns The outcome, immediately if it is already known.
   */
  awaitAdmission(messageId: string): Promise<V2PromptAdmissionResult>;
  /**
   * Waits for a prompt's admission, but not past a deadline.
   *
   * An ambiguous request is not an answer: the server may still admit the
   * prompt, and until it says so the client cannot claim the prompt failed.
   * The deadline is what turns "the wire is silent" into a reported outcome,
   * so a caller is never left waiting on a request that will never be
   * answered.
   *
   * @param messageId - The local message id of the prompt.
   * @param timeoutMs - How long to wait before reporting the ambiguity.
   * @returns The outcome, or `"ambiguous"` when the deadline elapses first.
   */
  awaitAdmissionWithDeadline(
    messageId: string,
    timeoutMs: number,
  ): Promise<V2PromptAdmissionResult>;
  /**
   * The admission record for a prompt, if it has one.
   *
   * @param messageId - The local message id of the prompt.
   * @returns The handle, or `undefined` when the prompt was never sent.
   */
  get(messageId: string): PromptAdmission | undefined;
  /** The number of records held. */
  readonly size: number;
  /** The number of protected records. */
  readonly protectedCount: number;
  /** Settles every prompt in flight as `disposed`. */
  disposeAll(): void;
  /**
   * Runs the retention sweep now.
   *
   * @param now - The current time. Defaults to `Date.now()`.
   * @returns `protected` when records remain over the cap and every one of them
   * has a waiter; `none` otherwise.
   */
  sweep(now?: number): "none" | "protected";
}

type AdmissionRecord = {
  readonly messageId: string;
  result: V2PromptAdmissionResult | null;
  submission: V2PromptSubmission | null;
  /**
   * The watchers of the OUTCOME.
   *
   * They want the verdict, including "ambiguous" - that is the answer to
   * "did the server take it?", and "not provably" is an answer.
   */
  readonly waiters: Set<(result: V2PromptAdmissionResult) => void>;
  /**
   * The watchers of the ADMISSION.
   *
   * They want the prompt to be admitted, and an ambiguous request does not
   * settle that: the server can still admit the prompt after the request
   * failed, and the client cannot claim it was refused before it says so.
   */
  readonly admissionWaiters: Set<(result: V2PromptAdmissionResult) => void>;
};

/**
 * Creates the registry of prompts in flight.
 *
 * @returns The registry.
 */
export function createPromptsInFlight(): PromptsInFlight {
  const admissions = new Map<string, AdmissionRecord>();
  /**
   * When each record was last touched, in insertion order.
   *
   * The map itself cannot be swept by age: `Map` preserves insertion order, and
   * a record that is re-touched does not move to the back. So the age lives
   * here, in a parallel map, and the sweep walks it.
   */
  const touchedAt = new Map<string, number>();
  /** The records that still have a waiter on them, and so cannot be evicted. */
  const protectedIds = new Set<string>();

  /**
   * Evicts the settled records that are over the cap.
   *
   * A record with a waiter is PROTECTED: evicting it would drop a waiter that
   * would then never be woken. A settled record with no waiter is evictable,
   * because the only question it answers is one the server can answer too.
   *
   * @param now - The current time.
   */
  function sweep(now: number = Date.now()): "none" | "protected" {
    // The TTL first: a record nobody has touched in a long time is stale
    // whatever the count.
    for (const [messageId, touched] of [...touchedAt]) {
      if (protectedIds.has(messageId)) continue;
      if (now - touched < OPENCODE_V2_RETENTION_TTL_MS) continue;
      admissions.delete(messageId);
      touchedAt.delete(messageId);
    }
    // Then the cap: the oldest by LAST TOUCH go (not creation order).
    // Build the eviction order once, sorted by touchedAt ascending.
    while (admissions.size > OPENCODE_V2_RETENTION_CAP) {
      let oldest: string | undefined;
      let oldestTouched = Infinity;
      for (const [messageId, touched] of touchedAt) {
        if (protectedIds.has(messageId)) continue;
        if (touched < oldestTouched) {
          oldestTouched = touched;
          oldest = messageId;
        }
      }
      // Every remaining record has a waiter on it. The protection is absolute,
      // so the cap is not honoured.
      if (oldest === undefined) return "protected";
      admissions.delete(oldest);
      touchedAt.delete(oldest);
    }
    return "none";
  }

  function ensure(messageId: string): AdmissionRecord {
    const existing = admissions.get(messageId);
    if (existing) {
      touchedAt.set(messageId, Date.now());
      return existing;
    }
    const record: AdmissionRecord = {
      messageId,
      result: null,
      submission: null,
      waiters: new Set(),
      admissionWaiters: new Set(),
    };
    admissions.set(messageId, record);
    touchedAt.set(messageId, Date.now());
    return record;
  }

  function create(messageId: string): PromptAdmission {
    return view(ensure(messageId));
  }

  function view(record: AdmissionRecord): PromptAdmission {
    return {
      messageId: record.messageId,
      get result(): V2PromptAdmissionResult | null {
        return record.result;
      },
      get submission(): V2PromptSubmission | null {
        return record.submission;
      },
    };
  }

  function settle(
    messageId: string,
    result: V2PromptAdmissionResult,
    submission: V2PromptSubmission | null = null,
  ): void {
    const record = admissions.get(messageId);
    if (!record || (record.result !== null && record.result !== "ambiguous")) return;
    record.result = result;
    record.submission = submission;
    for (const waiter of record.waiters) waiter(result);
    record.waiters.clear();
    for (const waiter of record.admissionWaiters) waiter(result);
    record.admissionWaiters.clear();
    // Settled, and nobody is waiting on it any more, so the record is
    // EVICTABLE. The sweep may now take it.
    protectedIds.delete(messageId);
    // The sweep runs here, because this is where a record becomes settled -
    // which is the only moment it becomes evictable.
    sweep(Date.now());
  }

  function markAmbiguous(messageId: string): void {
    const record = admissions.get(messageId);
    if (!record || record.result !== null) return;
    // The request failed in a way that cannot prove the server refused it. The
    // prompt may still be running there, so this is NOT a settlement: the
    // record stays open, and a later admission still settles it (the server
    // admits a repeated message id as the SAME prompt, so the answer can
    // arrive after the request died).
    //
    // What this does settle is the OUTCOME watch: a waiter that asked "did
    // the server take it?" is told "not provably", and a caller with a
    // deadline stops waiting. The ADMISSION watch is left waiting, because
    // for it "ambiguous" is not an answer but a question.
    record.result = "ambiguous";
    for (const waiter of record.waiters) waiter("ambiguous");
    record.waiters.clear();
    // The ADMISSION watch may still be waiting, so the record stays PROTECTED
    // until that watcher is gone. A record with no watcher left is evictable.
    if (record.admissionWaiters.size === 0) protectedIds.delete(messageId);
    // Bound the registry even when records never settle (all-ambiguous during
    // a network outage). Sweep runs here too, not only on settle().
    sweep(Date.now());
  }

  function awaitAdmission(messageId: string): Promise<V2PromptAdmissionResult> {
    const record = ensure(messageId);
    if (record.result !== null) return Promise.resolve(record.result);
    // A record with a waiter on it is PROTECTED: evicting it would drop a
    // waiter that would then never be woken.
    protectedIds.add(messageId);
    return new Promise((resolve) => record.waiters.add(resolve));
  }

  function awaitAdmissionWithDeadline(
    messageId: string,
    timeoutMs: number,
  ): Promise<V2PromptAdmissionResult> {
    const record = ensure(messageId);
    if (record.result !== null && record.result !== "ambiguous")
      return Promise.resolve(record.result);
    // Protected for the same reason as `awaitAdmission`: a waiter is on it.
    protectedIds.add(messageId);
    return new Promise((resolve) => {
      const wait = (result: V2PromptAdmissionResult) => {
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        record.admissionWaiters.delete(wait);
        resolve("ambiguous");
        // The deadline fired, so the waiter is gone. If it was the last one,
        // the record is settled as far as the client is concerned and becomes
        // evictable.
        if (record.waiters.size === 0 && record.admissionWaiters.size === 0)
          protectedIds.delete(messageId);
      }, timeoutMs);
      record.admissionWaiters.add(wait);
    });
  }

  function get(messageId: string): PromptAdmission | undefined {
    const record = admissions.get(messageId);
    return record ? view(record) : undefined;
  }

  function disposeAll(): void {
    for (const messageId of admissions.keys()) settle(messageId, "disposed");
  }

  return {
    get size() {
      return admissions.size;
    },
    get protectedCount() {
      return protectedIds.size;
    },
    create,
    settle,
    markAmbiguous,
    awaitAdmission,
    awaitAdmissionWithDeadline,
    get,
    disposeAll,
    sweep,
  };
}
