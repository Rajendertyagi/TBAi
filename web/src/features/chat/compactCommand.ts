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

import { logger } from "../../lib/logger";

/**
 * The one command string the Direct surface intercepts.
 *
 * Mirrors the server's `COMPACT_COMMAND`. Matched EXACTLY after trimming, so
 * `/compact now`, `please run /compact` and `explain /compact` stay ordinary user
 * messages. The server stays authoritative: this guard only decides whether the
 * command becomes conversation content, never whether compaction runs.
 */
export const DIRECT_COMPACT_COMMAND = "/compact";

/** The status part the server emits. Named once; never spelled inline elsewhere. */
export const DIRECT_COMPACT_PART = "data-tbai-compact";

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
  readonly reclaimedTokens: number;
  readonly requestFits: boolean;
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
 * Exact match after trimming, so surrounding whitespace is tolerated and any
 * additional word is not. This is the same rule the server applies to the last
 * user message; keeping them identical is what makes the guard a presentation
 * concern rather than a second, divergent command language.
 */
export function isDirectCompactCommand(text: string): boolean {
  return text.trim() === DIRECT_COMPACT_COMMAND;
}

/**
 * Drop the transient `state` from one part.
 *
 * ## Why this is load-bearing, and why it was a real 400
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
 * The field is dropped rather than translated: it is transient UI bookkeeping the
 * route does not own, and absent is valid for every part type. Everything else on
 * the part — `type`, `text`, tool call/result payloads — is preserved, so the
 * summariser still sees the real conversation.
 */
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
    // summariser needs their payload. Their transient state is dropped; the rest
    // is forwarded because losing it would misrepresent the conversation.
    if (type.startsWith("tool-") && typeof record.toolCallId === "string") {
      const { state: _transientState, ...rest } = record;
      projected.push(rest);
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
 */
export function buildCompactRequestBody(
  messages: readonly ThreadMessageLike[],
  commandId: string,
): { messages: Array<Record<string, unknown>> } {
  return {
    messages: [
      ...projectThreadMessages(messages),
      { id: commandId, role: "user", parts: [{ type: "text", text: DIRECT_COMPACT_COMMAND }] },
    ],
  };
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
      reclaimedTokens: typeof data.reclaimedTokens === "number" ? data.reclaimedTokens : 0,
      requestFits: data.requestFits !== false,
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

export interface DirectCompactInput {
  /** The conversation to compact. Omitted ⇒ the server answers `skipped`. */
  readonly conversationId: string | null;
  readonly messages: readonly ThreadMessageLike[];
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
  const { messages } = buildCompactRequestBody(input.messages, commandId);
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
