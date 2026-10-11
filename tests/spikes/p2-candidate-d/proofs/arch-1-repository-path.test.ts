/**
 * SPIKE — ARCHITECTURE PROBE: the `messageRepository` path.
 * TEMPORARY, removable.
 *
 * Question: does `messageRepository` preserve explicit `parentId` and an
 * explicit `headId` INDEPENDENT of array position — unlike the `messages`
 * path, which re-parents positionally and pins the head to the last element?
 *
 * This is the decisive difference for branch identity (contract §5, §14.8/9).
 * Everything here is the real installed `@assistant-ui/core@0.3.24`.
 */

import { describe, expect, it } from "bun:test";
import {
  ExternalStoreThreadRuntimeCore,
  ExportedMessageRepository,
  MessageRepository,
} from "../../../helpers/dom/resolve.ts";

const contextProvider = {
  getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
  registerModelContextProvider: () => () => {},
} as never;

type Msg = { id: string; role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> };
const msg = (id: string, role: "user" | "assistant" = "user"): Msg => ({
  id,
  role,
  content: [{ type: "text", text: `body ${id}` }],
});

function parentsOf(repo: InstanceType<typeof MessageRepository>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const e of repo.export().messages as unknown as Array<{ message: { id: string }; parentId: string | null }>) {
    out[e.message.id] = e.parentId;
  }
  return out;
}

describe("messageRepository path — explicit parentId and headId", () => {
  it("preserves a BRANCH: two children of one parent are NOT flattened", () => {
    // m5 has two children: m5a (->m6a) and m5b (->m6b). The `messages` path
    // flattened this; the repository path must not.
    const repo = ExportedMessageRepository.fromBranchableArray(
      [
        { message: msg("m5"), parentId: null },
        { message: msg("m5a", "assistant"), parentId: "m5" },
        { message: msg("m6a", "user"), parentId: "m5a" },
        { message: msg("m5b", "assistant"), parentId: "m5" },
        { message: msg("m6b", "user"), parentId: "m5b" },
      ] as never,
      { headId: "m6a" },
    );

    const core = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messageRepository: repo,
      isRunning: false,
    } as never);

    const parents = parentsOf(core.repository as never);
    console.log("\n=== messageRepository: branch preserved ===");
    console.log("  parents:", Object.entries(parents).map(([k, v]) => `${k}<-${v ?? "null"}`).join(" "));
    console.log("  head:", (core.repository as never as { canonicalHeadId: string }).canonicalHeadId);
    console.log("  visible (head walk):", (core.messages as Array<{ id: string }>).map((m) => m.id).join(","));

    // The branch is preserved: m5b's parent is m5, NOT m6a.
    expect(parents["m5b"]).toBe("m5");
    expect(parents["m6b"]).toBe("m5b");
    expect(parents["m6a"]).toBe("m5a");
    // The head walk shows only the SELECTED branch.
    expect((core.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["m5", "m5a", "m6a"]);
  });

  it("headId is EXPLICIT and independent of array position", () => {
    // A valid chain, but the head is the MIDDLE element, not the last.
    const repo = ExportedMessageRepository.fromBranchableArray(
      [
        { message: msg("m5"), parentId: null },
        { message: msg("m5a", "assistant"), parentId: "m5" },
        { message: msg("m6a", "user"), parentId: "m5a" },
      ] as never,
      { headId: "m5a" }, // head is NOT the last element
    );

    const core = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messageRepository: repo,
      isRunning: false,
    } as never);

    const head = (core.repository as never as { canonicalHeadId: string }).canonicalHeadId;
    const visible = (core.messages as Array<{ id: string }>).map((m) => m.id);
    console.log("\n=== messageRepository: explicit headId ===");
    console.log("  array: m5, m5a, m6a   headId: m5a (not last)");
    console.log("  resolved head:", head, "  visible:", visible.join(","));

    // The head is the explicit m5a, and the head walk stops there — m6a is
    // retained off-head but not rendered.
    expect(head).toBe("m5a");
    expect(visible).toEqual(["m5", "m5a"]);
  });

  it("LIMIT: a window root's parentId must resolve INSIDE the repository", () => {
    // A bounded window m451..m500 whose root's real parent (m450) is OUTSIDE
    // the window. The repository path REJECTS this.
    const ids = Array.from({ length: 50 }, (_, i) => `m${451 + i }`);
    let threw: string | null = null;
    try {
      const repo = ExportedMessageRepository.fromBranchableArray(
        ids.map((id, i) => ({
          message: msg(id, i % 2 === 0 ? "user" : "assistant"),
          parentId: i === 0 ? "m450" : ids[i - 1], // m450 is NOT in the window
        })) as never,
        { headId: "m500" },
      );
      new ExternalStoreThreadRuntimeCore(contextProvider, {
        messageRepository: repo,
        isRunning: false,
      } as never);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }

    console.log("\n=== messageRepository: window root with external parent ===");
    console.log("  outcome:", threw ?? "(accepted)");

    // DECISIVE: the repository path cannot represent a bounded window whose
    // root has a parent outside the window. The root must be parentId null.
    expect(threw).toContain("Parent message not found");
  });

  it("a bounded window works when its root is parentId null, with explicit links inside", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `m${451 + i }`);
    const repo = ExportedMessageRepository.fromBranchableArray(
      ids.map((id, i) => ({
        message: msg(id, i % 2 === 0 ? "user" : "assistant"),
        parentId: i === 0 ? null : ids[i - 1], // root is null; the rest explicit
      })) as never,
      { headId: "m500" },
    );

    const core = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messageRepository: repo,
      isRunning: false,
    } as never);

    const parents = parentsOf(core.repository as never);
    console.log("\n=== messageRepository: bounded window, null root ===");
    console.log("  m451 parent:", parents["m451"], " m452 parent:", parents["m452"], " head:", (core.repository as never as { canonicalHeadId: string }).canonicalHeadId);

    expect(parents["m451"]).toBeNull();
    expect(parents["m452"]).toBe("m451");
    expect((core.repository as never as { canonicalHeadId: string }).canonicalHeadId).toBe("m500");
  });

  it("contrast: the messages path FLATTENS the same branch (regression guard)", () => {
    // Same branch through the `messages` path — positional re-parenting.
    const core = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messages: [
        { ...msg("m5"), status: { type: "complete" }, metadata: { unstable_state: null }, createdAt: new Date(0) },
        { ...msg("m5a", "assistant"), status: { type: "complete" }, metadata: { unstable_state: null }, createdAt: new Date(0) },
        { ...msg("m5b", "assistant"), status: { type: "complete" }, metadata: { unstable_state: null }, createdAt: new Date(0) },
        { ...msg("m6b", "user"), status: { type: "complete" }, metadata: { unstable_state: null }, createdAt: new Date(0) },
      ],
      isRunning: false,
    } as never);

    const parents = parentsOf(core.repository as never);
    console.log("\n=== messages path: same branch FLATTENED ===");
    console.log("  parents:", Object.entries(parents).map(([k, v]) => `${k}<-${v ?? "null"}`).join(" "));

    // Positional: m5b's parent becomes m5a (the previous array element), not m5.
    expect(parents["m5b"]).toBe("m5a");
  });
});