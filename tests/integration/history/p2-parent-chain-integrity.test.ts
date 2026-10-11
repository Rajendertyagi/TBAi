/**
 * P2: the stored parent chain must not be re-rooted by a bounded window.
 *
 * ## The defect this locks down
 *
 * The bounded window's oldest row has no parent INSIDE the window, so the
 * repository seed legitimately hands it `parentId: null`
 * (`windowController.withBoundedRoot`). Paging prepends a page through the
 * runtime, which persists it, so that synthesized root reached
 * `messageService.upsertStored` and - because the write is
 * `ON CONFLICT(id) DO UPDATE SET parent_id` - overwrote a perfectly good stored
 * parent with null.
 *
 * Measured effect in the mounted app: after ONE "Load earlier" the stored chain
 * had a second root, so the backend correctly reported "root reached" at that
 * message, `hasMoreBefore` went false, and every later page request repeated the
 * same cursor forever. Paging was permanently stranded by a read-only action.
 *
 * `upsertStored` therefore keeps a stored non-null parent when the incoming one
 * is null. These cases pin both halves of that rule: the null must not win, and
 * a genuine re-parent must still be able to move a message.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "@/db";
import { messageService, conversationService } from "@/services/storage";
import { conversationInput } from "../../helpers/conversation-fixtures";

const CONVERSATION_TITLE = "p2-parent-chain";

/** Seed through the real service so FK constraints stay satisfied. */
async function seedChain(count: number): Promise<string> {
  await conversationService.create(conversationInput({ title: CONVERSATION_TITLE }));
  const conversationId = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM conversations WHERE title = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(CONVERSATION_TITLE)!.id;
  for (let i = 0; i < count; i += 1) {
    await messageService.upsertStored(conversationId, {
      id: `m${i}`,
      parent_id: i === 0 ? null : `m${i - 1}`,
      format: "raw",
      content: { parts: [{ type: "text", text: `body ${i}` }] },
    });
  }
  return conversationId;
}

const parentsOf = (conversationId: string): Map<string, string | null> => {
  const rows = db
    .query<{ id: string; parent_id: string | null }, [string]>(
      "SELECT id, parent_id FROM messages WHERE conversation_id = ? ORDER BY order_seq ASC",
    )
    .all(conversationId);
  return new Map(rows.map((r) => [r.id, r.parent_id]));
};

describe("P2 stored parent chain", () => {
  let conversationId = "";

  beforeEach(async () => {
    for (const row of db
      .query<{ id: string }, [string]>("SELECT id FROM conversations WHERE title = ?")
      .all(CONVERSATION_TITLE)) {
      await conversationService.delete(row.id);
    }
  });

  it("seeds a chain with exactly one root", async () => {
    conversationId = await seedChain(5);
    const parents = parentsOf(conversationId);
    expect(parents.get("m0")).toBeNull();
    expect(parents.get("m1")).toBe("m0");
    expect(parents.get("m4")).toBe("m3");
    const roots = [...parents.values()].filter((p) => p === null);
    expect(roots).toHaveLength(1);
  });

  it("does not let a null parent re-root an existing message", async () => {
    conversationId = await seedChain(5);

    // Exactly what a paged window persists: the page's oldest row carries the
    // synthesized bounded root, and every later row keeps its real parent.
    await messageService.upsertStored(conversationId, {
      id: "m2",
      parent_id: null,
      format: "ai-sdk/v6",
      content: { role: "user", parts: [{ type: "text", text: "rewritten by the window" }] },
    });

    const parents = parentsOf(conversationId);
    // The link survives...
    expect(parents.get("m2")).toBe("m1");
    // ...and the chain still has exactly one root, so paging can continue.
    expect([...parents.values()].filter((p) => p === null)).toHaveLength(1);
  });

  it("still applies the content update that came with the null parent", async () => {
    conversationId = await seedChain(3);
    await messageService.upsertStored(conversationId, {
      id: "m1",
      parent_id: null,
      format: "ai-sdk/v6",
      content: { role: "assistant", parts: [{ type: "text", text: "new content" }] },
    });
    const row = db
      .query<{ content: string }, [string]>("SELECT content FROM messages WHERE id = ?")
      .get("m1");
    // The guard protects the LINK only; refusing the write wholesale would lose
    // the very edit or tool result the runtime was persisting.
    expect(JSON.parse(row?.content ?? "{}")).toEqual({
      role: "assistant",
      parts: [{ type: "text", text: "new content" }],
    });
  });

  it("still allows a genuine re-parent to a different non-null message", async () => {
    conversationId = await seedChain(4);
    await messageService.upsertStored(conversationId, {
      id: "m3",
      parent_id: "m0",
      format: "ai-sdk/v6",
      content: { role: "user", parts: [{ type: "text", text: "rebased onto m0" }] },
    });
    expect(parentsOf(conversationId).get("m3")).toBe("m0");
  });

  it("keeps the guard out of the way when a message is created", async () => {
    conversationId = await seedChain(2);
    // A genuinely new root: no stored row exists, so null is honoured.
    await messageService.upsertStored(conversationId, {
      id: "standalone",
      parent_id: null,
      format: "ai-sdk/v6",
      content: { role: "user", parts: [{ type: "text", text: "detached" }] },
    });
    expect(parentsOf(conversationId).get("standalone")).toBeNull();
  });
});
