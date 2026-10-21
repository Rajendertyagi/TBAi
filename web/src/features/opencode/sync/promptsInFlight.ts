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
 * still be executing on the server. Phase 5 of the remediation plan gives
 * `ambiguous` its own reconciliation path; today it is recorded and the
 * waiter is woken, exactly as before the extraction.
 *
 * ## WHY IT IS A REGISTRY AND NOT A FLAG
 *
 * A prompt can be sent before the client knows whether an earlier one landed,
 * and more than one waiter can be waiting on the same prompt. The map is what
 * makes "which prompt is in flight, and what happened to it" a question with
 * one answer.
 *
 * This module was extracted from `v2ThreadController.ts` as part of Phase 2 of
 * the OpenCode runtime remediation plan. The extraction is behaviour
 * preserving: the same outcomes, the same guards, the same timing.
 */

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
 * outcome and registers a settler, and never edits the record.
 */
export interface PromptAdmission {
  /** The local message id of the prompt. */
  readonly messageId: string;
  /** The outcome so far, or `null` while the prompt is unadmitted. */
  readonly result: V2PromptAdmissionResult | null;
  /** What the prompt was admitted as, once it was. */
  readonly submission: V2PromptSubmission | null;
  /**
   * Registers the callback that settles the promise a caller is waiting on.
   *
   * It is called at most once, with the outcome, and never after the record
   * has settled.
   *
   * @param settle - The callback.
   */
  onSettle(settle: (result: V2PromptAdmissionResult) => void): void;
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
   * The admission record for a prompt, if it has one.
   *
   * @param messageId - The local message id of the prompt.
   * @returns The handle, or `undefined` when the prompt was never sent.
   */
  get(messageId: string): PromptAdmission | undefined;
  /** Settles every prompt in flight as `disposed`. */
  disposeAll(): void;
}

type AdmissionRecord = {
  readonly messageId: string;
  result: V2PromptAdmissionResult | null;
  submission: V2PromptSubmission | null;
  readonly waiters: Set<(result: V2PromptAdmissionResult) => void>;
  settle: ((result: V2PromptAdmissionResult) => void) | null;
};

/**
 * Creates the registry of prompts in flight.
 *
 * @returns The registry.
 */
export function createPromptsInFlight(): PromptsInFlight {
  const admissions = new Map<string, AdmissionRecord>();

  function ensure(messageId: string): AdmissionRecord {
    const existing = admissions.get(messageId);
    if (existing) return existing;
    const record: AdmissionRecord = {
      messageId,
      result: null,
      submission: null,
      waiters: new Set(),
      settle: null,
    };
    admissions.set(messageId, record);
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
      onSettle(settle: (result: V2PromptAdmissionResult) => void): void {
        record.settle = settle;
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
    record.settle?.(result);
    record.settle = null;
  }

  function markAmbiguous(messageId: string): void {
    const record = admissions.get(messageId);
    if (!record || record.result !== null) return;
    record.result = "ambiguous";
    for (const waiter of record.waiters) waiter("ambiguous");
    record.waiters.clear();
  }

  function awaitAdmission(messageId: string): Promise<V2PromptAdmissionResult> {
    const record = ensure(messageId);
    if (record.result !== null) return Promise.resolve(record.result);
    return new Promise((resolve) => record.waiters.add(resolve));
  }

  function get(messageId: string): PromptAdmission | undefined {
    const record = admissions.get(messageId);
    return record ? view(record) : undefined;
  }

  function disposeAll(): void {
    for (const messageId of admissions.keys()) settle(messageId, "disposed");
  }

  return { create, settle, markAmbiguous, awaitAdmission, get, disposeAll };
}
