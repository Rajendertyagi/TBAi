import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@/db";
import { conversationService, messageService } from "@/services/storage";
import { conversationInput } from "../../helpers/conversation-fixtures";

/**
 * P2 backend support: the bounded history-window slice.
 *
 * The contract these tests defend is that storage pagination CANNOT change the
 * selected semantic branch. Every assertion here is therefore about the
 * parent-linked walk, never about row order or `order_seq`:
 *
 *  - the returned run is contiguous (each message's parent is the previous id),
 *  - it contains no off-branch sibling,
 *  - it agrees with P1''s `getHeadChain` about where the chain ends,
 *  - it fails closed rather than returning a short run it cannot vouch for.
 */

/** Set per-test so every assertion can name the conversation it is about. */
let CONVERSATION = "";

const INSERT_MESSAGE = `INSERT INTO messages
  (id, conversation_id, role, content, parent_id, order_seq, status, format, created_at, updated_at)
  VALUES (?, ?, NULL, ?, ?, ?, 'completed', 'raw', ?, ?)`;

/** Seed a chain through the real service, so FK constraints stay satisfied. */
async function seedChain(ids: readonly string[]): Promise<void> {
  await conversationService.create(conversationInput({ title: "window" }));
  CONVERSATION = db
    .query<{ id: string }, [string]>("SELECT id FROM conversations ORDER BY rowid DESC LIMIT 1")
    .get("x")!.id;
  for (let index = 0; index < ids.length; index += 1) {
    await messageService.upsertStored(CONVERSATION, {
      id: ids[index],
      parent_id: index === 0 ? null : ids[index - 1],
      format: "raw",
      content: { parts: [{ type: "text", text: ids[index] }] },
    });
  }
}

/** Insert a row outside the main chain: a sibling or an orphan. */
function seedOffChain(id: string, parentId: string, orderSeq: number): void {
  db.query(INSERT_MESSAGE).run(
    id,
    CONVERSATION,
    JSON.stringify({ parts: [] }),
    parentId,
    orderSeq,
    orderSeq,
    orderSeq,
  );
}

const idsOf = (messages: readonly { id: string }[]) => messages.map((m) => m.id);

beforeEach(() => {
  CONVERSATION = "";
});

afterEach(() => {
  if (CONVERSATION === "") return;
  messageService.deleteByConversation(CONVERSATION);
});

describe("P2 window slice â€” older direction", () => {
  beforeEach(async () => {
    await seedChain(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
  });

  it("returns a contiguous run ending at the anchor", async () => {
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "m8",
      limit: 3,
    });
    expect(idsOf(slice.messages)).toEqual(["m6", "m7", "m8"]);
  });

  it("reports that more history exists before the run", async () => {
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "m8",
      limit: 3,
    });
    expect(slice.hasMoreBefore).toBe(true);
    expect(slice.hasMoreAfter).toBe(false);
  });

  it("reports the root and stops claiming more before it", async () => {
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "m3",
      limit: 10,
    });
    expect(idsOf(slice.messages)).toEqual(["m1", "m2", "m3"]);
    expect(slice.hasMoreBefore).toBe(false);
  });

  it("is complete when it reaches a legitimate root", async () => {
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "m3",
      limit: 10,
    });
    expect(slice.complete).toBe(true);
  });

  it("returns oldest-first ordering regardless of storage order", async () => {
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "m8",
      limit: 8,
    });
    expect(idsOf(slice.messages)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
  });

  it("a STALE anchor stays fail-closed (contiguous:false) — not the same as an empty conversation", async () => {
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "missing",
      limit: 5,
    });
    expect(slice.messages).toEqual([]);
    expect(slice.complete).toBe(false);
    // The client asked for a position it cannot vouch for, so it must be told
    // the slice is untrustworthy rather than handed a silent empty answer.
    expect(slice.contiguous).toBe(false);
  });

  it("an EMPTY conversation is contiguous:true — a valid empty answer, not a failed walk", async () => {
    // A real conversation row that holds no messages: the ordinary state of a
    // freshly created Direct thread.
    await conversationService.create(conversationInput({ title: "window-empty" }));
    const emptyId = db
      .query<{ id: string }, []>(
        "SELECT id FROM conversations WHERE title = 'window-empty' ORDER BY rowid DESC LIMIT 1",
      )
      .get()!.id;
    try {
      const slice = await messageService.getWindowSlice(emptyId, {
        direction: "older",
        anchorId: null,
        limit: 5,
      });
      expect(slice.messages).toEqual([]);
      // The walk never started, so there was nothing to be untrustworthy about.
      expect(slice.contiguous).toBe(true);
      // `complete` answers a DIFFERENT question and stays false: no walk reached
      // a root, because no walk happened.
      expect(slice.complete).toBe(false);
    } finally {
      messageService.deleteByConversation(emptyId);
    }
  });

  it("an empty conversation is contiguous:true for BOTH directions", async () => {
    await conversationService.create(conversationInput({ title: "window-empty-both" }));
    const emptyId = db
      .query<{ id: string }, []>(
        "SELECT id FROM conversations WHERE title = 'window-empty-both' ORDER BY rowid DESC LIMIT 1",
      )
      .get()!.id;
    try {
      for (const direction of ["older", "newer"] as const) {
        const slice = await messageService.getWindowSlice(emptyId, {
          direction,
          anchorId: null,
          limit: 5,
        });
        expect(slice.messages).toEqual([]);
        expect(slice.contiguous).toBe(true);
      }
    } finally {
      messageService.deleteByConversation(emptyId);
    }
  });

  it("a conversation id with no rows at all is also a valid empty answer", async () => {
    const slice = await messageService.getWindowSlice("conv-empty", {
      direction: "older",
      anchorId: null,
      limit: 5,
    });
    expect(slice.messages).toEqual([]);
    expect(slice.contiguous).toBe(true);
    expect(slice.complete).toBe(false);
  });
});

describe("P2 window slice â€” newer direction", () => {
  beforeEach(async () => {
    await seedChain(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
  });

  it("returns a contiguous run starting at the anchor", async () => {
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "newer",
      anchorId: "m3",
      limit: 3,
    });
    expect(idsOf(slice.messages)).toEqual(["m3", "m4", "m5"]);
  });

  it("reports that more history exists after the run", async () => {
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "newer",
      anchorId: "m3",
      limit: 3,
    });
    expect(slice.hasMoreAfter).toBe(true);
  });

  it("stops at the tip without claiming more after it", async () => {
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "newer",
      anchorId: "m6",
      limit: 10,
    });
    expect(idsOf(slice.messages)).toEqual(["m6", "m7", "m8"]);
    expect(slice.hasMoreAfter).toBe(false);
  });

  it("starts at the tip when no anchor is supplied", async () => {
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "newer",
      anchorId: null,
      limit: 2,
    });
    expect(idsOf(slice.messages)).toEqual(["m7", "m8"]);
  });
});

describe("P2 window slice â€” pagination cannot change the selected branch", () => {
  it("excludes off-branch siblings from every slice", async () => {
    await seedChain(["m1", "m2", "m3", "m4"]);
    // A sibling of m3: same parent, different id, written AFTER the tip. Because
    // it carries the highest order_seq it becomes the chain tip, so the selected
    // branch is m1 -> m2 -> sibling, and m3 is the off-branch row.
    seedOffChain("sibling", "m2", 99);

    const older = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "sibling",
      limit: 10,
    });
    const newer = await messageService.getWindowSlice(CONVERSATION, {
      direction: "newer",
      anchorId: "m1",
      limit: 10,
    });

    expect(idsOf(older.messages)).toEqual(["m1", "m2", "sibling"]);
    expect(idsOf(newer.messages)).toEqual(["m1", "m2", "sibling"]);
    expect(idsOf(older.messages)).not.toContain("m3");
    expect(idsOf(newer.messages)).not.toContain("m3");
  });

  it("follows the branched chain, not the most recently written row", async () => {
    await seedChain(["m1", "m2", "m3"]);
    // An edit creates a new branch from m2. m3b is written after m3, so it is
    // the tip of the branch the user is now on.
    seedOffChain("m3b", "m2", 100);

    // P1' and the window must agree the tip is m3b, and neither may report m3.
    const chain = await messageService.getHeadChain(CONVERSATION);
    expect(chain.messages[chain.messages.length - 1].id).toBe("m3b");
    expect(idsOf(chain.messages)).toEqual(["m1", "m2", "m3b"]);

    const newer = await messageService.getWindowSlice(CONVERSATION, {
      direction: "newer",
      anchorId: "m1",
      limit: 10,
    });
    expect(idsOf(newer.messages)).toEqual(["m1", "m2", "m3b"]);
    expect(idsOf(newer.messages)).not.toContain("m3");

    // Anchoring on an off-branch id yields nothing rather than guessing a path.
    const offBranch = await messageService.getWindowSlice(CONVERSATION, {
      direction: "newer",
      anchorId: "m3",
      limit: 10,
    });
    expect(offBranch.messages).toEqual([]);
  });

  it("agrees with P1''s head chain about the tip", async () => {
    await seedChain(["m1", "m2", "m3", "m4", "m5"]);
    const chain = await messageService.getHeadChain(CONVERSATION);
    const tipId = chain.messages[chain.messages.length - 1].id;
    // An older page anchored at the tip and large enough to reach the root must
    // reproduce the whole chain — same members, same order, same completeness.
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: tipId,
      limit: 100,
    });
    expect(idsOf(slice.messages)).toEqual(idsOf(chain.messages));
    expect(slice.complete).toBe(chain.complete);
    expect(slice.hasMoreBefore).toBe(false);
    expect(slice.hasMoreAfter).toBe(false);
  });

  it("produces a contiguous run even when order_seq disagrees with the chain", async () => {
    await seedChain(["m1", "m2", "m3", "m4"]);
    // Reorder storage so order_seq no longer reflects conversation order.
    db.query("UPDATE messages SET order_seq = 1000 WHERE id = ?").run("m1");
    db.query("UPDATE messages SET order_seq = 1001 WHERE id = ?").run("m2");
    db.query("UPDATE messages SET order_seq = 1002 WHERE id = ?").run("m3");
    db.query("UPDATE messages SET order_seq = 1003 WHERE id = ?").run("m4");

    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "m4",
      limit: 10,
    });
    expect(idsOf(slice.messages)).toEqual(["m1", "m2", "m3", "m4"]);
    for (let i = 1; i < slice.messages.length; i += 1) {
      expect(slice.messages[i].parent_id).toBe(slice.messages[i - 1].id);
    }
  });
});

describe("P2 window slice â€” fail-closed boundaries", () => {
  it("fails closed on a dangling parent link", async () => {
    await seedChain(["m1", "m2", "m3"]);
    // Detach m2's parent so the walk cannot prove it reached a root.
    db.query("UPDATE messages SET parent_id = ? WHERE id = ?").run("does-not-exist", "m2");

    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "m3",
      limit: 10,
    });
    expect(slice.complete).toBe(false);
  });

  it("fails closed on unparsable stored content", async () => {
    await seedChain(["m1", "m2", "m3"]);
    db.query("UPDATE messages SET content = ? WHERE id = ?").run("{not json", "m2");

    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "m3",
      limit: 10,
    });
    expect(slice.complete).toBe(false);
  });

  it("never returns a detached row", async () => {
    await seedChain(["m1", "m2", "m3"]);
    seedOffChain("orphan", "ghost", 50);

    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "m3",
      limit: 20,
    });
    expect(idsOf(slice.messages)).not.toContain("orphan");
  });
});
