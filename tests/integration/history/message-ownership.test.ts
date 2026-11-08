import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@/db";
import { conversationService, messageService } from "@/services/storage";
import { conversationInput } from "../../helpers/conversation-fixtures";

/**
 * Message ownership: a stored message belongs to exactly one conversation.
 *
 * `messages.id` is the table's PRIMARY KEY, so ids are globally unique by
 * construction. `upsertStored` therefore has two jobs that are easy to conflate:
 *
 *   1. upsert a message INTO the conversation the caller addressed, and
 *   2. never let a write addressed to conversation B mutate a row that
 *      conversation A owns.
 *
 * The second job is not automatic. `ON CONFLICT(id) DO UPDATE` fires on the id
 * alone, and `conversation_id` is deliberately absent from the SET list, so the
 * conflict path overwrites the EXISTING row's content/parent in place. Without
 * an ownership check the row keeps pointing at A while holding B's bytes.
 *
 * These tests pin the boundary: idempotence and parent preservation WITHIN the
 * owning conversation, and refusal ACROSS conversations.
 */

let A = "";
let B = "";

async function newConversation(title: string): Promise<string> {
  await conversationService.create(conversationInput({ title }));
  return db
    .query<{ id: string }, [string]>(
      "SELECT id FROM conversations WHERE title = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(title)!.id;
}

const row = (id: string) =>
  db
    .query<
      {
        id: string;
        conversation_id: string;
        parent_id: string | null;
        content: string;
        format: string;
      },
      [string]
    >("SELECT id, conversation_id, parent_id, content, format FROM messages WHERE id = ?")
    .get(id);

const payload = (text: string) => ({ parts: [{ type: "text", text }] });

beforeEach(async () => {
  A = await newConversation("own A");
  B = await newConversation("own B");
});

afterEach(() => {
  for (const id of [A, B]) if (id) messageService.deleteByConversation(id);
});

describe("message ownership — same conversation", () => {
  it("a legitimate upsert writes the row into the addressed conversation", async () => {
    await messageService.upsertStored(A, {
      id: "m1",
      parent_id: null,
      format: "raw",
      content: payload("a1"),
    });

    const stored = row("m1");
    expect(stored).toBeDefined();
    expect(stored!.conversation_id).toBe(A);
    expect(JSON.parse(stored!.content).parts[0].text).toBe("a1");
  });

  it("a repeated upsert of the same id is idempotent (one row, same order_seq)", async () => {
    const first = await messageService.getWindowSlice(A, {
      direction: "older",
      anchorId: null,
      limit: 10,
    });
    await messageService.upsertStored(A, {
      id: "m1",
      parent_id: null,
      format: "raw",
      content: payload("a1"),
    });
    const seqAfterFirst = db
      .query<{ order_seq: number }, [string]>("SELECT order_seq FROM messages WHERE id = ?")
      .get("m1")!.order_seq;

    await messageService.upsertStored(A, {
      id: "m1",
      parent_id: null,
      format: "raw",
      content: payload("a1-again"),
    });
    await messageService.upsertStored(A, {
      id: "m1",
      parent_id: null,
      format: "raw",
      content: payload("a1-again"),
    });

    const count = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE id = ?")
      .get("m1")!.n;
    const seqAfterRepeat = db
      .query<{ order_seq: number }, [string]>("SELECT order_seq FROM messages WHERE id = ?")
      .get("m1")!.order_seq;

    expect(count).toBe(1);
    expect(seqAfterRepeat).toBe(seqAfterFirst);
    expect(JSON.parse(row("m1")!.content).parts[0].text).toBe("a1-again");
    expect(first.messages).toEqual([]);
  });

  it("a re-upsert that omits parent_id preserves the stored parent (no silent re-fork)", async () => {
    await messageService.upsertStored(A, {
      id: "m1",
      parent_id: null,
      format: "raw",
      content: payload("a1"),
    });
    await messageService.upsertStored(A, {
      id: "m2",
      parent_id: "m1",
      format: "raw",
      content: payload("a2"),
    });

    // This is the write `withFormat` performs after a bounded-window load, where
    // the window root's parent is clipped to null because its real parent lies
    // outside the window. It must not rewrite the stored link.
    await messageService.upsertStored(A, {
      id: "m2",
      parent_id: null,
      format: "raw",
      content: payload("a2"),
    });

    expect(row("m2")!.parent_id).toBe("m1");
  });
});

describe("the ownership invariant holds inside SQL, not only in the pre-read", () => {
  /**
   * `upsertStored` guards with a pre-read and THEN writes. A pre-read alone is
   * not an invariant: two writers can both observe "no such row" and then race
   * into the same primary key. The statement therefore carries its own clause —
   * `ON CONFLICT(id) DO UPDATE … WHERE messages.conversation_id =
   * excluded.conversation_id` — and that clause is what actually holds the line.
   *
   * This case drives the STATEMENT directly, bypassing the guard on purpose. It
   * is exactly the losing side of that race: the row already exists and belongs
   * to A, and the writer believes it is inserting into B.
   */
  it("the conflict clause refuses to overwrite another conversation's row", async () => {
    await messageService.upsertStored(A, {
      id: "race",
      parent_id: null,
      format: "raw",
      content: payload("owned-by-A"),
    });
    const before = row("race")!;

    // Same statement `upsertStored` issues, with B's conversation id, and with
    // no guard in front of it.
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
        "race",
        B,
        null,
        JSON.stringify(payload("from-B")),
        "some-other-parent",
        999,
        null,
        "other-format",
        1,
        Date.now(),
      ],
    );

    const after = row("race")!;
    expect(after.conversation_id).toBe(A);
    expect(after.content).toBe(before.content);
    expect(after.parent_id).toBe(before.parent_id);
    expect(after.format).toBe(before.format);
  });

  it("the same clause still permits a legitimate same-conversation update", async () => {
    await messageService.upsertStored(A, {
      id: "race2",
      parent_id: null,
      format: "raw",
      content: payload("v1"),
    });

    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, parent_id, order_seq, status, format, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         parent_id = excluded.parent_id,
         format = excluded.format,
         updated_at = excluded.updated_at
       WHERE messages.conversation_id = excluded.conversation_id`,
      ["race2", A, null, JSON.stringify(payload("v2")), null, 999, null, "raw", 1, Date.now()],
    );

    const after = row("race2")!;
    expect(after.conversation_id).toBe(A);
    expect(JSON.parse(after.content).parts[0].text).toBe("v2");
  });

  it("concurrent writes of one id to two conversations leave exactly one owner and no corruption", async () => {
    await Promise.allSettled([
      messageService.upsertStored(A, {
        id: "race3",
        parent_id: null,
        format: "raw",
        content: payload("from-A"),
      }),
      messageService.upsertStored(B, {
        id: "race3",
        parent_id: null,
        format: "raw",
        content: payload("from-B"),
      }),
    ]);

    // Whoever won, there is exactly ONE row, it belongs to one conversation, and
    // its bytes belong to that same conversation.
    const owners = db
      .query<{ n: number; conversation_id: string; content: string }, [string]>(
        "SELECT COUNT(*) AS n, MIN(conversation_id) AS conversation_id, MIN(content) AS content FROM messages WHERE id = ?",
      )
      .get("race3")!;
    expect(owners.n).toBe(1);

    const stored = row("race3")!;
    const text = JSON.parse(stored.content).parts[0].text as string;
    expect(text).toBe(stored.conversation_id === A ? "from-A" : "from-B");
  });
});

describe("message ownership — cross-conversation", () => {
  it("REFUSES a write whose id is owned by another conversation, and mutates nothing", async () => {
    await messageService.upsertStored(A, {
      id: "shared",
      parent_id: null,
      format: "raw",
      content: payload("owned-by-A"),
    });
    const before = row("shared")!;

    let refused: unknown = null;
    try {
      await messageService.upsertStored(B, {
        id: "shared",
        parent_id: null,
        format: "raw",
        content: payload("from-B"),
      });
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(Error);

    const after = row("shared")!;
    // A is untouched: same owner, same bytes, same parent, same format.
    expect(after.conversation_id).toBe(A);
    expect(after.conversation_id).toBe(before.conversation_id);
    expect(after.content).toBe(before.content);
    expect(after.parent_id).toBe(before.parent_id);
    expect(after.format).toBe(before.format);

    // B never gained the row.
    const inB = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?",
      )
      .get(B)!.n;
    expect(inB).toBe(0);
  });

  it("REFUSES a cross-conversation write even when it would otherwise preserve the parent", async () => {
    await messageService.upsertStored(A, {
      id: "m1",
      parent_id: null,
      format: "raw",
      content: payload("a1"),
    });
    await messageService.upsertStored(A, {
      id: "m2",
      parent_id: "m1",
      format: "raw",
      content: payload("a2"),
    });

    expect(
      messageService.upsertStored(B, {
        id: "m2",
        parent_id: null,
        format: "raw",
        content: payload("from-B"),
      }),
    ).rejects.toThrow();

    expect(JSON.parse(row("m2")!.content).parts[0].text).toBe("a2");
    expect(row("m2")!.conversation_id).toBe(A);
  });

  it("a rejected cross-conversation write leaves the addressed conversation writable", async () => {
    await messageService.upsertStored(A, {
      id: "shared",
      parent_id: null,
      format: "raw",
      content: payload("owned-by-A"),
    });
    await messageService
      .upsertStored(B, { id: "shared", parent_id: null, format: "raw", content: payload("from-B") })
      .catch(() => undefined);

    // B's own distinct ids still write normally — the refusal is scoped to the
    // colliding id, not a poisoned conversation.
    await messageService.upsertStored(B, {
      id: "b1",
      parent_id: null,
      format: "raw",
      content: payload("b1"),
    });
    expect(row("b1")!.conversation_id).toBe(B);
    expect(row("shared")!.conversation_id).toBe(A);
  });
});
