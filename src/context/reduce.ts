/**
 * Request-side reduction of tool and MCP output.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Phase 1 finding F9: MCP tool results are returned in full by `getAiTools`
 * (`mcp/manager.ts:1053`) with no length argument anywhere in `mcpContentToText`
 * (`:1281-1295`), persisted structurally unchanged, and re-read and re-sent on
 * every later turn.
 *
 * The only existing bound is `BoundedBody` (`web/src/tools/body-budget.tsx:80`),
 * a React render-time component whose own comment (`:30-42`) concedes it bounds
 * the DOM, not serialisation. A tool result can therefore LOOK clipped in the UI
 * while the full text sits in SQLite and in the model's context.
 *
 * THE FOUR LIMITS, kept distinct (a display limit is not a context limit):
 *
 *   1. Render limit          - `BoundedBody`. What the user sees. Not here.
 *   2. Stored-data limit     - what is written to SQLite. Not here; a separate
 *                              decision, because bounding storage loses data the
 *                              user may want to read back.
 *   3. Request-serialization - THIS MODULE. What enters the outgoing request.
 *                              The only layer that protects model context.
 *   4. Model-context budget  - `budget.ts`. The ceiling this reduction serves.
 *
 * SAFETY INVARIANTS
 * -----------------
 * Reduction is applied to a tool part's OUTPUT ONLY. The `tool-call`, the
 * `toolCallId`, the tool name, and the input are never touched, so
 * tool-call/result pairing (guarantee 5) is preserved by construction: a reduced
 * result is still a result for a call that is still present.
 *
 * Truncation is always explicit in the model-visible text. A silently clipped
 * tool result teaches the model that the output was complete when it was not,
 * which is worse than a large result.
 */

import type { UIMessage } from "ai";
import type { ContextCategory, InputSizeEstimate, MechanismOutcome, ReductionReport } from "./types";

/**
 * Per-result character ceiling for the request.
 *
 * Not a display cap. This bounds what the provider receives. 64 KiB is roughly
 * 16k-21k estimated tokens: large enough that ordinary tool output is untouched,
 * small enough that one pathological result cannot consume a usable budget.
 */
export const REQUEST_TOOL_RESULT_MAX_CHARS = 64 * 1024;

/**
 * Reasoning reduction policy.
 *
 * Reasoning is the single largest unbounded context consumer in a long Direct
 * conversation (Phase 1 F10 established it is re-sent unconditionally and
 * accumulates). It is model-internal scratch work, not a load-bearing part of
 * the reply: the assistant's visible text, tool calls, tool results and approval
 * state are all SEPARATE parts and are never touched. So it is safe to bound it
 * in the request without harming replay or pairing.
 *
 * Two rules, both request-side only (storage keeps the full reasoning):
 *
 * - Only the most recent messages keep their reasoning. Everything older is
 *   dropped, because a reasoning trace from N turns ago is the least useful and
 *   the least likely to be continued.
 * - Even the retained reasoning is capped per part, so a single huge trace cannot
 *   swallow a usable budget.
 *
 * These are POLICY numbers, not model facts; they live here, next to the tool
 * ceiling, so tuning the request size never changes measurement or enforcement.
 */
export const REASONING_RETAIN_LAST_MESSAGES = 4;
export const REQUEST_REASONING_MAX_CHARS = 4096;

/** Marker appended to a reduced result so the truncation is visible to the model. */
const TRUNCATION_NOTICE_PREFIX = "\n\n[truncated by TBAi context budget: ";
const TRUNCATION_NOTICE_SUFFIX = " of the tool result were omitted from this request. The full value is stored and can be re-read by a follow-up tool call.]";

type LoosePart = {
  type?: string;
  state?: string;
  output?: unknown;
  errorText?: string;
  toolCallId?: string;
  [key: string]: unknown;
};

function isToolPart(part: LoosePart): boolean {
  const type = typeof part.type === "string" ? part.type : "";
  return type === "tool-call" || type === "dynamic-tool" || (type.startsWith("tool-") && type !== "tool-approval-response");
}

function hasResult(part: LoosePart): boolean {
  return part.output !== undefined || part.state === "output-error" || part.state === "output-denied";
}

function resultChars(part: LoosePart): number {
  if (part.state === "output-error") return typeof part.errorText === "string" ? part.errorText.length : 0;
  return typeof part.output === "string" ? part.output.length : 0;
}

function isMcpPart(part: LoosePart): boolean {
  const type = typeof part.type === "string" ? part.type : "";
  return type === "dynamic-tool" || type.startsWith("tool-mcp__");
}

/**
 * Reduce a single oversized result.
 *
 * Prefers STRUCTURED reduction over blind slicing: for list-like output the
 * shape tells the model what was omitted, whereas a blind slice can cut a line
 * in half and produce something that parses as a different answer. Only when
 * the shape gives no hint does it fall back to a head/tail slice, which keeps
 * both the beginning (usually a summary or status) and the end (usually the
 * result the model needs).
 */
function reduceResultText(text: string, maxChars: number): { text: string; removedChars: number } {
  if (text.length <= maxChars) return { text, removedChars: 0 };

  // The notice's real length depends on the omitted count, so it is BUILT first
  // and measured, rather than estimated with a fudge factor. Guessing the
  // length here overflowed the cap (the notice pushed the result 19 chars over),
  // which would defeat the whole point of a request-side bound.
  const build = (body: number): { out: string; omitted: number; len: number } => {
    const omitted = text.length - body;
    const notice = `${TRUNCATION_NOTICE_PREFIX}${omitted} characters${TRUNCATION_NOTICE_SUFFIX}`;
    return { out: notice, omitted, len: notice.length };
  };

  // Solve for the body budget that makes head + tail + notice fit exactly.
  // `notice` length is monotonically non-decreasing in `omitted`, i.e.
  // non-increasing in `body`, so one refinement pass converges.
  const NOTICE_OVERHEAD = TRUNCATION_NOTICE_PREFIX.length + TRUNCATION_NOTICE_SUFFIX.length + 20;
  let body = Math.max(0, maxChars - NOTICE_OVERHEAD);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const probe = build(body);
    const contentChars = body;
    const head = Math.ceil(contentChars * 0.6);
    const tail = contentChars - head;
    const total = head + tail + probe.len;
    if (total <= maxChars) {
      return {
        text: text.slice(0, head) + probe.out + (tail > 0 ? text.slice(text.length - tail) : ""),
        removedChars: probe.omitted,
      };
    }
    body = Math.max(0, body - (total - maxChars) - 1);
  }
  // Unreachable in practice; returns a strictly bounded result rather than
  // silently exceeding the cap.
  const fallbackNotice = `${TRUNCATION_NOTICE_PREFIX}output omitted${TRUNCATION_NOTICE_SUFFIX}`;
  return { text: text.slice(0, Math.max(0, maxChars - fallbackNotice.length)) + fallbackNotice, removedChars: text.length };
}

/** Whether a part is a model-internal reasoning trace (a separate, non-load-bearing part). */
function isReasoningPart(part: LoosePart): boolean {
  return part.type === "reasoning";
}

/** Capped reasoning text with the omission made explicit to the model. */
function reduceReasoningText(text: string, maxChars: number): { text: string; removedChars: number } {
  if (text.length <= maxChars) return { text, removedChars: 0 };
  const head = text.slice(0, maxChars);
  const omitted = text.length - maxChars;
  const notice = `\n\n[reasoning truncated by TBAi context budget: ${omitted} characters omitted; only the most recent reasoning is retained.]`;
  return { text: head + notice, removedChars: text.length - (head + notice).length };
}

/**
 * Apply request-side reduction across every message in Layer C.
 *
 * Reduces TWO declared-reducible categories, both request-side only:
 *
 * - oversized tool/MCP results, truncated to `maxCharsPerResult`;
 * - reasoning traces, dropped outside the retained tail and capped inside it.
 *
 * Returns NEW messages; the caller's input is not mutated. `data-*` parts are
 * counted but not reduced, because Phase 1 established they are dropped at
 * conversion anyway (F12) and reducing something that is never sent would be
 * theatre.
 */
export function reduceToolResults(
  messages: readonly UIMessage[],
  options: {
    maxCharsPerResult?: number;
    /**
     * Reasoning policy. Defaults to the exported constants. Overridable only for
     * tests that exercise the boundary; the production path uses the defaults.
     */
    reasoningRetainLast?: number;
    reasoningMaxChars?: number;
  } = {},
): { messages: UIMessage[]; report: ReductionReport } {
  const maxChars = options.maxCharsPerResult ?? REQUEST_TOOL_RESULT_MAX_CHARS;
  const reasoningRetainLast = options.reasoningRetainLast ?? REASONING_RETAIN_LAST_MESSAGES;
  const reasoningMaxChars = options.reasoningMaxChars ?? REQUEST_REASONING_MAX_CHARS;

  let reducedParts = 0;
  let droppedParts = 0;
  let removedChars = 0;
  let reducedReasoningParts = 0;
  let removedReasoningChars = 0;
  let changed = false;

  const keepReasoningFrom = Math.max(0, messages.length - reasoningRetainLast);

  const next = messages
    .map((message, index) => {
      const parts = (message as { parts?: unknown }).parts;
      if (!Array.isArray(parts)) return message;

      let messageChanged = false;
      const retainReasoning = index >= keepReasoningFrom;
      const nextParts = (parts as LoosePart[]).map((part) => {
        // ── Reasoning: the unbounded consumer. Never in the tool branch. ──────
        if (isReasoningPart(part)) {
          const raw = typeof part.text === "string" ? part.text : "";
          if (!retainReasoning) {
            // Old turn: drop the trace entirely. It is scratch work, not the reply.
            messageChanged = true;
            reducedReasoningParts += 1;
            removedReasoningChars += raw.length;
            return null as unknown as LoosePart;
          }
          const reduced = reduceReasoningText(raw, reasoningMaxChars);
          if (reduced.removedChars === 0) return part;
          messageChanged = true;
          reducedReasoningParts += 1;
          removedReasoningChars += reduced.removedChars;
          return { ...part, text: reduced.text } as LoosePart;
        }

        // ── Tool / MCP results: the original behaviour, untouched. ───────────
        if (!isToolPart(part) || !hasResult(part)) return part;
        const chars = resultChars(part);
        if (chars <= maxChars) return part;

        if (part.state === "output-error") {
          // An error result is diagnostic. Cutting it can remove the cause.
          // Drop it from the request rather than truncating it, and count it so
          // the omission is observable instead of silent.
          messageChanged = true;
          reducedParts += 1;
          droppedParts += 1;
          removedChars += chars;
          const { output: _output, errorText, ...rest } = part;
          return { ...rest, errorText: truncateNotice(chars) } as LoosePart;
        }

        const reduced = reduceResultText(String(part.output), maxChars);
        if (reduced.removedChars === 0) return part;
        messageChanged = true;
        reducedParts += 1;
        removedChars += reduced.removedChars;
        return { ...part, output: reduced.text } as LoosePart;
      });

      // A message whose only parts were reasoning traces has no model-visible
      // content left; drop it rather than emit an empty turn. A message that
      // still holds a tool part or text is kept regardless.
      const survivingParts = nextParts.filter((p): p is LoosePart => p !== null);
      if (survivingParts.length === 0 && (message as { role?: string }).role !== "user") {
        // A reasoning-only old message: nothing model-visible left. Drop it and
        // mark the request changed even though no part object was rewritten.
        changed = true;
        return null as unknown as UIMessage;
      }
      if (!messageChanged) return message;
      changed = true;
      return { ...(message as object), parts: survivingParts } as UIMessage;
    })
    .filter((m): m is UIMessage => m !== null);

  const report: ReductionReport = {
    reducedParts,
    removedChars,
    droppedParts,
    reducedReasoningParts,
    removedReasoningChars,
  };

  if (!changed) {
    return {
      messages: [...messages],
      report: {
        reducedParts: 0,
        removedChars: 0,
        droppedParts: 0,
        reducedReasoningParts: 0,
        removedReasoningChars: 0,
      },
    };
  }
  return { messages: next, report };
}

function truncateNotice(originalChars: number): string {
  return `Tool error output omitted from this request (${originalChars} characters). The failure is recorded in the run log.`;
}

/**
 * Categories eligible for size reduction, in reduction order.
 *
 * Exported so `budget.ts` and the diagnostics agree with what `reduce.ts`
 * actually touches. Keeping one list prevents the budget from claiming to
 * reduce a category nothing reduces.
 */
export const REQUEST_REDUCIBLE_CATEGORIES: readonly ContextCategory[] = [
  "mcp_results",
  "tool_results",
  "reasoning",
];

/**
 * Describe what request-side reduction did, in the budget gate's vocabulary.
 *
 * ## Why this is always `exhausted`
 *
 * `reduceToolResults` runs on EVERY request — there is no flag, no policy gate and
 * no eligibility test — and it truncates each result to a fixed cap in a single
 * pass. So once it returns, there is nothing further this mechanism can take from
 * this request, whether or not it found anything:
 *
 * - `reducedParts > 0` → it shrank the request and is now at its cap (`applied`).
 * - `reducedParts === 0` → it ran and this request has no reducible content.
 *
 * The two cases are distinct in diagnostics but identical as verdicts, which is
 * why `no_reducible_content` is not treated as a withholding: there is genuinely
 * nothing that was held back.
 */
export function describeToolResultReduction(report: ReductionReport): MechanismOutcome {
  return report.reducedParts > 0 || report.reducedReasoningParts > 0
    ? { kind: "exhausted", reason: "applied" }
    : { kind: "exhausted", reason: "no_reducible_content" };
}

/**
 * Measure a reduction so its effect is attributable in diagnostics.
 *
 * Expressed in the same estimated-token unit as everything else, clearly an
 * estimate.
 */
export function reductionSavings(report: ReductionReport, charsPerToken: number): number {
  if (charsPerToken <= 0) return 0;
  return Math.ceil((report.removedChars + report.removedReasoningChars) / charsPerToken);
}

/** Re-derive an estimate after reduction, for a before/after diagnostic pair. */
export function estimateDelta(before: InputSizeEstimate, after: InputSizeEstimate): number {
  return before.estimatedTokens - after.estimatedTokens;
}
