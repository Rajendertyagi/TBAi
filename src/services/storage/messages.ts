/**
 * Message persistence: rows, ordering, the parent chain, and the history window
 * the Direct transcript reads.
 *
 * ## Why this was split out of `storage/index.ts`
 *
 * See `conversations.ts` for the reasoning. The three aggregates were
 * independent; this one owns everything about a stored message and nothing about
 * the conversation that contains it.
 *
 * ## What is deliberately NOT here
 *
 * Conversation rows live in `conversations.ts`. `MessageOwnershipError` is
 * defined here rather than beside the conversation code because it describes a
 * message whose parent chain does not match - a message-integrity failure, not a
 * conversation lookup failure.
 */

import { db } from "../../db";
import { COMPACT_DIVIDER_PART_TYPE } from "../../lib/message-persistence-policy";
import type { SQLQueryBindings } from "bun:sqlite";

interface MessageRow {
  id: string;
  parent_id: string | null;
  format: string;
  content: string;
}

/**
 * A message id already belongs to a DIFFERENT conversation than the one the
 * write addressed.
 *
 * `messages.id` is the table PRIMARY KEY, so ids are globally unique. That makes
 * `ON CONFLICT(id) DO UPDATE` fire on the id ALONE, and `conversation_id` is
 * deliberately absent from that SET list — so without a guard the conflict path
 * overwrites the existing row's content/parent in place while the row keeps
 * pointing at its original owner. The result is one conversation silently
 * holding another conversation's bytes, and the addressed conversation gaining
 * nothing.
 *
 * This is a client-side ownership error (409), not a server fault: the request
 * named a row it may not write. Failing loudly is what keeps the wrong
 * conversation's history intact.
 */
export class MessageOwnershipError extends Error {
  constructor(
    readonly messageId: string,
    readonly targetConversationId: string,
    readonly ownerConversationId: string,
  ) {
    super(
      `Message ${messageId} belongs to conversation ${ownerConversationId}, not ${targetConversationId}`,
    );
    this.name = "MessageOwnershipError";
  }
}

/**
 * A stored message contradicts the history obligation that named it.
 *
 * Distinct from `MessageOwnershipError` (a client-side 409 about a request
 * addressing a row it does not own) and from `MessageVerificationError` (the write
 * did not land as asked): this one is a refusal to GUESS. The row exists, its
 * identity or its parent link provably disagrees with the claim, and either choice
 * could overwrite a reply or fork a chain. The caller leaves the obligation
 * unresolved and reports it; the row never becomes `done`.
 */
export type MessageIdentityReason = "identity" | "parent";

export class MessageIdentityError extends Error {
  constructor(
    readonly messageId: string,
    readonly reason: MessageIdentityReason,
  ) {
    super(`Message ${messageId} failed history identity verification: ${reason}`);
    this.name = "MessageIdentityError";
  }
}

/**
 * A message write did not produce the row it asked for.
 *
 * Raised only after the INSERT/UPDATE ran, so it describes a lost write rather
 * than a rejected one. It is retryable and is treated as an ordinary write
 * failure, never as an unresolved identity anomaly.
 */
export class MessageVerificationError extends Error {
  constructor(
    readonly messageId: string,
    readonly reason: "read_back_missing" | "content" | "parent",
  ) {
    super(`Message ${messageId} was not stored as written: ${reason}`);
    this.name = "MessageVerificationError";
  }
}

/** The entry shape the runtime's storage format adapter produces. */
export interface StoredMessageEntry {
  readonly id: string;
  readonly parent_id: string | null;
  readonly format: string;
  readonly content: unknown;
}

/** A stored message read back for verification, with its parsed body. */
export interface StoredMessageSnapshot {
  readonly id: string;
  readonly conversationId: string;
  readonly parentId: string | null;
  readonly format: string | null;
  readonly content: unknown;
}

/**
 * The outcome of reconciling a captured message against its stored row.
 *
 * `matched` means the stored row already holds this message (nothing was written).
 * `written` means there was no row. `repaired` means a row existed but did not
 * match the captured representation, so the captured one replaced it — the same
 * authority ordering `upsertStored` has always used on conflict.
 */
export type HistoryResolution = "matched" | "written" | "repaired";

/** What `resolveMessageForHistorySync` needs to reach one verdict. */
export interface HistoryMessageResolutionInput {
  /** The conversation the stream row proved ownership of. */
  readonly conversationId: string;
  /** The message id the claim recorded; null only for a corrupt claim. */
  readonly historyMessageId: string | null;
  readonly messageId: string;
  /** The exact object to persist, already stripped of its id. */
  readonly content: unknown;
  readonly parentId: string | null;
  readonly format: string;
}

function isCompactPart(part: unknown): boolean {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === COMPACT_DIVIDER_PART_TYPE
  );
}

/**
 * The comparable shape of a message body: its role and its non-presentation parts.
 *
 * `data-tbai-compact` parts (`COMPACT_DIVIDER_PART_TYPE`) are stripped and
 * `metadata`
 * is excluded because it is provider bookkeeping that the two writers do not agree
 * on — comparing it would rewrite rows whose content is already correct. Returns
 * null for a body that is not an object with a parts array, which includes a row
 * whose JSON would not parse; such a row cannot match and is therefore repaired.
 */
function canonicalMessageShape(content: unknown): { role: unknown; parts: unknown[] } | null {
  if (typeof content !== "object" || content === null) return null;
  const body = content as { role?: unknown; parts?: unknown };
  if (!Array.isArray(body.parts)) return null;
  return { role: body.role ?? null, parts: body.parts.filter((part) => !isCompactPart(part)) };
}

function canonicalShapesEqual(a: unknown, b: unknown): boolean {
  const left = canonicalMessageShape(a);
  const right = canonicalMessageShape(b);
  if (left === null || right === null) return false;
  return left.role === right.role && JSON.stringify(left.parts) === JSON.stringify(right.parts);
}

/** Read one stored message by (conversation, id), or null. Never throws on bad JSON. */
export function getStoredMessageSync(
  conversationId: string,
  messageId: string,
): StoredMessageSnapshot | null {
  const row = db
    .query<
      {
        id: string;
        conversation_id: string;
        parent_id: string | null;
        format: string | null;
        content: string;
      },
      SQLQueryBindings[]
    >(
      "SELECT id, conversation_id, parent_id, format, content FROM messages WHERE conversation_id = ? AND id = ?",
    )
    .get(conversationId, messageId);
  if (!row) return null;
  let content: unknown = null;
  try {
    content = JSON.parse(row.content);
  } catch {
    // A row whose body will not parse cannot match a capture, so it is repaired
    // rather than treated as an identity conflict.
    content = null;
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    format: row.format,
    content,
  };
}

/**
 * Resolve one captured message against history, inside the caller's transaction.
 *
 * Called by the history guard as its verification step, so every read here happens
 * after the guard has taken SQLite's write lock and shares the guard's transaction:
 * the read, the write, and the `claimed`→`done` transition commit together or not
 * at all.
 *
 * The decisions, in order:
 *  1. IDENTITY. The claim recorded which message it meant to write. A different id
 *     — including a NULL one, which `claimHistory` cannot produce — is an anomaly,
 *     not a race: nothing is written and the row stays open.
 *  2. PARENT. The captured parent is authoritative, with the same
 *     null-never-downgrades-a-real-parent rule `upsertStored` applies, and it
 *     must RESOLVE to a row of this conversation. A self-link, a parent row in
 *     another conversation, and a parent with no row at all are one class of
 *     defect: a link this reply cannot legally hang from, so nothing is written
 *     and the row stays open.
 *
 *     The absent case is an anomaly rather than the normal shape because the
 *     conversation's history is READ by walking `parent_id`. `getHeadChain` and
 *     `getWindowSlice` fail closed on a dangling link — `complete: false`, and
 *     "a missing parent is NOT a legitimate root" — so a reply written under one
 *     would leave the whole chain unprovable, not merely its own row unreachable.
 *     The parent row is normally present: the browser persists the user message a
 *     run continued, through this same table's HTTP route
 *     (`web/src/adapters/threadHistoryAdapter.ts` → `POST
 *     /api/conversations/:id/messages`, measured in `Composer.tsx`), before the
 *     run settles. An absent parent is a partial-write state.
 *  3. OWNERSHIP. A row with this id in another conversation is refused by
 *     `upsertStoredSync` (`MessageOwnershipError`), so it can never be repointed.
 *  4. CONTENT. Canonical role + parts decide `matched`; anything else means the
 *     captured representation wins and the row is repaired.
 *
 * Throws `MessageIdentityError` for (1)/(2), `MessageOwnershipError` for (3) — both
 * roll the transaction back — and `MessageVerificationError` when the read-back
 * disagrees with what was written.
 *
 * @returns `matched`, `written`, or `repaired`.
 */
export function resolveMessageForHistorySync(
  input: HistoryMessageResolutionInput,
): HistoryResolution {
  const { conversationId, historyMessageId, messageId, content, parentId, format } = input;

  if (historyMessageId !== messageId) {
    throw new MessageIdentityError(messageId, "identity");
  }

  const stored = getStoredMessageSync(conversationId, messageId);
  // The effective parent preserves a real stored link against a null capture, the
  // rule `upsertStored` documents; it is what the row must hold afterwards.
  const effectiveParent =
    stored && stored.parentId !== null && parentId === null ? stored.parentId : parentId;

  if (parentId !== null) {
    if (parentId === messageId) throw new MessageIdentityError(messageId, "parent");
    // One query answers both halves: no row at all and a row in another
    // conversation are the same defect (a parent this reply cannot hang from),
    // and both leave the claim open rather than writing an unprovable link.
    const owner = db
      .query<{ conversation_id: string }, SQLQueryBindings[]>(
        "SELECT conversation_id FROM messages WHERE id = ?",
      )
      .get(parentId);
    if (!owner || owner.conversation_id !== conversationId) {
      throw new MessageIdentityError(messageId, "parent");
    }
  }

  if (
    stored &&
    stored.format === format &&
    stored.parentId === effectiveParent &&
    canonicalShapesEqual(stored.content, content)
  ) {
    return "matched";
  }

  upsertStoredSync(conversationId, { id: messageId, parent_id: parentId, format, content });

  const back = getStoredMessageSync(conversationId, messageId);
  if (!back) throw new MessageVerificationError(messageId, "read_back_missing");
  if (back.parentId !== effectiveParent) throw new MessageVerificationError(messageId, "parent");
  if (!canonicalShapesEqual(back.content, content)) {
    throw new MessageVerificationError(messageId, "content");
  }
  return stored ? "repaired" : "written";
}

function extractTextFromParts(parts: unknown[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => {
      if (typeof p !== "object" || p === null) return false;
      const part = p as { type?: unknown; text?: unknown };
      // Explicitly allow only "text" parts; exclude dynamic-tool, tool-*, reasoning, file, image, source-url, source-document
      if (part.type !== "text") return false;
      return typeof part.text === "string";
    })
    .map((p) => p.text)
    .join(" ")
    .trim();
}

/**
 * Extracts plain text from an assistant-ui ThreadMessage for use as an
 * auto-generated conversation title.
 *
 * Evaluates strictly in order:
 * (a) rec.parts (Array.isArray) — authoritative AI SDK v7 / assistant-ui shape
 * (b) rec.content (Array.isArray) — legacy parts array
 * (c) rec.content (string) — legacy flat text
 * (d) Array.isArray(message) — rare legacy array-at-root format
 */
export function threadMessageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const rec = message as Record<string, unknown>;

  // (a) rec.parts (Array.isArray)
  if (Array.isArray(rec.parts)) {
    const text = extractTextFromParts(rec.parts);
    if (text) return text;
  }

  // (b) rec.content (Array.isArray)
  if (Array.isArray(rec.content)) {
    const text = extractTextFromParts(rec.content);
    if (text) return text;
  }

  // (c) rec.content (string)
  if (typeof rec.content === "string") {
    const text = rec.content.trim();
    if (text) return text;
  }

  // (d) message itself is an array
  if (Array.isArray(message)) {
    const text = extractTextFromParts(message);
    if (text) return text;
  }

  return "";
}

/** One row of the persisted head chain, in root-to-tip order. */
export interface HeadChainMessage {
  readonly id: string;
  readonly parent_id: string | null;
  readonly format: string;
  readonly content: unknown;
}

/**
 * A walk of the persisted head chain, and whether that walk is trustworthy.
 *
 * `complete` is the authority a caller must check before treating `messages` as
 * the full history: it is true only when the walk proved it reached a legitimate
 * root (a row whose `parent_id` IS NULL) with every row parseable.
 */
export interface HeadChain {
  readonly messages: readonly HeadChainMessage[];
  readonly complete: boolean;
}

/**
 * A bounded, contiguous run of the selected chain, for the P2 Direct history
 * window. See `messageService.getWindowSlice` for why this is not pagination.
 */
export interface HistoryWindowSlice {
  /** Contiguous run on the selected chain, oldest-first. */
  readonly messages: readonly HeadChainMessage[];
  /** The selected chain continues before / after this run. */
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  /**
   * P1' fail-closed signal. False when the walk could not prove it reached a
   * legitimate root or a row would not parse. A caller must not treat an
   * incomplete slice as the whole selected history.
   */
  readonly complete: boolean;
  /**
   * P2 window integrity. True when the walk itself is sound: every row parsed,
   * the parent chain is unbroken, and the run does not end on a parent link that
   * cannot be resolved. Deliberately NOT `complete`: a bounded page is expected
   * to stop short of the root, so a client that needs a trustworthy page reads
   * this one.
   */
  readonly contiguous: boolean;
}

/**
 * Hard ceiling on how far the `newer` direction may descend from the tip.
 *
 * `newer` cannot be answered from the anchor alone (siblings are
 * indistinguishable from any other row), so it descends from the tip. The
 * ceiling keeps a pathological chain from turning one page request into an
 * unbounded scan; hitting it reports `complete: false` rather than silently
 * returning a short run.
 */
export const WINDOW_SCAN_CEILING = 5000;

function toChainMessage(row: MessageRow, content: unknown): HeadChainMessage {
  return { id: row.id, parent_id: row.parent_id, format: row.format, content };
}

/**
 * Upserts one stored message entry (keyed by message id).
 *
 * The entry is the runtime's storage format (`{ id, parent_id, format, content }`);
 * `content` is an opaque serialized object produced by the runtime's format
 * adapter and is stored verbatim so it can be restored on reload.
 *
 * Synchronous on purpose: `messageService.upsertStored` is this function, and the
 * history guard calls it directly inside its transaction. An async wrapper would
 * not be transactional - `db.transaction` does not await a promise-returning
 * callback, so the callback's writes would land outside the transaction.
 *
 * ## A null parent never overwrites a real one
 *
 * `parent_id` is only meaningful at CREATION. Downgrading an existing link to
 * null (`X -> null`) is never a legitimate update: every real re-parent - an
 * edit, a regenerate, a branch switch, the scheduler chaining a run onto the
 * tip - supplies a NON-null parent, because each of those genuinely knows
 * where the message now hangs.
 *
 * It is, however, exactly what a BOUNDED WINDOW produces. The window's oldest
 * row has no parent inside the window, so the repository seed hands it
 * `parentId: null` (`windowController.withBoundedRoot`, and the same shape in
 * `threadHistoryAdapter`). Paging prepends a page through the runtime, which
 * persists it, so the synthesized root used to overwrite a perfectly good
 * stored parent and FORK the chain. Measured: after one "Load earlier" the
 * stored chain gained a second root, the backend then correctly reported
 * "root reached" at that message, and paging could never advance again.
 *
 * Keeping the stored link is therefore fail-closed and data-preserving: it
 * refuses a write that would silently discard history it already holds.
 *
 * @throws {MessageOwnershipError} when `entry.id` already names a row in another
 *   conversation.
 */
export function upsertStoredSync(conversationId: string, entry: StoredMessageEntry): void {
  const now = Date.now();
  // Ownership is read WITH the conversation scope, and checked before anything
  // is written: `id` alone is not a sufficient key for this decision, because
  // the conflict path below mutates the existing row in place.
  const existing = db
    .query<
      { conversation_id: string; order_seq: number; parent_id: string | null },
      SQLQueryBindings[]
    >("SELECT conversation_id, order_seq, parent_id FROM messages WHERE id = ?")
    .get(entry.id);
  if (existing && existing.conversation_id !== conversationId) {
    throw new MessageOwnershipError(entry.id, conversationId, existing.conversation_id);
  }
  const parentId =
    existing && existing.parent_id !== null && entry.parent_id === null
      ? existing.parent_id
      : entry.parent_id;
  const orderSeq = existing
    ? existing.order_seq
    : (db
        .query<{ next: number }, SQLQueryBindings[]>(
          "SELECT COALESCE(MAX(order_seq), -1) + 1 AS next FROM messages WHERE conversation_id = ?",
        )
        .get(conversationId)?.next ?? -1);

  // The `WHERE` is defence in depth, not the primary guard: it makes the
  // ownership invariant hold inside the statement itself, so a future caller
  // that reaches this SQL without the check above still cannot repoint or
  // overwrite another conversation's row.
  db.run(
    `INSERT INTO messages (id, conversation_id, role, content, parent_id, order_seq, status, format, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       parent_id = excluded.parent_id,
       format = excluded.format,
       updated_at = excluded.updated_at
     WHERE messages.conversation_id = excluded.conversation_id`,
    [
      entry.id,
      conversationId,
      null,
      JSON.stringify(entry.content),
      parentId,
      orderSeq,
      null,
      entry.format,
      now,
      now,
    ],
  );

  // Auto-title: name the conversation from the first user message text.
  // Only fires when title_source is NULL (new thread) or explicitly 'auto';
  // user-assigned titles are never overwritten by scheduler or chat runs.
  const userText = threadMessageText(entry.content);
  if (userText) {
    const conv = db
      .query<{ title: string; title_source: string | null }, SQLQueryBindings[]>(
        "SELECT title, title_source FROM conversations WHERE id = ?",
      )
      .get(conversationId);
    if (conv && (conv.title === "New Conversation" || conv.title_source === "auto")) {
      const title = userText.length > 50 ? `${userText.slice(0, 50)}…` : userText;
      db.run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", [
        title,
        now,
        conversationId,
      ]);
    }
  }
}

export const messageService = {
  /**
   * Id of the thread tip (latest message by order) or null when empty.
   * Scheduler runs chain onto the tip so appended messages join the
   * visible tree instead of forming invisible disconnected roots.
   */
  async getThreadTip(conversationId: string): Promise<string | null> {
    const row = db
      .query<{ id: string }, SQLQueryBindings[]>(
        "SELECT id FROM messages WHERE conversation_id = ? ORDER BY order_seq DESC LIMIT 1",
      )
      .get(conversationId);
    return row?.id ?? null;
  },

  /**
   * Walk the selected parent_id chain from the tip back to the root.
   *
   * This is the semantic authority for conversation history. The chain is
   * reconstructed by following parent_id links, NOT by order_seq range.
   * Off-branch siblings and detached rows are excluded by construction.
   *
   * ## Completeness
   *
   * `complete` is the fail-closed signal. It is true ONLY when the walk reached a
   * legitimate root — a row whose `parent_id` IS NULL — after visiting every link
   * with parseable content. It is false when:
   *
   * - a parent row is missing (a dangling `parent_id`, so the walk cannot prove it
   *   has reached the root and the messages above the break are unreachable), or
   * - a row's stored content could not be parsed, so that row cannot be handed
   *   back and the returned array would be shorter than the real chain, or
   * - the conversation has no messages at all.
   *
   * A truncated chain is NOT a shorter-but-valid chain: callers must not splice it
   * into a request, because everything above the break would be silently dropped.
   *
   * @returns Root-to-tip messages (oldest first) plus whether the walk completed.
   */
  async getHeadChain(conversationId: string): Promise<HeadChain> {
    // Consistent read: wrap the tip lookup and chain walk in a single
    // transaction so no concurrent write can produce a partially mixed chain.
    return db.transaction((): HeadChain => {
      const tipRow = db
        .query<{ id: string }, SQLQueryBindings[]>(
          "SELECT id FROM messages WHERE conversation_id = ? ORDER BY order_seq DESC LIMIT 1",
        )
        .get(conversationId);
      const tip = tipRow?.id ?? null;
      if (!tip) return { messages: [], complete: false };

      const chain: HeadChainMessage[] = [];
      let currentId: string | null = tip;
      let complete = true;

      while (currentId) {
        const row = db
          .query<MessageRow, SQLQueryBindings[]>(
            "SELECT id, parent_id, format, content FROM messages WHERE conversation_id = ? AND id = ?",
          )
          .get(conversationId, currentId);

        // A missing parent is NOT a legitimate root: the loop only exits normally
        // when a row's own parent_id is NULL. Anything else means the walk cannot
        // prove it reached the root.
        if (!row) {
          complete = false;
          break;
        }

        let content: unknown = null;
        try {
          content = JSON.parse(row.content);
        } catch {
          content = null;
        }

        // Same reasoning as a dangling parent: this row cannot be returned, so the
        // array would under-report the chain. Fail closed rather than splice it.
        if (content === null) {
          complete = false;
          break;
        }

        chain.unshift({
          id: row.id,
          parent_id: row.parent_id,
          format: row.format,
          content,
        });

        currentId = row.parent_id;
      }

      return { messages: chain, complete };
    })();
  },

  /**
   * A bounded, contiguous slice of the SELECTED chain, for the P2 Direct
   * history window.
   *
   * ## Why this is not pagination
   *
   * This deliberately does NOT page by `order_seq`. P1' made the parent-linked
   * walk the semantic authority, and an `order_seq` range would happily return
   * off-branch siblings and detached rows while looking perfectly well-formed.
   * Both slices below are produced by following `parent_id`, so single-branch
   * membership and contiguity hold **by construction** rather than by
   * inspection — there is no code path here that can assemble a sibling.
   *
   * `order_seq` appears exactly once, for picking the chain's **tip** (the row
   * written most recently). That is the same tip `getHeadChain` selects, so the
   * window and P1' can never disagree about where the chain ends.
   *
   * ## Directions
   *
   * - `older` walks back from `anchorId` toward the root. Bounded by the
   *   recursive depth limit, so cost is O(page), independent of chain length.
   * - `newer` must produce messages that lie between the anchor and the tip.
   *   "Which child of this message is on the selected branch" is only
   *   answerable by descending from the tip, because siblings are
   *   indistinguishable from any other row. So `newer` walks down from the tip
   *   and keeps the run it finds at/after the anchor.
   *
   * ## Fail-closed
   *
   * `complete` is false when the walk could not prove it reached a legitimate
   * root (dangling `parent_id`) or when a row's stored content would not parse.
   * A caller must not splice an incomplete slice into model-visible history.
   */
  async getWindowSlice(
    conversationId: string,
    params: {
      readonly direction: "older" | "newer";
      readonly anchorId: string | null;
      readonly limit: number;
    },
  ): Promise<HistoryWindowSlice> {
    const limit = Math.max(1, Math.floor(params.limit));

    return db.transaction((): HistoryWindowSlice => {
      const tipRow = db
        .query<{ id: string }, SQLQueryBindings[]>(
          "SELECT id FROM messages WHERE conversation_id = ? ORDER BY order_seq DESC LIMIT 1",
        )
        .get(conversationId);
      const tip = tipRow?.id ?? null;

      // ## An empty conversation is a PROVEN answer, not a failed walk
      //
      // `contiguous` answers exactly one question: "is this slice internally
      // trustworthy?" — i.e. did the parent-linked walk hold together. A
      // conversation with no messages never starts that walk, so there is
      // nothing that could have been untrustworthy: the empty set IS the truth.
      //
      // Reporting it as `contiguous: false` made the client refuse the one
      // answer it had asked for. `WindowController#commit` checks `contiguous`
      // BEFORE its empty-slice branch, so a zero-message conversation threw
      // `incomplete-slice`, was recorded as a FAILED history load, and burned a
      // recovery retry on every re-entry — all for a thread that was simply new.
      //
      // `complete` stays `false`: it answers a different question ("did the walk
      // reach a legitimate root"), and no walk happened. Keeping the two signals
      // distinct is the whole point of having both.
      if (!tip)
        return {
          messages: [],
          hasMoreBefore: false,
          hasMoreAfter: false,
          complete: false,
          contiguous: true,
        };

      // A caller-supplied anchor that names no row in THIS conversation is a
      // different case and stays fail-closed: the client asked for a position it
      // cannot vouch for, and silently substituting an empty answer would hide a
      // stale or cross-conversation anchor.
      const empty = {
        messages: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
        complete: false,
        contiguous: false,
      };

      // Older paging anchors on an explicit id and walks back toward the root.
      // Newer paging MUST walk from the tip instead: "which child of the anchor
      // comes next" is not answerable from the anchor alone, because siblings
      // are indistinguishable from any other row. A null anchor means "start at
      // the tip" for BOTH directions — that is the initial load of an empty
      // window, and walking `older` from the tip is exactly the bounded tail.
      // (Reading the anchor only for `older` made the initial load return an
      // empty, incomplete slice, so a bounded thread never rendered at all.)
      const startId =
        params.anchorId === null || params.direction === "newer" ? tip : params.anchorId;
      if (startId === null) return empty;

      const anchoredRow = db
        .query<{ id: string }, SQLQueryBindings[]>(
          "SELECT id FROM messages WHERE conversation_id = ? AND id = ?",
        )
        .get(conversationId, startId);
      if (!anchoredRow) return empty;

      // Older needs one extra hop to know whether more exists before the page;
      // newer must reach the root to locate the anchor within the chain.
      const depthLimit = params.direction === "older" ? limit + 1 : WINDOW_SCAN_CEILING;

      const rows = db
        .query<MessageRow, SQLQueryBindings[]>(
          `WITH RECURSIVE chain(id, parent_id, format, content, depth) AS (
             SELECT id, parent_id, format, content, 0
               FROM messages WHERE conversation_id = ?1 AND id = ?2
             UNION ALL
             SELECT m.id, m.parent_id, m.format, m.content, chain.depth + 1
               FROM messages m
               JOIN chain ON m.id = chain.parent_id
              WHERE m.conversation_id = ?1 AND chain.depth < ?3
           )
           SELECT id, parent_id, format, content, depth FROM chain ORDER BY depth ASC`,
        )
        .all(conversationId, startId, depthLimit);

      const messages: HeadChainMessage[] = [];
      let complete = true;

      // A gap in the walk means a parent row is missing: the walk cannot prove
      // it reached a legitimate root.
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        let content: unknown = null;
        try {
          content = JSON.parse(row.content);
        } catch {
          content = null;
        }
        if (content === null) {
          complete = false;
          break;
        }
        if (i === 0) {
          messages.unshift(toChainMessage(row, content));
          continue;
        }
        if (row.id !== rows[i - 1].parent_id) {
          complete = false;
          break;
        }
        messages.unshift(toChainMessage(row, content));
      }

      // Integrity, captured BEFORE the root check below: "is the walk itself
      // sound", with no notion of how far it reached.
      let contiguous = complete;

      const rootReached = rows.length > 0 && rows[rows.length - 1].parent_id === null;
      if (!rootReached) complete = false;

      // `contiguous` is the INTEGRITY signal, and it is deliberately separate
      // from `complete`. `complete` answers "did this walk reach a legitimate
      // root", which P1' owns and depends on: a bounded mid-chain window is
      // correctly `complete: false`. A window client needs a different question
      // answered — "is this slice internally trustworthy?" — because a page that
      // stops short of the root is the whole point of a bounded load, while a page
      // with a hole in it is not a page at all.
      //
      // Collapsing the two made every initial bounded load of a long thread look
      // untrustworthy, so the client refused the very window it asked for and
      // rendered an empty thread. The walk's own integrity is therefore reported
      // here: the loop above already breaks on an unparsable row or a broken
      // parent link, and a walk ending on a parent link it cannot resolve is
      // detached rather than merely depth-limited.
      const lastRow = rows[rows.length - 1];
      if (contiguous && lastRow && lastRow.parent_id !== null) {
        const parentExists = db
          .query<{ id: string }, SQLQueryBindings[]>(
            "SELECT id FROM messages WHERE conversation_id = ? AND id = ?",
          )
          .get(conversationId, lastRow.parent_id);
        if (!parentExists) contiguous = false;
      }

      // `older` returns the run ending at the anchor, oldest-first, trimmed to
      // the page. `newer` returns the run starting at the anchor, trimmed to
      // the page, walking down from the tip.
      let selected: HeadChainMessage[];
      let hasMoreBefore: boolean;
      let hasMoreAfter: boolean;

      if (params.direction === "older") {
        // `messages` is root-to-anchor, oldest first. The page is the newest
        // `limit` entries, because the anchor end is what the user is looking at.
        const hasMore = messages.length > limit;
        selected = hasMore ? messages.slice(messages.length - limit) : messages;
        hasMoreBefore = hasMore;
        hasMoreAfter = selected.length > 0 && selected[selected.length - 1].id !== tip;
      } else {
        // The CTE starts at the tip, but the walk `unshift`s each hop toward the
        // root, so `messages` is ROOT-FIRST — the same orientation `older`
        // produces. Verified against the raw CTE output, which comes back
        // tip-first (depth ascending) and is reversed by that unshift.
        //
        // Paging newer therefore means taking the run FORWARD from the anchor.
        //
        // An anchor that is not on the tip's chain is off-branch: it cannot be
        // placed on the selected path, so it yields nothing rather than a guess.
        // The WALK starts at the tip so the whole selected branch is visible,
        // but the PAGE starts at the requested anchor. Conflating the two
        // collapses every newer page to a single message at the tip.
        // A null anchor means "an empty window": hand back the TIP-most page,
        // not the root-most one, because that is the end the user is at.
        const anchorIndex =
          params.anchorId === null
            ? Math.max(0, messages.length - limit)
            : messages.findIndex((m) => m.id === params.anchorId);
        if (anchorIndex < 0) return empty;
        const forward = messages.slice(anchorIndex);
        selected = forward.slice(0, limit);
        hasMoreAfter = forward.length > selected.length;
        hasMoreBefore = selected.length > 0 && selected[0].parent_id !== null;
      }

      return { messages: selected, hasMoreBefore, hasMoreAfter, complete, contiguous };
    })();
  },

  /**
   * Whether a stored message id already exists, scoped to its conversation.
   *
   * The existence check server-side history finalization needs to tell "nobody
   * wrote this reply" apart from "the client wrote it and I am merely late". An
   * id is unique across the table, so the conversation scope is a guard against a
   * cross-conversation id collision, not a lookup narrowing.
   */
  async hasStoredMessage(conversationId: string, messageId: string): Promise<boolean> {
    const row = db
      .query<{ id: string }, SQLQueryBindings[]>(
        "SELECT id FROM messages WHERE conversation_id = ? AND id = ?",
      )
      .get(conversationId, messageId);
    return row !== null && row !== undefined;
  },

  /**
   * Whether the conversation currently ENDS with an assistant reply.
   *
   * This is the one fact that separates "this thread is fine" from "this thread is
   * missing its answer", and it is deliberately NOT read off `chat_streams`:
   * in the normal path the BROWSER persists the reply and the server never claims
   * the history obligation, so `history_state` stays `pending` for a perfectly
   * healthy conversation and cannot distinguish the two cases. The message list
   * itself is the authority on whether a reply is there.
   *
   * The `role` column is never populated (it is NULL on every row); the role lives
   * inside the assistant-ui storage payload, so it is read from the JSON body.
   *
   * Scoped to the newest message on purpose: it answers "is the user looking at a
   * complete conversation right now", and never re-litigates a reply lost several
   * turns ago, which is unrecoverable and un-actionable.
   */
  async endsWithReply(conversationId: string): Promise<boolean> {
    const row = db
      .query<{ role: string | null }, SQLQueryBindings[]>(
        `SELECT json_extract(content, '$.role') AS role
           FROM messages WHERE conversation_id = ? ORDER BY order_seq DESC LIMIT 1`,
      )
      .get(conversationId);
    return row?.role === "assistant";
  },

  /**
   * Upserts a single stored message entry (keyed by message id). Called by the
   * ThreadHistoryAdapter's `withFormat` adapter on every append/update during a
   * run.
   *
   * Delegates to `upsertStoredSync` so the history guard can run the SAME write
   * inside its transaction; there is exactly one message-write implementation.
   */
  async upsertStored(conversationId: string, entry: StoredMessageEntry): Promise<void> {
    upsertStoredSync(conversationId, entry);
  },

  /**
   * Returns the persisted stored entries for a conversation, in order, in the
   * shape the runtime's format adapter expects (`{ id, parent_id, format,
   * content }`).
   */
  async listThreadMessages(
    conversationId: string,
  ): Promise<Array<{ id: string; parent_id: string | null; format: string; content: unknown }>> {
    const rows = db
      .query<MessageRow, SQLQueryBindings[]>(
        "SELECT id, parent_id, format, content FROM messages WHERE conversation_id = ? ORDER BY order_seq ASC, created_at ASC",
      )
      .all(conversationId);
    return rows
      .map((row) => {
        let content: unknown = null;
        try {
          content = JSON.parse(row.content);
        } catch {
          content = null;
        }
        return {
          id: row.id,
          parent_id: row.parent_id,
          format: row.format,
          content,
        };
      })
      .filter((r) => r.content !== null);
  },

  async deleteThreadMessage(conversationId: string, messageId: string): Promise<void> {
    db.run("DELETE FROM messages WHERE conversation_id = ? AND id = ?", [
      conversationId,
      messageId,
    ]);
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    db.run("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
  },
};
