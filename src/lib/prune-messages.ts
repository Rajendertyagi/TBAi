import type { UIMessage } from "ai";

type LoosePart = {
  type?: string;
  toolCallId?: string;
  state?: string;
  output?: unknown;
  /**
   * The PARSED tool arguments. Absent exactly when the model's arguments never
   * validated, which is the case {@link hasUsableToolInput} exists to catch.
   */
  input?: unknown;
  approval?: { id?: string; approved?: boolean; resolution?: string };
  text?: string;
  /**
   * Legacy AI SDK field: the UNPARSED argument text of a tool call whose input
   * failed schema validation. Present only on `output-error` parts, and the
   * only place the SDK recovers a call's arguments from — see
   * {@link hasUsableToolInput}. Deprecated upstream; typed here only because
   * persisted history contains it.
   */
  rawInput?: unknown;
};

function asParts(message: UIMessage): LoosePart[] {
  return ((message as { parts?: unknown }).parts ?? []) as LoosePart[];
}

/** True for model tool-call parts (static `tool-*`, `tool-call`, dynamic). */
function isToolCallPart(part: LoosePart): boolean {
  const t = part.type ?? "";
  return (
    t === "tool-call" ||
    t === "dynamic-tool" ||
    (t.startsWith("tool-") && t !== "tool-approval-response")
  );
}

/**
 * Tool-call part states that `convertToModelMessages({ ignoreIncompleteToolCalls:
 * true })` — the single conversion TBAi performs (`model-messages.ts`) — turns
 * into a PROVIDER tool call.
 *
 * A part in any other tool state is filtered out before conversion and therefore
 * cannot put malformed arguments on the wire. That is the whole basis of the
 * replayability test below, and it is why `approval-requested` is absent here:
 * an open gate is neither a provider payload risk (nothing is sent) nor
 * something TBAi may discard (the server still needs the decision to execute
 * the call or synthesize the denial).
 */
const PROVIDER_TOOL_CALL_STATES: ReadonlySet<string> = new Set([
  "approval-responded",
  "output-available",
  "output-error",
  "output-denied",
]);

/**
 * True when this tool part is one the conversion can turn into a provider tool
 * call — i.e. the only parts for which usable arguments are required at all.
 */
function emitsProviderToolCall(part: LoosePart): boolean {
  return typeof part.state === "string" && PROVIDER_TOOL_CALL_STATES.has(part.state);
}

/** A JSON object and nothing else: arrays, `null` and primitives are unusable. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * LENIENT recovery of the legacy `output-error` argument text.
 *
 * Returns the recovered argument object, or `undefined` when there is nothing
 * usable. "Usable" is stricter than "parses": the recovered value must be a
 * non-null PLAIN OBJECT, because that is the only shape the wire accepts where
 * `arguments` belongs. So `"[]"`, `"null"`, `"42"` and `'"text"'` are all
 * rejected while `'{"path":"a.txt"}'` is recovered.
 *
 * ## Why the caller must WRITE the result back
 *
 * The SDK substitutes `rawInput` verbatim (`ai@7.0.93`
 * `convertToModelMessages`: `input: part.input ?? part.rawInput`) and the
 * OpenAI-compatible adapter then runs `JSON.stringify` over whatever it got. A
 * recovered-but-unwritten part would therefore still put the raw TEXT on the
 * wire — the same defect this repair exists to prevent. Recovery is only real
 * once the object is written to `input`, which is what
 * {@link withRecoveredToolInput} does.
 */
function recoverPlainObjectFromRawInput(rawInput: unknown): Record<string, unknown> | undefined {
  if (typeof rawInput !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return undefined;
  }
  return isPlainObject(parsed) ? parsed : undefined;
}

/**
 * True when a tool part carries arguments usable as a provider tool call.
 *
 * Two accepted shapes, and only two:
 *
 *  1. `input` is present — the SDK parsed the model's arguments against the
 *     tool schema. This is the normal case for every state.
 *  2. `input` is absent, the part is `output-error`, and `rawInput` recovers to
 *     a plain object — the legacy shape the SDK still substitutes, whose
 *     arguments are genuine and worth keeping.
 *
 * Everything else (a truncated `rawInput`, an array/primitive/null recovery, or
 * simply no arguments at all) is unreplayable: the SDK would emit a tool call
 * whose `arguments` is a string or absent, which no OpenAI-compatible provider
 * accepts. It is the application's job to drop such a part BEFORE conversion —
 * a provider SDK is not a history-repair layer.
 */
export function hasUsableToolInput(part: LoosePart): boolean {
  if (part.input !== undefined) return true;
  if (part.state !== "output-error") return false;
  return recoverPlainObjectFromRawInput(part.rawInput) !== undefined;
}

/**
 * The kept part with a legacy `rawInput` PROMOTED to `input`.
 *
 * Returns the part unchanged when there is nothing to recover. `rawInput` is
 * dropped rather than kept alongside, so a replayed part carries exactly one
 * authoritative source of arguments and nothing downstream can re-derive from
 * the unparsed text.
 *
 * This is a copy: the part the caller persisted is never mutated.
 */
function withRecoveredToolInput(part: LoosePart): LoosePart {
  if (part.input !== undefined || part.state !== "output-error") return part;
  const recovered = recoverPlainObjectFromRawInput(part.rawInput);
  if (recovered === undefined) return part;
  const { rawInput: _unparsedText, ...rest } = part;
  return { ...rest, input: recovered };
}

/**
 * Lifecycle classification of a stored tool-call part (AI SDK v7 UI parts).
 *
 *  - "output"      → resolved: output-available / output-error / output-denied.
 *                    The model saw (or synthetically received) a result.
 *                    NOTE: cancel-on-new-message synthesizes `output-error` with
 *                    only `errorText` set, so state counts even without `output`.
 *  - "approval"    → a decision exists: approval-requested (gate open) or
 *                    approval-responded (approved OR denied, output not yet
 *                    arrived). This is a VALID, replayable state — the server
 *                    needs it to execute the approved call or synthesize the
 *                    denial on the continuation request.
 *  - "incomplete"  → input-streaming / input-available with no decision and no
 *                    result: the stream died before anything happened. Genuinely
 *                    stale — the model never saw a result and nothing is pending.
 *  - "unreplayable"→ the part WOULD reach the provider as a tool call, but it has
 *                    no usable arguments (see {@link hasUsableToolInput}).
 *                    Replaying it puts a string or absent `arguments` field on
 *                    the wire, which the provider rejects on every attempt.
 */
type ToolLifecycle = "output" | "approval" | "incomplete" | "unreplayable";

function lifecycleOf(part: LoosePart): ToolLifecycle {
  // A resolved interaction is only replayable if the model can be shown it: an
  // `output-error` part whose arguments never parsed carries no input at all,
  // and re-sending it is exactly the malformed request the provider refuses.
  if (
    part.output !== undefined ||
    part.state === "output-error" ||
    part.state === "output-denied"
  ) {
    return emitsProviderToolCall(part) && !hasUsableToolInput(part) ? "unreplayable" : "output";
  }
  // Approval semantics are decided by the DECISION, never by argument
  // recoverability: an open gate (`approval-requested`) is filtered before
  // conversion and must survive for the continuation, while a responded approval
  // IS replayed and must therefore carry usable arguments.
  if (part.approval !== undefined) {
    return emitsProviderToolCall(part) && !hasUsableToolInput(part) ? "unreplayable" : "approval";
  }
  return "incomplete";
}

function isTextOnlyUserMessage(message: UIMessage): boolean {
  if ((message as { role?: string }).role !== "user") return false;
  const parts = asParts(message);
  return parts.length > 0 && parts.every((p) => p.type === "text");
}

function isMeaningfulPart(part: LoosePart): boolean {
  return part.type !== "step-start";
}

function lastIndexOf<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

export interface PruneStats {
  /** tool-call parts removed (superseded duplicates, expired approvals, stale). */
  removedToolParts: string[];
  /** assistant turns dropped because pruning left only step-start. */
  removedEmptyTurns: number;
  /** approval decisions kept for the continuation (approved or denied). */
  preservedApprovals: string[];
}

/**
 * Repairs stored thread history into a shape the provider accepts (Gemini
 * rejects orphaned functionCall turns and same-role runs) while PRESERVING
 * the approval lifecycle. Pure function; healthy histories pass through
 * semantically untouched.
 *
 * Per toolCallId (tool-call ids are the stable interaction identity):
 *
 *  1. Any occurrence with a result ("output") wins → keep the LAST such
 *     occurrence, drop earlier duplicates (the approval-responded snapshot of
 *     an interaction that later completed is superseded).
 *  2. Otherwise, if any occurrence carries an approval decision (requested or
 *     responded), keep the LAST one — but only while the conversation has not
 *     moved past it (no later user turn). This is the active continuation:
 *     the server must see the decision to execute the approved call or
 *     synthesize the denial. If a user turn follows, the continuation context
 *     is gone: the decision expires and the part is dropped — a destructive
 *     action is never executed retroactively on an unrelated future message,
 *     and a fresh approval is required instead.
 *  3. Otherwise (no result, no decision anywhere) the interaction is genuinely
 *     stale → drop all occurrences.
 *
 * An interaction whose occurrences are ALL `unreplayable` (see
 * {@link ToolLifecycle}) matches neither rule 1 nor rule 2, so it falls through
 * to rule 3 and every occurrence is dropped — the same path a stale call takes,
 * which is what keeps the call and its synthesized tool result together: the
 * conversion derives both from the same parts, so removing the part removes the
 * `tool` role message too and no orphan can survive. An id that has BOTH a
 * replayable and an unreplayable occurrence keeps its replayable occurrence and
 * loses only the broken one, because the keep-set is per occurrence.
 *
 * Assistant turns left with only step-start after pruning are dropped (empty
 * model turns). Adjacent text-only user messages are merged (same-role runs).
 */
export function pruneStaleMessages(messages: UIMessage[]): PrunedHistory {
  const stats: PruneStats = {
    removedToolParts: [],
    removedEmptyTurns: 0,
    preservedApprovals: [],
  };

  // Pass 1: collect occurrences per toolCallId.
  const occurrences = new Map<
    string,
    { messageIndex: number; partIndex: number; lifecycle: ToolLifecycle; hasApproval: boolean }[]
  >();
  messages.forEach((message, messageIndex) => {
    asParts(message).forEach((part, partIndex) => {
      if (!isToolCallPart(part)) return;
      const id = part.toolCallId;
      if (!id) return;
      const list = occurrences.get(id) ?? [];
      list.push({ messageIndex, partIndex, lifecycle: lifecycleOf(part), hasApproval: part.approval !== undefined });
      occurrences.set(id, list);
    });
  });

  const lastUserIndex = lastIndexOf(messages, (m) => (m as { role?: string }).role === "user");

  // Pass 2: decide which occurrences survive. Only "output" and "approval"
  // occurrences are ever candidates, so an `unreplayable` one is invisible to
  // both rules and its toolCallId falls through to the removal path below.
  const keep = new Set<string>();
  for (const [id, occs] of occurrences) {
    const lastOutput = [...occs].reverse().find((o) => o.lifecycle === "output");
    if (lastOutput) {
      keep.add(`${lastOutput.messageIndex}:${lastOutput.partIndex}`);
      continue;
    }
    const lastApproval = [...occs].reverse().find((o) => o.lifecycle === "approval");
    if (lastApproval) {
      const expired = lastApproval.messageIndex < lastUserIndex;
      if (!expired) {
        keep.add(`${lastApproval.messageIndex}:${lastApproval.partIndex}`);
        stats.preservedApprovals.push(id);
      } else {
        stats.removedToolParts.push(id);
      }
      continue;
    }
    stats.removedToolParts.push(id);
  }

  // Pass 3: apply the keep-set, promoting any recovered legacy arguments on the
  // parts that survive (see `withRecoveredToolInput`).
  const pruned: UIMessage[] = messages.map((message, messageIndex) => {
    const parts = asParts(message);
    if (!parts.some(isToolCallPart)) return message;
    let changed = false;
    const kept = parts.map((part, partIndex) => {
      if (!isToolCallPart(part)) return part;
      const id = part.toolCallId;
      if (!id) return part;
      if (!keep.has(`${messageIndex}:${partIndex}`)) {
        changed = true;
        return null;
      }
      const recovered = withRecoveredToolInput(part);
      if (recovered !== part) changed = true;
      return recovered;
    });
    if (!changed) return message;
    return { ...message, parts: kept.filter((part) => part !== null) } as UIMessage;
  });

  // Pass 4: drop assistant turns that now contain no meaningful content
  // (only step-start, or nothing at all — empty model turns are invalid
  // provider input). Legitimate tool/approval turns remain.
  const nonEmpty = pruned.filter((message) => {
    if ((message as { role?: string }).role !== "assistant") return true;
    const dropped = !asParts(message).some(isMeaningfulPart);
    if (dropped) stats.removedEmptyTurns += 1;
    return !dropped;
  });

  // Pass 5: merge adjacent text-only user messages (never functionResponses).
  const merged: UIMessage[] = [];
  for (const message of nonEmpty) {
    const prev = merged[merged.length - 1];
    if (prev && isTextOnlyUserMessage(prev) && isTextOnlyUserMessage(message)) {
      merged[merged.length - 1] = {
        ...prev,
        parts: [...asParts(prev), ...asParts(message)],
      } as UIMessage;
      continue;
    }
    merged.push(message);
  }

  return { messages: merged, stats };
}

export interface PrunedHistory {
  messages: UIMessage[];
  stats: PruneStats;
}
