/**
 * Input-size measurement for the Direct context budget.
 *
 * WHAT THIS IS NOT: provider-reported usage. That arrives after the request
 * (`chat.ts:581-583`, `chat-model.ts:116-124`) and is a different fact about a
 * different thing. Nothing in this module may be described as "the token count"
 * without the word ESTIMATE, and no caller may store an estimate in a field
 * named like usage.
 *
 * ERROR MODEL
 * -----------
 * There is no exact tokenizer available for arbitrary provider/model pairs, and
 * inventing one would be a guess dressed as a measurement. Instead the estimate
 * is a character count divided by a deliberately PESSIMISTIC characters-per-token
 * ratio.
 *
 * Direction of error is the important part. Under-estimating input size lets an
 * oversized request escape; over-estimating only rejects slightly early. So the
 * divisor is set LOW (assume dense text, many tokens per character) rather than
 * at the ~4 chars/token English rule of thumb, which is optimistic.
 *
 * The band between plausible divisors is wide - roughly 3 to 5 characters per
 * token depending on corpus density (prose sits near 4, dense code and
 * punctuation-heavy tool output near 3) - and a single character can be one
 * token or several, so non-ASCII input can exceed the high end. `range` states
 * the band; the safety margin in `budget.ts` is what absorbs it. Neither the
 * point estimate nor the range is a guarantee.
 */

import {
  CONTEXT_CATEGORIES,
  type ContextCategory,
  type InputSizeEstimate,
  type InstructionsLayer,
  type MessagesLayer,
  type ToolDefinitionLayer,
} from "./types";

/**
 * Characters per token used for the point estimate.
 *
 * Deliberately below the ~4 prose rule of thumb so the error is biased toward
 * over-counting. Raising this to 4 would make the budget permissive at exactly
 * the boundary where being permissive is expensive.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 3;

/** Densest plausible corpus - yields the fewest tokens for a given char count. */
const CHARS_PER_TOKEN_DENSE = 5;
/** Densest-token side of the band - the most tokens for a given char count. */
const CHARS_PER_TOKEN_TOKEN_HEAVY = 2.5;

/**
 * Per-message structural overhead (role framing, part delimiters, the model's
 * own chat template). Small, but it is real and a long conversation accumulates
 * it, so it is counted rather than ignored.
 */
const STRUCTURAL_CHARS_PER_MESSAGE = 4;

/** Tool definition JSON overhead per tool, beyond its name. */
const STRUCTURAL_CHARS_PER_TOOL = 12;

function emptyCategoryMap(): Record<ContextCategory, number> {
  const out = {} as Record<ContextCategory, number>;
  for (const category of CONTEXT_CATEGORIES) out[category] = 0;
  return out;
}

function tokenize(chars: number, charsPerToken: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / charsPerToken);
}

/**
 * Serialize a value the way it would travel in the request, for character
 * counting. Deliberately conservative: on a cycle it returns a marker rather
 * than throwing, because a budget must never crash a request.
 */
function measureValueChars(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (typeof value === "function") return 0;
  if (Array.isArray(value)) {
    let total = 2; // brackets
    for (const item of value) total += measureValueChars(item) + 1; // comma
    return total;
  }
  if (typeof value === "object") {
    let total = 2; // braces
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      total += key.length + 3 + measureValueChars(item); // "key": ,
    }
    return total;
  }
  return 0;
}

/** Loose view of a stored UI part. The payload is opaque by design. */
type LoosePart = {
  type?: string;
  text?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  approval?: unknown;
  mediaType?: string;
  url?: string;
  filename?: string;
  [key: string]: unknown;
};

function partsOf(message: unknown): LoosePart[] {
  const parts = (message as { parts?: unknown } | null)?.parts;
  return Array.isArray(parts) ? (parts as LoosePart[]) : [];
}

/**
 * Classify a part and count its characters.
 *
 * `mcp_results` is separated from `tool_results` because MCP output is the
 * unbounded population Phase 1 flagged (F9): `getAiTools` returns the full
 * string and `mcpContentToText` takes no length argument. A budget that cannot
 * attribute it separately cannot prioritise reducing it.
 */
function classifyPart(part: LoosePart): { category: ContextCategory; chars: number } {
  const type = typeof part.type === "string" ? part.type : "";

  if (type === "text") {
    return { category: "assistant_text", chars: typeof part.text === "string" ? part.text.length : 0 };
  }
  if (type === "reasoning") {
    return { category: "reasoning", chars: typeof part.text === "string" ? part.text.length : 0 };
  }
  if (type === "file" || type === "image") {
    return { category: "attachments", chars: measureValueChars(part) };
  }
  if (type.startsWith("data-")) {
    return { category: "data_parts", chars: measureValueChars(part) };
  }
  if (type === "step-start" || type === "start" || type === "finish") {
    return { category: "other", chars: 0 };
  }
  if (type === "tool-approval-response") {
    return { category: "tool_calls", chars: measureValueChars(part) };
  }
  if (type === "tool-call" || type === "dynamic-tool" || type.startsWith("tool-")) {
    // A tool part carries BOTH the call and (usually) its result. The result is
    // the unbounded surface, so it is counted separately from the call.
    const callChars = measureValueChars(part.input) + (part.toolCallId ? String(part.toolCallId).length : 0);
    const hasResult = part.output !== undefined || part.state === "output-error" || part.state === "output-denied";
    if (!hasResult) return { category: "tool_calls", chars: callChars };
    const resultChars = measureValueChars(part.output);
    const isMcp = type === "dynamic-tool" || type.startsWith("tool-mcp__");
    return isMcp
      ? { category: "mcp_results", chars: resultChars }
      : { category: "tool_results", chars: resultChars };
  }
  return { category: "other", chars: measureValueChars(part) };
}

function sumCharsByCategory(
  categories: Iterable<ContextCategory>,
): { charsByCategory: Record<ContextCategory, number>; totalChars: number } {
  const charsByCategory = emptyCategoryMap();
  let totalChars = 0;
  for (const category of categories) {
    const chars = charsByCategory[category];
    charsByCategory[category] = chars;
    totalChars += chars;
  }
  return { charsByCategory, totalChars };
}

/**
 * Measure Layer A (instructions).
 *
 * Measured in isolation so a large system prompt is attributable rather than
 * smuggled into "other". Note Phase 1 §1.4: `conversation.systemPrompt` was NULL
 * for all conversations in the audit install, so this is frequently zero - the
 * path must work, and must not assume a non-zero value.
 */
export function measureInstructions(layer: InstructionsLayer): InputSizeEstimate {
  const chars = layer.text?.length ?? 0;
  const charsByCategory = emptyCategoryMap();
  charsByCategory.instructions = chars;
  return buildEstimate(charsByCategory, chars, 0);
}

/**
 * Measure Layer B (tool definitions).
 *
 * Tool schemas are sent on every request and are entirely static per tool, so
 * this is both a real cost and a permanently cacheable prefix. Names and schema
 * shapes are counted; tool IMPLEMENTATIONS are functions and contribute nothing,
 * which is correct because a function is not serialized.
 */
export function measureToolDefinitions(layer: ToolDefinitionLayer): InputSizeEstimate {
  const charsByCategory = emptyCategoryMap();
  let totalChars = 0;
  for (const name of layer.nativeToolNames) {
    totalChars += name.length + STRUCTURAL_CHARS_PER_TOOL;
  }
  for (const name of layer.mcpToolNames) {
    totalChars += name.length + STRUCTURAL_CHARS_PER_TOOL;
  }
  // The description and input schema are the bulk of a tool definition.
  for (const [toolName, tool] of Object.entries(layer.tools)) {
    const candidate = tool as { description?: unknown; inputSchema?: unknown; providerExecuted?: unknown };
    totalChars += measureValueChars(candidate?.description) + measureValueChars(candidate?.inputSchema);
    if (candidate?.providerExecuted === true) totalChars += toolName.length;
  }
  charsByCategory.tool_definitions = totalChars;
  return buildEstimate(charsByCategory, totalChars, 0);
}

/**
 * Measure Layer C (messages) per message role.
 *
 * Counts the STORED UI shape, which is what the server holds and what the
 * converter reads. This is deliberately a superset of what the provider receives
 * (`data-*` parts are dropped at conversion - Phase 1 F12), which is the safe
 * direction: over-counting a part that is never sent only makes the budget
 * conservative.
 */
export function measureMessages(layer: MessagesLayer): InputSizeEstimate {
  const charsByCategory = emptyCategoryMap();
  let totalChars = 0;
  let messageCount = 0;

  for (const message of layer.messages) {
    const isUser = (message as { role?: string }).role === "user";
    let messageChars = STRUCTURAL_CHARS_PER_MESSAGE;
    for (const part of partsOf(message)) {
      const { category, chars } = classifyPart(part);
      // A text part's category depends on whose message it lives in.
      const effective = category === "assistant_text" && isUser ? "user_text" : category;
      charsByCategory[effective] += chars;
      messageChars += chars;
    }
    totalChars += messageChars;
    messageCount += 1;
  }

  return buildEstimate(charsByCategory, totalChars, messageCount);
}

/** Combine per-layer estimates into one request-level estimate. */
export function combineEstimates(parts: readonly InputSizeEstimate[]): InputSizeEstimate {
  const charsByCategory = emptyCategoryMap();
  let totalChars = 0;
  let messageCount = 0;
  for (const part of parts) {
    for (const [category, chars] of Object.entries(part.charsByCategory)) {
      charsByCategory[category as ContextCategory] += chars as number;
    }
    totalChars += part.estimatedChars;
  }
  // Message count drives structural overhead already counted per layer; it is
  // only needed for diagnostics, which the caller supplies separately.
  messageCount = 0;
  return buildEstimate(charsByCategory, totalChars, messageCount);
}

function buildEstimate(
  charsByCategory: Record<ContextCategory, number>,
  totalChars: number,
  _messageCount: number,
): InputSizeEstimate {
  const estimatedTokens = tokenize(totalChars, CHARS_PER_TOKEN_ESTIMATE);
  return {
    estimatedTokens,
    estimatedChars: totalChars,
    charsPerToken: CHARS_PER_TOKEN_ESTIMATE,
    range: {
      // Dense corpus -> fewer tokens; token-heavy corpus -> more.
      low: tokenize(totalChars, CHARS_PER_TOKEN_DENSE),
      high: tokenize(totalChars, CHARS_PER_TOKEN_TOKEN_HEAVY),
    },
    byCategory: Object.fromEntries(
      Object.entries(charsByCategory).map(([k, v]) => [k, tokenize(v as number, CHARS_PER_TOKEN_ESTIMATE)]),
    ) as Record<ContextCategory, number>,
    charsByCategory,
  };
}
