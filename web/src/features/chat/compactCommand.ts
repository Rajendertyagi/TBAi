/**
 * Direct `/compact`: the CLIENT half of a command that is not a message.
 *
 * ## Why the composer owns this and not the transport
 *
 * assistant-ui creates the user message locally and PERSISTS it — through
 * `threadHistoryAdapter.appendStored` → `POST /api/conversations/:id/messages` —
 * BEFORE the HTTP request is made. A server response therefore cannot un-create
 * it: a data-only stream carrying no assistant part removes nothing. That is
 * precisely why `/compact` still rendered as a user bubble even though the server
 * intercepted it correctly. The interception has to happen at the one boundary
 * that precedes message creation, which is the composer's submit handler — the
 * same guard the Code surface already uses for its own `/compact`, so Enter, the
 * Send button and touch submit are all covered by one check.
 *
 * ## What this deliberately does NOT send
 *
 * No `providerId` and no `model`. `resolveChatModel` already resolves a
 * conversation's OWN provider, model and reasoning level when they are omitted, so
 * sending them would mean projecting the one-shot picker layering a second time in
 * a second place — the exact duplication that makes two code paths disagree later.
 * A maintenance command summarising with the conversation's configured model is
 * also the honest choice: the summary is a record of THIS conversation, and the
 * summariser contract already requires it to be the model that will read it.
 *
 * ## The synthetic command message
 *
 * The server detects the command from the last user message, so the request has to
 * carry one. It exists ONLY in the request body: it is never appended to the
 * thread and never reaches the history adapter, so there is nothing to un-render
 * afterwards and nothing to clean up. That is the whole point — the alternative
 * (let the message be created and then hide it) is a CSS lie over a real history
 * row.
 */

import type { DataMessagePart } from "@assistant-ui/react";
import { logger } from "../../lib/logger";

/**
 * The canonical command string the Direct surface intercepts.
 *
 * This is the spelling the client puts in the request body, and the one that
 * appears in logs. Mirrors the server's `COMPACT_COMMAND`.
 */
export const DIRECT_COMPACT_COMMAND = "/compact";

/**
 * Accepted spellings of the same command, mirroring the server's aliases.
 *
 * Matched EXACTLY after trimming, so `/compact now`, `please run /compact` and
 * `explain /compact` stay ordinary user messages. The server stays authoritative:
 * this guard only decides whether the command becomes conversation content, never
 * whether compaction runs.
 */
export const DIRECT_COMPACT_COMMAND_ALIASES: readonly string[] = ["/compress"];

/** Every accepted spelling, canonical first. Mirrors the server's `COMPACT_COMMANDS`. */
export const DIRECT_COMPACT_COMMANDS: readonly string[] = [
  DIRECT_COMPACT_COMMAND,
  ...DIRECT_COMPACT_COMMAND_ALIASES,
];

/** The sigil that introduces a command token, e.g. the `/` in `/compact`. */
export const COMMAND_SIGIL = "/";

/**
 * The sigil-less NAME of a command token.
 *
 * Tokens and names are deliberately different things here. A token is matched
 * against text the user typed, so it carries its sigil — `parseDirectCompactCommand`
 * compares whole tokens. A name is what the composer's command palette expects: it
 * supplies the sigil itself via `commandLabel`, and its entry ids are sigil-less.
 *
 * Handing `applyCommandSelection` a token therefore produced `//compact `, which no
 * longer matches `DIRECT_COMPACT_COMMANDS` — so selecting the palette entry sent the
 * command to the model as an ordinary message instead of compacting anything. The
 * palette was the only caller that needed this conversion, so it lives here beside
 * the tokens rather than being spelled out at the call site.
 */
export function commandNameOf(token: string): string {
  return token.startsWith(COMMAND_SIGIL) ? token.slice(COMMAND_SIGIL.length) : token;
}

/**
 * A parsed Direct compaction command.
 *
 * `instructions` is what the user typed after the command word, or `undefined` for
 * a bare `/compact`. Mirrors the server's `CompactCommandMatch`: the client needs
 * the command word to decide whether to intercept, and the instructions so the
 * synthetic request message carries them to the summariser.
 */
export interface DirectCompactCommandMatch {
  readonly command: string;
  readonly instructions: string | undefined;
  /** The exact text to send as the synthetic command message. */
  readonly text: string;
}

/**
 * Parse composer text as the Direct compaction command, or `undefined`.
 *
 * Mirrors the server's `parseCompactCommand` rule for the same reason the whole
 * grammar is duplicated: the client's job is to decide whether the text becomes
 * conversation content, and it cannot ask the server first. Whole-token matching
 * keeps `/compactx` ordinary user text.
 */
export function parseDirectCompactCommand(text: string): DirectCompactCommandMatch | undefined {
  const trimmed = text.trim();
  const [head, ...rest] = trimmed.split(/\s+/);
  if (head === undefined || !DIRECT_COMPACT_COMMANDS.includes(head)) return undefined;
  const instructions = rest.join(" ").trim();
  return {
    command: head,
    instructions: instructions.length > 0 ? instructions : undefined,
    text: trimmed,
  };
}

/** The status part the server emits, in the AI SDK WIRE form. */
export const DIRECT_COMPACT_PART = "data-tbai-compact";

/**
 * The renderer key for the compaction divider, in assistant-ui's internal form.
 *
 * `thread().append()` takes assistant-ui's `DataMessagePart`, which discriminates on
 * the literal `"data"` and carries the identity in a separate `name` field — not in
 * the `data-*` type the route streams. This is the ONE place that string is named;
 * the part builder, the DataUI registration and the transcript renderer all read it.
 */
export const DIRECT_COMPACT_DATA_NAME = "tbai-compact";

/** What the server actually did. Three values, never a bare boolean. */
export type DirectCompactOutcome = "compacted" | "skipped" | "failed";

/** The status payload. Mirrors the server's `ManualCompactData` wire shape. */
export interface DirectCompactStatus {
  readonly outcome: DirectCompactOutcome;
  /** Raw compaction reason, preserved rather than flattened to the outcome. */
  readonly reason: string;
  readonly generation: number;
  readonly spanLength: number;
  readonly summaryTokens: number;
  /**
   * What compaction kept, or `null` when nothing was kept.
   *
   * Non-null only for a `compacted` outcome. A `skipped` or `failed` compaction
   * replaced nothing, so the divider must not imply a summary exists.
   *
   * Optional because rows written before this field existed have none, and absent
   * must read as "no summary" rather than as an error.
   */
  readonly summary?: string | null;
  readonly reclaimedTokens: number;
  readonly requestFits: boolean;
  /**
   * Server-side identity of this compaction.
   *
   * Carried so the transcript entry can be keyed by it, which is what stops a
   * second `/compact` from silently mutating an earlier divider.
   */
  readonly operationId: string;
  /**
   * The durable transcript row, or `null` when the server could not write it.
   *
   * `null` means the divider is on screen but not reload-durable, which is a
   * different fact from "the compaction failed" — the compaction itself already
   * happened. Surfaced so nothing reports a durable divider that does not exist.
   */
  readonly anchorMessageId: string | null;
  /**
   * Who decided to compact: the user running `/compact`, or the engine reacting to
   * the conversation filling up.
   *
   * Defaults to `"manual"` when absent, which is the only value the manual command
   * ever produced before automatic compaction existed — so an older server's answer
   * is read correctly rather than guessed at.
   */
  readonly origin: CompactDividerOrigin;
}

/** A thread message, narrowed to what the projection actually reads. */
type ThreadMessageLike = {
  readonly id?: unknown;
  readonly role?: unknown;
  readonly parts?: unknown;
  readonly metadata?: unknown;
};

const OUTCOMES: ReadonlySet<string> = new Set<DirectCompactOutcome>([
  "compacted",
  "skipped",
  "failed",
]);

/**
 * Whether this composer text is the Direct compaction command.
 *
 * Exact match against one of `DIRECT_COMPACT_COMMANDS` after trimming, so
 * surrounding whitespace is tolerated and any additional word is not. This is the
 * same rule the server applies to the last user message; keeping them identical is
 * what makes the guard a presentation concern rather than a second, divergent
 * command language.
 */
export function isDirectCompactCommand(text: string): boolean {
  return parseDirectCompactCommand(text) !== undefined;
}

/**
 * Project one thread message's parts onto the shape the Direct route accepts.
 *
 * ## Why this is part-type aware
 *
 * `state` is REQUIRED on a tool part and FORBIDDEN on a text part, so no single
 * rule can be right for both. Applying the text rule to tool parts was a real
 * production regression in `48a47f2`; the tool branch below records the evidence.
 *
 * ## Why text parts are narrowed at all
 *
 * assistant-ui's live thread labels a settled text part `output-available` and a
 * submitted one `submitted`. The AI SDK's `UIMessage` validator — which the route
 * runs over this array via `safeValidateUIMessages` — accepts only `streaming` and
 * `done`. So any `/compact` sent AFTER a normal turn was rejected with
 * `invalid_messages` / `AI_TypeValidationError`.
 *
 * It is invisible in persisted history: the history adapter's format encoder
 * normalises those labels to `done` when writing, so reproducing the bug from
 * stored messages passes and only the live thread fails. That is why this was
 * found in a browser rather than in a test.
 *
 * Both branches enumerate what they emit rather than deleting what they dislike, so
 * a new runtime-only key cannot leak into a validated request by default.
 */
/**
 * Translate assistant-ui's tool part into the AI SDK's UIMessage tool part.
 *
 * ## Why this exists — proven from a live request, not inferred
 *
 * A server-side structural diagnostic on the real `/compact` request recorded the
 * live part as:
 *
 *   type=tool-call
 *   keys=args+argsText+isError+result+status+toolCallId+toolName
 *   state=undefined  input=false  output=false  providerMetadata=false
 *
 * That is **assistant-ui's** tool schema, not the AI SDK's. The route validates
 * with `safeValidateUIMessages`, whose tool parts are `type: "tool-<toolName>"`
 * carrying `toolCallId`, `state`, `input` and `output`. So the live part was
 * rejected as `AI_TypeValidationError` → HTTP 400 → "Compaction request failed
 * (400)", on every conversation that had used a tool.
 *
 * The mapping below is the narrowest one that satisfies the installed validator,
 * each field confirmed by direct test rather than assumption:
 *
 *   type    "tool-call"        -> "tool-" + toolName
 *   args    -> input          (REQUIRED whenever output is present; omitting it
 *                               is itself a rejection)
 *   result  -> output          ({type:"text", value} for a string result)
 *   state   derived           -> "output-available" with a result,
 *                                "input-available" without one
 *   dropped argsText, isError, status, toolName
 *
 * `argsText`/`isError`/`status` are assistant-ui bookkeeping with no AI SDK
 * equivalent; dropping them loses nothing the summariser reads.
 */
function translateAssistantToolPart(record: Record<string, unknown>): Record<string, unknown> {
  const toolName = typeof record.toolName === "string" && record.toolName.length > 0
    ? record.toolName
    : "unknown";
  const input = record.args;
  const result = record.result;
  const hasResult = result !== undefined && result !== null;

  const translated: Record<string, unknown> = {
    type: `tool-${toolName}`,
    toolCallId: record.toolCallId,
    state: hasResult ? "output-available" : "input-available",
  };
  // `input` must be present whenever `output` is; an absent value is normalised to
  // an empty object rather than omitted, which the validator rejects.
  translated.input = input === undefined || input === null ? {} : input;
  if (hasResult) {
    translated.output = typeof result === "string" ? { type: "text", value: result } : result;
  }
  return translated;
}

function projectParts(parts: readonly unknown[]): Array<Record<string, unknown>> {
  const projected: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part == null || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "text" && typeof record.text === "string") {
      // WHITELIST, not blacklist. The live assistant-ui part carries transient keys
      // the AI SDK's UIMessage validator does not define, and a second one
      // (`state`, already handled) was not the only offender. Enumerating what the
      // route accepts is the only projection that cannot drift again.
      projected.push({ type: "text", text: record.text });
      continue;
    }
    // Tool calls and results are the other parts this engine produces, and the
    // summariser needs their payload, so they are forwarded WHOLE.
    //
    // ## Why tool parts are NOT narrowed the way text parts are
    //
    // `state` is required on a tool part by the AI SDK's UIMessage validator, and
    // omitting it makes the whole array unvalidatable. Stripping it here was a real
    // production regression in `48a47f2`: `/compact` on any conversation that had
    // used tools was rejected with `invalid_messages` / `AI_TypeValidationError` →
    // HTTP 400, and the surface text was "Compaction request failed (400)".
    //
    // Text and tool parts therefore need OPPOSITE treatment, which is why the
    // projection branches on part type rather than applying one rule to both:
    //
    //   - text: narrowed to the fields the contract defines, because assistant-ui
    //     labels settled/submitted text `output-available`/`submitted`, which the
    //     validator rejects;
    //   - tool: passed through untouched, because every field it carries —
    //     `toolCallId`, `state`, `input`/`output`, provider metadata — is part of
    //     the contract, and inventing a narrower shape is what broke it.
    if (type === "tool-call" && typeof record.toolCallId === "string") {
      projected.push(translateAssistantToolPart(record));
      continue;
    }
    // Already an AI SDK tool part (`tool-<name>`): forward whole. `state` is
    // REQUIRED here, and `input` is required whenever `output` is present — both
    // verified against the installed validator.
    if (type.startsWith("tool-") && type !== "tool-call" && typeof record.toolCallId === "string") {
      projected.push({ ...record });
    }
  }
  return projected;
}

/**
 * Project the thread onto the minimal UI-message shape the Direct route accepts.
 *
 * Only `id`, `role`, `parts` and `metadata` are forwarded. assistant-ui's thread
 * messages also carry presentation state (`status`, timestamps, run config) that
 * the route does not own; forwarding it would put transport bookkeeping into a
 * request the server validates as conversation content.
 *
 * ## Why every field is normalised rather than passed through
 *
 * The server validates this array with the AI SDK's own `safeValidateUIMessages`.
 * Two live-thread shapes it rejects outright, both measured against the installed
 * version rather than assumed:
 *
 *   - a missing or non-string `id`, which it requires;
 *   - a part `state` the AI SDK does not define — see `projectPart`.
 *
 * A synthesised id and a dropped `state` are safe precisely because the server
 * persists nothing from this request: the array exists only so the planner can
 * find a span to summarise.
 */
export function projectThreadMessages(
  messages: readonly ThreadMessageLike[],
): Array<Record<string, unknown>> {
  return messages.map((message, index) => {
    const projected: Record<string, unknown> = {
      id: typeof message.id === "string" && message.id.length > 0 ? message.id : `compact-hist-${index}`,
      // Only the three roles the Direct route accepts. Anything else is dropped
      // rather than forwarded into a validated conversation array.
      role: message.role === "assistant" || message.role === "user" || message.role === "system"
        ? message.role
        : "user",
      parts: Array.isArray(message.parts) ? projectParts(message.parts) : [],
    };
    // Metadata is forwarded only as a plain object: the route validates it against
    // its own schema, and a non-object would be rejected as invalid metadata.
    if (message.metadata != null && typeof message.metadata === "object" && !Array.isArray(message.metadata)) {
      projected.metadata = message.metadata;
    }
    return projected;
  });
}

/**
 * The exact request body for a compaction command: the conversation, plus ONE
 * synthetic user message carrying the command.
 *
 * The synthetic message is last, which is what the server's last-user-message rule
 * requires. It is never persisted, because it is never handed to the history
 * adapter.
 *
 * `commandText` is the text the user actually typed, instructions included, so the
 * server can read them off the deciding message rather than receiving a second,
 * differently-shaped parameter for the same information. It defaults to the bare
 * canonical command for a `/compact` with nothing after it.
 */
export function buildCompactRequestBody(
  messages: readonly ThreadMessageLike[],
  commandId: string,
  commandText: string = DIRECT_COMPACT_COMMAND,
): { messages: Array<Record<string, unknown>> } {
  return {
    messages: [
      ...projectThreadMessages(messages),
      { id: commandId, role: "user", parts: [{ type: "text", text: commandText }] },
    ],
  };
}

/**
 * Read the wire `origin`, defaulting to `manual`.
 *
 * An unrecognised value is NOT passed through: it is treated as `manual`, because a
 * divider whose trigger cannot be named must not claim that the engine or overflow
 * recovery did something they may not have.
 */
function originOf(value: unknown): CompactDividerOrigin {
  return value === "automatic" || value === "recovery" ? value : "manual";
}

/**
 * Read the single status part out of a UI-message SSE body.
 *
 * Returns `undefined` when the body carries no such part — which is the honest
 * answer for a body that is not a compact response at all, and must never be
 * turned into a success.
 */
export function parseCompactStatus(body: string): DirectCompactStatus | undefined {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let parsed: { type?: unknown; data?: unknown };
    try {
      parsed = JSON.parse(payload) as { type?: unknown; data?: unknown };
    } catch {
      continue;
    }
    if (parsed.type !== DIRECT_COMPACT_PART) continue;
    const data = parsed.data as Partial<DirectCompactStatus> | undefined;
    if (data == null || typeof data.outcome !== "string") continue;
    if (!OUTCOMES.has(data.outcome)) continue;
    return {
      outcome: data.outcome as DirectCompactOutcome,
      reason: typeof data.reason === "string" ? data.reason : "unknown",
      generation: typeof data.generation === "number" ? data.generation : 0,
      spanLength: typeof data.spanLength === "number" ? data.spanLength : 0,
      summaryTokens: typeof data.summaryTokens === "number" ? data.summaryTokens : 0,
      // Only a real, non-blank string counts. Anything else — absent (an older
      // server), null (a refusal), or a non-string — is "no summary", so a
      // transport that echoes something unexpected cannot produce a divider with
      // `[object Object]` in it.
      summary: typeof data.summary === "string" && data.summary.length > 0 ? data.summary : null,
      reclaimedTokens: typeof data.reclaimedTokens === "number" ? data.reclaimedTokens : 0,
      requestFits: data.requestFits !== false,
      operationId: typeof data.operationId === "string" ? data.operationId : "",
      anchorMessageId:
        typeof data.anchorMessageId === "string" && data.anchorMessageId.length > 0
          ? data.anchorMessageId
          : null,
      origin: originOf(data.origin),
    };
  }
  return undefined;
}

/** A transport-level failure, kept distinct from a compaction outcome. */
export class CompactTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactTransportError";
  }
}

/**
 * Build the transcript part a compaction leaves behind.
 *
 * The command's HTTP response is only how the client LEARNS the outcome; this is
 * how the outcome is REPRESENTED. The part rides on an ordinary message, so the
 * existing history adapter persists it and the existing codec round-trips it —
 * both proven in `web/src/adapters/dataPartCodec.test.ts`.
 *
 * `id` is derived from `operationId`, so re-running a compaction produces a
 * distinct entry rather than silently mutating an older one.
 */
/** The payload the transcript divider renders. */
export interface CompactDividerData {
  kind: "tbai-compact";
  version: 1;
  outcome: DirectCompactOutcome;
  reason: string;
  spanLength: number;
  generation: number;
  operationId: string;
  /**
   * What compaction kept, rendered on expand. `null` when there is nothing to show,
   * which is what makes the divider non-expandable rather than expandable-and-empty.
   */
  summary: string | null;
  /**
   * The server's durable row id, when it wrote one. Rendered nowhere; carried so
   * the transcript entry can be traced back to the row a reload will replay.
   */
  anchorMessageId: string | null;
  /**
   * Who decided to compact. `"manual"` when the user ran `/compact`, `"automatic"`
   * when the engine did. The same part and the same renderer either way.
   */
  origin: CompactDividerOrigin;
}

/** Who decided to compact. Absent on the wire means manual. */
export type CompactDividerOrigin = "manual" | "automatic" | "recovery";

// Annotated as assistant-ui's own `DataMessagePart` so the part is assignable to
// `thread().append()`. Left to inference the `type` field widens to `string`,
// which no longer matches the discriminated union `append()` accepts.
export function buildDividerPart(status: DirectCompactStatus): DataMessagePart<CompactDividerData> {
  return {
    // assistant-ui's `DataMessagePart` discriminates on the literal "data" and
    // carries its identity in `data.kind`, which is what `makeAssistantDataUI`'s
    // `name` matches. The `data-tbai-compact` form is the WIRE shape the route
    // streams; the adapter converts between the two.
    type: "data",
    // `name` is how the renderer is resolved. No part `id`: identity lives in
    // `data.operationId`, which is what distinguishes two separate compactions.
    name: DIRECT_COMPACT_DATA_NAME,
    data: {
      kind: "tbai-compact",
      version: 1,
      outcome: status.outcome,
      reason: status.reason,
      spanLength: status.spanLength,
      generation: status.generation,
      operationId: status.operationId,
      // Normalised here rather than passed through, so an absent field and an empty
      // string both mean "no summary". Without this a blank summary would render as
      // an expandable divider containing nothing.
      summary: status.summary === undefined || status.summary === "" ? null : status.summary,
      anchorMessageId: status.anchorMessageId,
      origin: status.origin,
    },
  };
}

export interface DirectCompactInput {
  /** The conversation to compact. Omitted ⇒ the server answers `skipped`. */
  readonly conversationId: string | null;
  readonly messages: readonly ThreadMessageLike[];
  /**
   * The parsed command, when the composer text was one.
   *
   * Its `text` is sent as the synthetic deciding message so the SERVER reads the
   * instructions off that message, rather than the client forwarding the same
   * information through a second parameter that could disagree with it.
   *
   * Omitted when the caller has already established the text is not a command; the
   * body then carries the bare canonical spelling.
   */
  readonly command?: DirectCompactCommandMatch;
  readonly signal?: AbortSignal;
}

/**
 * Run one Direct compaction command and resolve with what the server did.
 *
 * Throws ONLY `CompactTransportError` — a request that never produced a status.
 * A compaction that ran and failed resolves as `outcome: "failed"`, because that
 * is a result the UI must render, not an exception.
 */
export async function runDirectCompact(
  input: DirectCompactInput,
): Promise<DirectCompactStatus> {
  const commandId = `compact-${globalThis.crypto.randomUUID()}`;
  const { messages } = buildCompactRequestBody(input.messages, commandId, input.command?.text);
  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Deliberately no providerId/model — see the module header.
        ...(input.conversationId ? { id: input.conversationId } : {}),
        messages,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    throw new CompactTransportError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) {
    // SHAPE ONLY — never message text. A rejection is a contract mismatch between
    // what the thread holds and what the route accepts, and the only way to fix
    // that is to see which role/part-type is wrong, so the diagnostic reports the
    // shape rather than guessing at it.
    logger.warn("direct", "compact.request_rejected", {
      status: response.status,
      messageCount: messages.length,
      shapes: messages.map(
        (message) =>
          `${String(message.role)}:${Array.isArray(message.parts)
            ? message.parts
                .map((part) => String((part as { type?: unknown } | null)?.type))
                .join("+")
            : "none"}`,
      ),
    });
    throw new CompactTransportError(`Compaction request failed (${response.status})`);
  }
  const status = parseCompactStatus(await response.text());
  if (status === undefined) {
    throw new CompactTransportError("Compaction response carried no status");
  }
  logger.info("direct", "compact.command_completed", {
    outcome: status.outcome,
    reason: status.reason,
    generation: status.generation,
    spanLength: status.spanLength,
  });
  return status;
}
