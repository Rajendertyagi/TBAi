/**
 * SPIKE — OPTION B PROOF: repository+Chat synchronization, root-parent
 * semantics, and branch behavior. TEMPORARY, removable.
 *
 * Section 6 (sync table), section 7 (root-parent), section 8 (branch).
 */

import { describe, expect, it } from "bun:test";
import { createProof, chainFromTo, ai, windowToRepository, type AiMsg } from "./proof-harness";
import { ExportedMessageRepository } from "../../../helpers/dom/resolve.ts";

const AUTH = chainFromTo(1, 500);

function syncRow(h: ReturnType<typeof createProof>, op: string) {
  const row = {
    op,
    visible: h.visibleIds().length,
    head: h.headId(),
    chat: h.chatIds().length,
    chatTip: h.chatIds().at(-1) ?? null,
    submissions: h.submissions.length,
  };
  console.log(
    `  ${op.padEnd(18)} repo=${String(row.visible).padEnd(3)} head=${String(row.head).padEnd(6)} chat=${String(row.chat).padEnd(3)} chatTip=${String(row.chatTip).padEnd(6)} submissions=${row.submissions}`,
  );
  return row;
}

describe("Option B — repository + Chat synchronization table", () => {
  it("records both sides of every operation", async () => {
    const h = createProof({ window: chainFromTo(451, 500) });
    console.log("\n=== sync table ===");
    const init = syncRow(h, "initial load");
    expect(init.visible).toBe(50);
    expect(init.chat).toBe(50);
    expect(init.head).toBe("m500");

    // load older (prepend) — window grows downward, tip retained.
    h.setWindow(chainFromTo(401, 500));
    const older = syncRow(h, "load older");
    expect(older.visible).toBe(100);
    expect(older.head).toBe("m500");

    // historical move — window excludes the tip.
    h.setWindow(chainFromTo(351, 400));
    const hist = syncRow(h, "historical move");
    expect(hist.head).toBe("m400");

    // restore tip.
    h.setWindow(chainFromTo(451, 500));
    const restore = syncRow(h, "restore tip");
    expect(restore.head).toBe("m500");

    // append.
    await h.send("new");
    const append = syncRow(h, "append");
    expect(append.submissions).toBe(1);
    expect(append.chat).toBe(51);

    h.dispose();
  });
});

describe("Option B — root-parent semantics (section 7)", () => {
  it("A/B: window root is legal and internal links are correct", () => {
    const h = createProof({ window: chainFromTo(451, 500) });
    const parents: Record<string, string | null> = {};
    for (const e of h.repository.export().messages as unknown as Array<{ message: { id: string }; parentId: string | null }>) {
      parents[e.message.id] = e.parentId;
    }
    console.log("\n=== root-parent: window m451..m500 ===");
    console.log("  m451 parent:", parents["m451"], " m452 parent:", parents["m452"], " m500 parent:", parents["m500"]);

    // A. root is legal (null). B. internal links are the real contiguous chain.
    expect(parents["m451"]).toBeNull();
    expect(parents["m452"]).toBe("m451");
    expect(parents["m500"]).toBe("m499");
    h.dispose();
  });

  it("D: widening to include m400 restores the real parent relationship", () => {
    const h = createProof({ window: chainFromTo(451, 500) });
    h.setWindow(chainFromTo(400, 500));
    const parents: Record<string, string | null> = {};
    for (const e of h.repository.export().messages as unknown as Array<{ message: { id: string }; parentId: string | null }>) {
      parents[e.message.id] = e.parentId;
    }
    console.log("\n=== root-parent: widened to m400..m500 ===");
    console.log("  m400 parent:", parents["m400"], " m451 parent:", parents["m451"]);

    // m400 is now the root (null); m451's parent is m450 — the REAL persisted
    // relationship, restored by widening (it was null when m451 was the root).
    expect(parents["m400"]).toBeNull();
    expect(parents["m451"]).toBe("m450");
    h.dispose();
  });

  it("E: mutation at the window root m451 behaves correctly", async () => {
    const h = createProof({ window: chainFromTo(451, 500) });
    // Edit at the root: sliceMessagesUntil(chat.messages, "m451") keeps m451.
    let error: string | null = null;
    try {
      await h.appendAt("m451", "edited root");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    console.log("\n=== root-parent: edit at root m451 ===");
    console.log("  outcome:", error ?? "OK", " submissions:", h.submissions.length);

    expect(error).toBeNull();
    expect(h.submissions.length).toBe(1);
    h.dispose();
  });

  it("G: re-widening does not create duplicate or alternate identities", () => {
    const h = createProof({ window: chainFromTo(451, 500) });
    h.setWindow(chainFromTo(400, 500));
    h.setWindow(chainFromTo(451, 500));
    h.setWindow(chainFromTo(400, 500));
    const ids = h.visibleIds();
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    console.log("\n=== root-parent: repeated re-widening ===");
    console.log("  visible:", ids.length, " duplicates:", dupes.length);

    expect(dupes).toEqual([]);
    expect(ids[0]).toBe("m400");
    expect(ids.at(-1)).toBe("m500");
    h.dispose();
  });
});

describe("Option B — branch behavior (section 8)", () => {
  const branch = (): AiMsg[] => [
    ai("m1", "user"),
    ai("m5", "assistant"),
    ai("m5a", "user"),
    ai("m6a", "assistant"),
  ];

  it("explicit parentIds preserved, headId selects the branch, no flattening", () => {
    // A repository holding BOTH branches; head selects m6a.
    const repo = ExportedMessageRepository.fromBranchableArray(
      [
        { message: { id: "m1", role: "user", content: [{ type: "text", text: "1" }], metadata: { unstable_state: null }, createdAt: new Date(0) }, parentId: null },
        { message: { id: "m5", role: "assistant", content: [{ type: "text", text: "5" }], status: { type: "complete" }, metadata: { unstable_state: null }, createdAt: new Date(0) }, parentId: "m1" },
        { message: { id: "m5a", role: "user", content: [{ type: "text", text: "5a" }], metadata: { unstable_state: null }, createdAt: new Date(0) }, parentId: "m5" },
        { message: { id: "m6a", role: "assistant", content: [{ type: "text", text: "6a" }], status: { type: "complete" }, metadata: { unstable_state: null }, createdAt: new Date(0) }, parentId: "m5a" },
        { message: { id: "m5b", role: "user", content: [{ type: "text", text: "5b" }], metadata: { unstable_state: null }, createdAt: new Date(0) }, parentId: "m5" },
        { message: { id: "m6b", role: "assistant", content: [{ type: "text", text: "6b" }], status: { type: "complete" }, metadata: { unstable_state: null }, createdAt: new Date(0) }, parentId: "m5b" },
      ] as never,
      { headId: "m6a" },
    );

    const h = createProof({ window: branch() });
    // Replace the store's repository with the branched one.
    (h.runtime as never as { __internal_setAdapter: (a: unknown) => void }).__internal_setAdapter({
      messageRepository: repo,
      isRunning: false,
      onNew: async () => {},
    });

    const parents: Record<string, string | null> = {};
    for (const e of h.repository.export().messages as unknown as Array<{ message: { id: string }; parentId: string | null }>) {
      parents[e.message.id] = e.parentId;
    }
    console.log("\n=== branch: explicit parentIds ===");
    console.log("  m5b parent:", parents["m5b"], " m6b parent:", parents["m6b"]);
    console.log("  visible (head walk):", h.visibleIds().join(","));

    // Sibling NOT flattened: m5b's parent is m5, not m6a.
    expect(parents["m5b"]).toBe("m5");
    expect(parents["m6b"]).toBe("m5b");
    // Head walk shows only the SELECTED branch.
    expect(h.visibleIds()).toEqual(["m1", "m5", "m5a", "m6a"]);
    h.dispose();
  });

  it("switching to an UNLOADED branch fails closed (Branch not found)", () => {
    const h = createProof({ window: branch() });
    // m6b is not in the current window, so switching to it must fail closed —
    // this is exactly why the contract requires widening to the branch point
    // BEFORE any branch mutation.
    let error: string | null = null;
    try {
      h.runtime.switchToBranch("m6b");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    console.log("\n=== branch: switchToBranch to unloaded m6b ===");
    console.log("  outcome:", error ?? "OK");
    expect(error).toContain("Branch not found");
    h.dispose();
  });
});