import type { UIMessage } from "ai";

type LoosePart = {
  type?: string;
  toolCallId?: string;
  state?: string;
  output?: unknown;
  approval?: { id?: string; approved?: boolean; resolution?: string };
  text?: string;
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
 * Lifecycle classification of a stored tool-call part (AI SDK v7 UI parts).
 *
 *  - "output"    → resolved: output-available / output-error / output-denied.
 *                  The model saw (or synthetically received) a result.
 *                  NOTE: cancel-on-new-message synthesizes `output-error` with
 *                  only `errorText` set, so state counts even without `output`.
 *  - "approval"  → a decision exists: approval-requested (gate open) or
 *                  approval-responded (approved OR denied, output not yet
 *                  arrived). This is a VALID, replayable state — the server
 *                  needs it to execute the approved call or synthesize the
 *                  denial on the continuation request.
 *  - "incomplete"→ input-streaming / input-available with no decision and no
 *                  result: the stream died before anything happened. Genuinely
 *                  stale — the model never saw a result and nothing is pending.
 */
type ToolLifecycle = "output" | "approval" | "incomplete";

function lifecycleOf(part: LoosePart): ToolLifecycle {
  if (
    part.output !== undefined ||
    part.state === "output-error" ||
    part.state === "output-denied"
  ) {
    return "output";
  }
  if (part.approval !== undefined) return "approval";
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

  // Pass 2: decide which occurrences survive.
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

  // Pass 3: apply the keep-set.
  const pruned: UIMessage[] = messages.map((message, messageIndex) => {
    const parts = asParts(message);
    if (!parts.some(isToolCallPart)) return message;
    const kept = parts.filter((part, partIndex) => {
      if (!isToolCallPart(part)) return true;
      const id = part.toolCallId;
      if (!id) return true;
      return keep.has(`${messageIndex}:${partIndex}`);
    });
    if (kept.length === parts.length) return message;
    return { ...message, parts: kept } as UIMessage;
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
