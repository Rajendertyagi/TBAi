/**
 * P2 Direct History Window — write-back derivation (the ONLY write-back path).
 *
 * ## Why this module exists
 *
 * Write-back must not be derived from a repository built by
 * `ExportedMessageRepository.fromBranchableArray` / `fromArray`: both re-create
 * every message through `fromThreadMessageLike`, so the `symbolInnerMessage`
 * binding installed by the AI SDK conversion is gone and
 * `getExternalStoreMessages()` on those objects returns an empty array. Writing
 * back from such a repository yields an EMPTY window — silent loss of an edit, a
 * delete, a tool result or an approval decision.
 *
 * The loss point is that CONSTRUCTION, not the `messageRepository` store field.
 * `web/tests-dom/contract/p2-public-binding-sources.test.ts` measures both:
 *
 *   production construction (toExportedMessageRepository → import)
 *     m1=m1  m2=m2,m3  m4=m4        binding survives the runtime
 *   ExportedMessageRepository.fromBranchableArray
 *     m1=(none)  m2=(none)  m4=(none)
 *
 * So a bounded window may still use `messageRepository` — provided it is built
 * by wrapping CONVERSION OUTPUT with persisted parent ids, exactly as
 * `useAISDKRuntime`'s public `unstable_messageRepository` path does. This module
 * stays the single write-back boundary because that invariant is invisible until
 * it is asserted, and a regression must fail closed rather than write nothing.
 *
 * So write-back derives from the binding-carrying conversion output only. This
 * module never accepts a repository: that is enforced by the signature, and a
 * repository object passed in anyway fails CLOSED (no binding → ambiguity),
 * never silently degrading to an empty write.
 *
 * ## Invariant 21 (corrected — semantic identity, not rendered rows)
 *
 * "1 persisted message = 1 uniquely recoverable semantic identity. A rendered
 * row may group multiple persisted messages (adjacent-assistant merge) provided
 * that every persisted id, its order, its parent link and its write-back binding
 * are recoverable from the conversion output / chat.messages. A window commit
 * fails closed when identity, ordering, parentage or write-back binding cannot be
 * recovered unambiguously — never merely because rendered rows < persisted
 * messages."
 *
 * This module is where that rule is enforced: `deriveWriteBack` refuses to
 * produce a write-back window unless every persisted identity, the ordering, the
 * parentage and the bindings are all recoverable.
 */

import { getExternalStoreMessages } from "@assistant-ui/react";

/** The persisted message shape TBAi writes back (an AI SDK UI message). */
export type PersistedMessage = { id: string; role: string; parts: unknown[] };

/** One entry of a write-back window: a persisted message and its parent link. */
export type WriteBackEntry = {
  readonly id: string;
  readonly parentId: string | null;
  readonly message: PersistedMessage;
};

export type WriteBackWindow = {
  readonly messages: readonly WriteBackEntry[];
  readonly headId: string | null;
};

/** A rendered row plus the parent ROW id the repository recorded for it. */
export type BoundRow = {
  readonly message: unknown;
  readonly parentId: string | null;
};

/** Why a window could not be reduced to recoverable persisted identities. */
export type WriteBackAmbiguity =
  | "missing-binding"
  | "duplicate-persisted-id"
  | "unresolvable-parent"
  | "invalid-persisted-message";

/**
 * Thrown when a window cannot be reduced to unambiguous persisted identities.
 *
 * A window that cannot be written back must never be persisted partially, so
 * every caller treats this as "keep the last valid window" and surfaces the
 * failure.
 */
export class WriteBackAmbiguityError extends Error {
  readonly ambiguity: WriteBackAmbiguity;
  /** Row ids or persisted ids involved, for the failure log. Never message text. */
  readonly ids: readonly string[];

  constructor(ambiguity: WriteBackAmbiguity, ids: readonly string[]) {
    super(
      `Write-back cannot recover persisted identity unambiguously (${ambiguity}): ${ids.join(",")}`,
    );
    this.name = "WriteBackAmbiguityError";
    this.ambiguity = ambiguity;
    this.ids = ids;
  }
}

const readPersistedId = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

const isPersistedMessage = (value: unknown): value is PersistedMessage => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; role?: unknown; parts?: unknown };
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.role === "string" &&
    Array.isArray(candidate.parts)
  );
};

/**
 * Reduce binding-carrying rendered rows to the persisted messages a window commit
 * must write back.
 *
 * Expands every row through its `symbolInnerMessage(s)` binding (so an
 * adjacent-assistant merge yields both persisted messages, in order) and
 * re-derives each persisted message's parent from the LAST persisted message of
 * its parent row — the repository only knows parent ROW ids, and a merged row
 * must restore the original persisted chain.
 *
 * Fails closed (throws `WriteBackAmbiguityError`) when any of these cannot be
 * recovered unambiguously:
 *   - a row carries no binding (this is what a repository object looks like),
 *   - a persisted id appears twice,
 *   - a row's parent row is not present in the window,
 *   - a bound value is not a well-formed persisted message.
 *
 * @param rows binding-carrying rendered rows in render order
 * @returns one entry per PERSISTED message, plus the persisted head id
 */
export function deriveWriteBack(rows: readonly BoundRow[]): WriteBackWindow {
  const messages: WriteBackEntry[] = [];
  const seen = new Set<string>();
  /** Row id → id of the LAST persisted message inside that row. */
  const lastPersistedIdByRowId = new Map<string, string>();

  for (const row of rows) {
    const bound = getExternalStoreMessages(row.message as never) as readonly unknown[];
    if (bound.length === 0) {
      throw new WriteBackAmbiguityError("missing-binding", [
        readPersistedId(row.message) ?? "<unidentified-row>",
      ]);
    }

    const rowId = readPersistedId(row.message);
    let parentId: string | null = null;
    if (row.parentId !== null) {
      const translated = lastPersistedIdByRowId.get(row.parentId);
      if (translated === undefined) {
        throw new WriteBackAmbiguityError("unresolvable-parent", [
          row.parentId,
          rowId ?? "<unidentified-row>",
        ]);
      }
      parentId = translated;
    }

    for (const persisted of bound) {
      const id = readPersistedId(persisted);
      if (id === null || !isPersistedMessage(persisted)) {
        throw new WriteBackAmbiguityError("invalid-persisted-message", [
          rowId ?? "<unidentified-row>",
        ]);
      }
      if (seen.has(id)) {
        throw new WriteBackAmbiguityError("duplicate-persisted-id", [id]);
      }
      seen.add(id);
      messages.push({ id, parentId, message: persisted });
      parentId = id;
    }

    if (rowId !== null) lastPersistedIdByRowId.set(rowId, messages[messages.length - 1]!.id);
  }

  return { messages, headId: messages.length === 0 ? null : messages[messages.length - 1]!.id };
}
