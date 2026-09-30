/**
 * Divergence between the submitted message claim and stored history.
 *
 * WHY THIS EXISTS
 * ---------------
 * The hybrid seam (ADR 2026-10-01) treats the browser-posted `messages` array as a
 * CLAIM about history, not a record of it. Phase 1 established (F8) that the
 * server never re-reads messages for a request, and 2.1a established that no
 * content reconciliation exists anywhere - `POST /api/conversations/reconcile`
 * (`conversations.ts:249-266`) is `existsMany`, a `SELECT id`, and
 * `hasStoredMessage` (`storage/index.ts:436-443`) is likewise existence-only.
 *
 * This module adds the comparison. It deliberately does NOT merge, rewrite, or
 * reject:
 *
 *   - It never discards submitted state. A request that is mid-flight is
 *     NORMAL, and rejecting it would break auto-continue (scenario 2 of the 2.1c
 *     validation, which passes today).
 *   - It never rewrites stored history. Phase 2 must not silently modify
 *     persisted conversations to simplify budgeting.
 *   - It reports. The outcome becomes provenance and a structured log line, so
 *     the authority rule is observable rather than implied.
 *
 * The reconciliation is a comparison of ID SETS, not of content. Comparing
 * content would require interpreting opaque `z.unknown()` message elements
 * (guarantee G4: the payload is open), and would produce false positives
 * whenever the client holds a fresher version of a message the server has not
 * yet seen written.
 */

import type { UIMessage } from "ai";
import { messageService } from "../services/storage";
import type { DivergenceOutcome, DivergenceReport } from "./types";

/** Stored rows carry this format; anything else is not comparable. */
const ASSISTANT_UI_FORMATS = new Set(["ai-sdk/v6", "raw"]);

type LoosePart = { type?: string; [key: string]: unknown };

function messageRole(message: unknown): string | undefined {
  const role = (message as { role?: unknown } | null)?.role;
  return typeof role === "string" ? role : undefined;
}

function idsOf(messages: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const id = (message as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return ids;
}

/**
 * Classify the relationship between two id sets.
 *
 * The four outcomes are distinguished because they mean different things:
 *
 *   `in_flight_extension`  submitted ⊇ stored. The normal case during a run: the
 *                          client holds turns the server has not yet persisted.
 *   `aligned`              equal. Nothing to say.
 *   `missing_from_submission` stored ⊅ submitted. The server holds turns the
 *                          submission omits - e.g. a reply finalized server-side
 *                          for a DETACHED run whose client is gone and can never
 *                          re-send it. This is the case that motivated the seam.
 *   `unrelated`            neither contains the other. Worth a log; not
 *                          necessarily an error (a rebased thread can look like
 *                          this legitimately).
 */
export function classifyDivergence(submittedIds: ReadonlySet<string>, storedIds: ReadonlySet<string>): DivergenceReport {
  let onlyInStored = 0;
  let onlyInSubmitted = 0;
  for (const id of storedIds) if (!submittedIds.has(id)) onlyInStored += 1;
  for (const id of submittedIds) if (!storedIds.has(id)) onlyInSubmitted += 1;

  const outcome: DivergenceOutcome =
    onlyInStored === 0 && onlyInSubmitted === 0
      ? "aligned"
      : onlyInStored === 0
        ? "in_flight_extension"
        : onlyInSubmitted === 0
          ? "missing_from_submission"
          : "unrelated";

  return {
    outcome,
    submittedCount: submittedIds.size,
    storedCount: storedIds.size,
    onlyInStored,
    onlyInSubmitted,
  };
}

/** Read stored history for reconciliation. Returns null when it cannot be read. */
async function readStoredIds(conversationId: string): Promise<Set<string> | null> {
  try {
    const rows = await messageService.listThreadMessages(conversationId);
    const ids = new Set<string>();
    for (const row of rows) {
      if (!ASSISTANT_UI_FORMATS.has(row.format)) continue;
      const content = row.content as { id?: unknown; role?: unknown } | null;
      if (!content || typeof content !== "object") continue;
      // The stored content has no id of its own (encode strips it); the row id
      // column is authoritative, but the runtime may have minted a different one
      // for a message it has not yet persisted. Both are collected so a
      // not-yet-persisted turn is not misreported as missing.
      if (typeof row.id === "string") ids.add(row.id);
      if (typeof content.id === "string") ids.add(content.id);
    }
    return ids;
  } catch {
    // A failed read is NOT divergence. Reporting it as such would make an
    // ordinary database hiccup look like a client defect.
    return null;
  }
}

/**
 * Reconcile the submitted claim against stored history.
 *
 * Never throws and never rejects: a divergence is information, and the request
 * proceeds either way. Returns null when there is nothing to compare (no
 * conversation id, or the read failed).
 */
export async function reconcileWithStoredHistory(input: {
  conversationId: string | undefined;
  submittedMessages: readonly UIMessage[];
}): Promise<DivergenceReport | null> {
  if (!input.conversationId) return null;
  const storedIds = await readStoredIds(input.conversationId);
  if (!storedIds) return null;
  return classifyDivergence(idsOf(input.submittedMessages), storedIds);
}

/**
 * Identify the current user turn.
 *
 * The turn is the trailing run of messages after the last assistant message. This
 * is a structural read of the submitted array, used so the current turn is
 * identifiable BY ID (guarantee G11) rather than inferred downstream from array
 * position - a budget that drops "the last N messages" cannot express which ones
 * were protected.
 *
 * When the array ends with an assistant turn (a continuation whose tool result
 * is the last element), there is no current user turn; the returned set is
 * empty and every message is retained history. The budget must tolerate that.
 */
export function identifyCurrentTurn(messages: readonly UIMessage[]): { currentIds: string[]; retainedIds: string[] } {
  const currentIds: string[] = [];
  const retainedIds: string[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const role = messageRole(message);
    if (role !== "user") continue;
    // A user message that is followed by another user message is still part of
    // the current turn only if nothing assistant-shaped follows it.
    const followedByAssistant = messages.slice(i + 1).some((later) => messageRole(later) === "assistant");
    if (!followedByAssistant) {
      const id = (message as { id?: unknown }).id;
      if (typeof id === "string") currentIds.push(id);
    }
  }

  for (const message of messages) {
    const id = (message as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    if (!currentIds.includes(id)) retainedIds.push(id);
  }

  return { currentIds, retainedIds };
}

/**
 * Parts of a message that the converter will actually emit.
 *
 * `data-*` parts are dropped at conversion because `convertDataPart` is never
 * passed (`model-messages.ts:38-41`, and `convertDataPart` appears nowhere in
 * the repo - Phase 1 F12). They are counted in the estimate as a conservative
 * over-count, but they are not model-visible and the contract says so here
 * rather than leaving a reader to infer it.
 */
export function countModelVisibleParts(message: unknown): { visible: number; droppedDataParts: number } {
  const parts = (message as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(parts)) return { visible: 0, droppedDataParts: 0 };
  let visible = 0;
  let droppedDataParts = 0;
  for (const part of parts as LoosePart[]) {
    const type = typeof part.type === "string" ? part.type : "";
    if (type.startsWith("data-")) droppedDataParts += 1;
    else if (type !== "step-start" && type !== "start" && type !== "finish") visible += 1;
  }
  return { visible, droppedDataParts };
}
