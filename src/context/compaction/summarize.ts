/**
 * Phase 4 — the summarisation boundary.
 *
 * Summarisation is a MECHANISM compaction may use. It is not compaction: this
 * module knows nothing about spans, spans know nothing about providers.
 *
 * ## The rule that matters: the summariser never sees unbounded context
 *
 * The input is exactly the removable span, and the span is bounded by the
 * contract's plan. So this module cannot be handed the whole conversation even by
 * mistake — there is no parameter that accepts one.
 *
 * The output is bounded three ways:
 *
 *  1. `maxOutputTokens` is set explicitly on the call.
 *  2. The result is MEASURED with the project's own estimator afterwards, not
 *     trusted from the provider's word.
 *  3. A result over budget is REJECTED, not truncated. A half-summary that claims
 *     to cover a span it did not read is worse than no compaction.
 *
 * ## Failure containment
 *
 * Every failure mode returns a typed failure. None of them mutates stored state —
 * the caller decides whether to fall back to the rejection path. That ordering is
 * deliberate: a failed summarisation must never leave the conversation in a worse
 * state than before it was attempted.
 */

import { generateText, type LanguageModel, type ToolSet } from "ai";
import { measureMessages } from "../measure";
import type { UIMessage } from "ai";
import type { ContextOrigin } from "./contract";

/** The instruction. Deterministic — no clock, no randomness, no locale. */
export const SUMMARY_SYSTEM_PROMPT = [
  "You compress an earlier portion of a conversation so the assistant can keep working.",
  "",
  "Write a compact factual record. Preserve, in this order:",
  "1. What the user asked for, and any constraint or requirement they stated.",
  "2. Decisions already made, and anything the user corrected.",
  "3. Tasks that are still open.",
  "4. Concrete facts, file paths, identifiers and values that later turns will need.",
  "5. Tool outcomes that change what happens next.",
  "",
  "Rules:",
  "- Report only what is in the transcript. Never invent, infer, or add domain facts.",
  "- Never restate tool output verbatim; record its outcome.",
  "- No preamble, no headings beyond the numbered sections, no closing remarks.",
  "- Plain prose. Do not address the reader.",
].join("\n");

export interface SummarizeInput {
  /** The model to summarise with. Injected so this module is provider-agnostic. */
  readonly model: LanguageModel;
  /** Exactly the removable span. Never the whole conversation. */
  readonly spanMessages: readonly UIMessage[];
  /**
   * Ceiling on the summariser's OWN input, in tokens.
   *
   * This is the model's CAPACITY for this call, not the turn's budget — the two
   * are different quantities and conflating them breaks compaction.
   *
   * `budget.usableInputTokens` is what the *turn* is allowed to send after the
   * safety margin and the output reservation. The summariser has its own, much
   * smaller output reservation, so it can legitimately read more than the turn may
   * send. Deriving its ceiling from the budget undershot the real capacity by
   * roughly a quarter, and testing then showed the consequence: a conversation
   * large enough to need compaction is by definition bigger than the budget, so
   * every real compaction was refused with `summary_exceeds_budget`.
   *
   * The caller passes the model's real capacity minus the summariser's own
   * reservation. Never invented here.
   */
  readonly maxInputTokens: number;
  /** Hard ceiling on the produced summary, in tokens. */
  readonly maxSummaryTokens: number;
  /** Output reservation for the call. */
  readonly outputReservation: number;
  /** Identifier recorded as the summariser, for provenance. */
  readonly summarizedBy: string;
  /** Abort signal, so a hung summarisation cannot outlive the run. */
  readonly abortSignal?: AbortSignal | undefined;
  /** Wall-clock ceiling for the whole summarisation attempt. */
  readonly timeoutMs: number;
}

export type SummarizeResult =
  | {
      readonly ok: true;
      readonly summaryText: string;
      /** MEASURED size of the produced text, using the project's estimator. */
      readonly summaryTokens: number;
      readonly summarizedBy: string;
      readonly origin: Extract<ContextOrigin, "model_generated_summary">;
    }
  | {
      readonly ok: false;
      /** Enumerated, so a caller can choose a fallback without string matching. */
      readonly failure:
        | "span_empty"
        | "provider_error"
        | "timeout"
        | "aborted"
        | "empty_summary"
        | "summary_exceeds_budget";
      /** Measured size when the failure was an over-budget summary. */
      readonly summaryTokens?: number;
    };

/**
 * Produce a bounded summary of a span.
 *
 * Never throws: every failure is a typed result. The caller must treat `ok:
 * false` as "do not compact" and fall back, never as "compact with what we have".
 */
export async function summarizeSpan(input: SummarizeInput): Promise<SummarizeResult> {
  const { spanMessages, maxSummaryTokens } = input;
  if (spanMessages.length === 0) return { ok: false, failure: "span_empty" };

  // Transcribe the span to plain text. This is the summariser's ENTIRE view of
  // the conversation, and it is bounded by the span.
  const transcript = renderSpanTranscript(spanMessages);
  if (transcript.trim().length === 0) return { ok: false, failure: "span_empty" };

  // The summariser's own input budget. If the span cannot fit in one prompt,
  // compaction cannot proceed honestly and the caller must fall back — it must NOT
  // summarise a prefix of the span and present it as covering the whole thing.
  const transcriptTokens = measureMessages({
    messages: [...spanMessages],
    currentTurnIds: spanMessages.map((m) => (m as { id?: string }).id ?? ""),
    retainedIds: [],
  }).estimatedTokens;
  if (transcriptTokens > input.maxInputTokens) {
    // Not a provider failure: the span is too large to summarise within bounds.
    return { ok: false, failure: "summary_exceeds_budget", summaryTokens: transcriptTokens };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.abortSignal?.addEventListener("abort", onAbort, { once: true });
  // Declared outside the try so `finally` can detach it: a listener left on the
  // caller's signal would keep the whole compaction closure alive for the life of
  // the run.
  let onCallerAbort: (() => void) | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    // ## Why the call is RACED rather than merely aborted
    //
    // Two independent discoveries, both found by testing, not by reading docs:
    //
    // 1. `controller.abort()` is not an enforced bound. `generateText` hands the
    //    signal to the provider and does NOT race the call itself, so a provider
    //    that ignores the signal simply completes late. A slow model returned
    //    `ok: true` after the full timeout.
    //
    // 2. The signal the model receives can be ALREADY ABORTED by the time it is
    //    read. Verified by capturing `doGenerate` options: `abortSignal.aborted`
    //    was `true` on entry. A provider that only subscribes to the `abort`
    //    event — as a mock, and as any caller that does not check the flag first
    //    — then never learns about it and hangs forever.
    //
    // Racing against both the deadline and the caller's abort makes TBAi's own
    // bounds authoritative, independent of provider behaviour. The abort is still
    // issued, so a well-behaved provider stops work early; the race only decides
    // when TBAi stops waiting. A late result is discarded, never inspected.
    let rejectOnBound: (reason: Error) => void = () => {};
    const bounded = new Promise<never>((_resolve, reject) => {
      rejectOnBound = reject;
    });
    deadlineTimer = setTimeout(
      () => rejectOnBound(new SummarizationDeadline()),
      input.timeoutMs,
    );
    if (input.abortSignal?.aborted === true) {
      // Already cancelled before this call began — the "no call at all" path.
      rejectOnBound(new CallerAborted());
    } else {
      onCallerAbort = () => {
        controller.abort();
        rejectOnBound(new CallerAborted());
      };
      input.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });
    }

    const result = await Promise.race([
      generateText({
        model: input.model,
        system: SUMMARY_SYSTEM_PROMPT,
        prompt: [{ role: "user", content: [{ type: "text", text: transcript }] }],
        // Bound the OUTPUT explicitly. Without this the call inherits whatever the
        // model considers reasonable, which is exactly the unbounded path.
        maxOutputTokens: input.outputReservation,
        abortSignal: controller.signal,
      }),
      bounded,
    ]);

    const summaryText = (result.text ?? "").trim();
    if (summaryText.length === 0) return { ok: false, failure: "empty_summary" };

    // MEASURE rather than trust. A provider reporting "under maxOutputTokens"
    // says nothing about this project's estimator.
    const summaryTokens = measureMessages({
      messages: [
        {
          id: "summary",
          role: "user",
          parts: [{ type: "text", text: summaryText }],
        } as unknown as UIMessage,
      ],
      currentTurnIds: [],
      retainedIds: [],
    }).estimatedTokens;

    if (summaryTokens > maxSummaryTokens) {
      // REJECTED, not truncated. A truncated summary silently claims coverage it
      // does not have, which would corrupt the conversation's record.
      return { ok: false, failure: "summary_exceeds_budget", summaryTokens };
    }

    return {
      ok: true,
      summaryText,
      summaryTokens,
      summarizedBy: input.summarizedBy,
      origin: "model_generated_summary",
    };
  } catch (error) {
    // Order matters. The two internal markers are checked first so a provider
    // that rejects with its own abort error on the same signal is still reported
    // as TBAi's bound rather than as an opaque provider failure.
    if (error instanceof CallerAborted) {
      return { ok: false, failure: "aborted" };
    }
    if (error instanceof SummarizationDeadline) {
      return { ok: false, failure: "timeout" };
    }
    if (controller.signal.aborted) {
      return { ok: false, failure: input.abortSignal?.aborted ? "aborted" : "timeout" };
    }
    return { ok: false, failure: "provider_error" };
  } finally {
    // Cleared on every path, including success: an uncleared timer would fire
    // `controller.abort()` after the call completed and keep the process alive.
    clearTimeout(deadlineTimer);
    input.abortSignal?.removeEventListener("abort", onAbort);
    if (onCallerAbort) input.abortSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Internal marker for the enforced deadline.
 *
 * A distinct class rather than a string so a provider error carrying the same
 * text can never be mistaken for TBAi's own timeout.
 */
class SummarizationDeadline extends Error {
  constructor() {
    super("summarization deadline exceeded");
    this.name = "SummarizationDeadline";
  }
}

/** Internal marker for the caller's own cancellation. */
class CallerAborted extends Error {
  constructor() {
    super("summarization aborted by caller");
    this.name = "CallerAborted";
  }
}

/**
 * Render the span as a plain transcript.
 *
 * Tool calls are recorded as a one-line OUTCOME, never as their raw payload.
 * That keeps the summariser's prompt bounded even when a single tool result is
 * enormous, and it matches the preservation contract: an outcome, not the bytes.
 */
export function renderSpanTranscript(spanMessages: readonly UIMessage[]): string {
  const lines: string[] = [];
  for (const message of spanMessages) {
    const role = (message as { role?: string }).role ?? "unknown";
    const parts = ((message as { parts?: unknown[] }).parts ?? []) as Array<Record<string, unknown>>;
    const fragments: string[] = [];
    for (const part of parts) {
      const type = typeof part.type === "string" ? part.type : "";
      if (type === "text" && typeof part.text === "string") {
        fragments.push(part.text);
        continue;
      }
      if (type.startsWith("tool-")) {
        const toolName = typeof part.toolName === "string" ? part.toolName : "tool";
        const state = typeof part.state === "string" ? part.state : "unknown";
        fragments.push(`[${toolName} → ${state}]`);
      }
      // Attachments, reasoning and data parts are deliberately NOT transcribed.
      // Reasoning can be very large and is model-internal; the contract does not
      // promise it survives.
    }
    const body = fragments.join("\n").trim();
    if (body.length > 0) lines.push(`${role.toUpperCase()}: ${body}`);
  }
  return lines.join("\n\n");
}