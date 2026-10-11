/**
 * SPIKE — OPTION B PROBE: does the adjacent-assistant merge preserve identity?
 * TEMPORARY, removable.
 *
 * After a tool continuation, `a1` (tool call) and `a2` (answer) are adjacent
 * assistant messages and the converter merges them for display. The 1:1
 * invariant (§14.21) is about PERSISTED IDENTITY, not display grouping. This
 * proves whether both persisted ids survive the merge via `symbolInnerMessage`.
 */

import { describe, expect, it } from "bun:test";
import {
  AISDKMessageConverter,
  getExternalStoreMessages,
} from "../../../helpers/dom/resolve.ts";
import { createProof, type AiMsg } from "./proof-harness";

/** The 4-persisted / 3-rendered fixture from the contract test (direct-eviction.test.ts:195). */
const ADJACENT: AiMsg[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "go" }] },
  {
    id: "m2",
    role: "assistant",
    parts: [{ type: "tool-call", toolCallId: "call-a", state: "output-available", input: { p: 1 }, output: { ok: true } }],
  },
  {
    id: "m3",
    role: "assistant",
    parts: [{ type: "tool-call", toolCallId: "call-b", state: "output-available", input: { p: 2 }, output: { ok: true } }],
  },
  { id: "m4", role: "user", parts: [{ type: "text", text: "done" }] },
];

/**
 * The write-back expansion Candidate D must perform: walk the rendered rows,
 * unwrap each row to its persisted messages via the binding, and translate the
 * row's parentId through "last persisted id inside that row" so a merged row
 * restores the ORIGINAL persisted parent chain.
 *
 * This is the algorithm, not a second implementation of conversion: the rows
 * come from the real repository and the ids come from the real
 * `getExternalStoreMessages` binding.
 */
const expandForWriteBack = (
  exported: { messages: Array<{ message: { id: string }; parentId: string | null }>; headId: string | null },
) => {
  const expanded: Array<{ id: string; parentId: string | null }> = [];
  const lastInnerIdMap = new Map<string, string>();
  for (const item of exported.messages) {
    const inner = getExternalStoreMessages(item.message as never) as Array<{ id: string }>;
    let parentId =
      item.parentId != null ? lastInnerIdMap.get(item.parentId) ?? item.parentId : null;
    for (const innerMessage of inner) {
      expanded.push({ id: innerMessage.id, parentId });
      parentId = innerMessage.id;
    }
    if (inner.length > 0) {
      lastInnerIdMap.set(item.message.id, inner[inner.length - 1].id);
    }
  }
  const headId = exported.headId != null ? lastInnerIdMap.get(exported.headId) ?? exported.headId : null;
  return { messages: expanded, headId };
};

describe("adjacent-assistant merge — identity preservation", () => {
  it("the merged message binds BOTH persisted messages (recoverable)", () => {
    const a1 = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "tool-read", toolCallId: "tc1", state: "output-available", input: { p: 1 }, output: { ok: true } },
      ],
    };
    const a2 = {
      id: "a2",
      role: "assistant",
      parts: [{ type: "text", text: "done" }],
    };

    const converted = AISDKMessageConverter.toThreadMessages([a1, a2] as never, false, {} as never) as never as Array<{ id: string }>;

    console.log("\n=== merge: 2 persisted assistant messages ===");
    console.log("  converted count:", converted.length);
    console.log("  converted ids:", converted.map((m) => m.id).join(","));

    // Display: merged into ONE message.
    expect(converted.length).toBe(1);

    // Identity: BOTH persisted messages recoverable from the merged one.
    const recovered = getExternalStoreMessages(converted[0] as never) as Array<{ id: string }>;
    console.log("  recovered persisted ids:", recovered.map((m) => m.id).join(","));

    expect(recovered.map((m) => m.id)).toEqual(["a1", "a2"]);
  });

  it("WRITE-BACK recovery is available from the CONVERSION output, not the repository", () => {
    // The substantive version of "the 1:1 rule is about recoverable identity".
    // The previous revision of this case was `expect(true).toBe(true)` — it
    // documented the intent and proved nothing.
    //
    // Rendered rows = 3 (m2 absorbs m3) and the repository rewrites m4's parent
    // to "m2" (direct-eviction.test.ts:251). Recovery therefore has to come
    // from the CONVERSION side — see proof-binding-survival.test.ts, which
    // proves `ExportedMessageRepository.fromBranchableArray` drops the
    // `symbolInnerMessage` binding, so `getExternalStoreMessages` on repository
    // objects recovers nothing at all.
    const converted = AISDKMessageConverter.toThreadMessages(
      ADJACENT as never,
      false,
      {} as never,
    ) as never as Array<{ id: string }>;
    const exportShaped = {
      messages: converted.map((m, i) => ({
        message: m,
        parentId: i === 0 ? null : converted[i - 1].id,
      })),
      headId: converted.at(-1)?.id ?? null,
    };
    const writeBack = expandForWriteBack(
      exportShaped as unknown as Parameters<typeof expandForWriteBack>[0],
    );

    console.log("\n=== merge: write-back recovery from the conversion output ===");
    console.log("  rendered rows      :", converted.map((m) => m.id).join(","));
    console.log("  repository parents :", JSON.stringify(exportShaped.messages.map((e) => [e.message.id, e.parentId])));
    console.log("  write-back ids     :", writeBack.messages.map((m) => m.id).join(","));
    console.log("  write-back parents :", JSON.stringify(writeBack.messages.map((m) => [m.id, m.parentId])));

    // The display really did merge (this is not a 1:1 rendering)...
    expect(converted.length).toBe(3);
    expect(converted.map((m) => m.id)).not.toContain("m3");
    // ...yet every persisted message is recoverable, in order, with the ORIGINAL
    // persisted parent chain (m4 → m3, not → m2)...
    expect(writeBack.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    const parents = Object.fromEntries(writeBack.messages.map((m) => [m.id, m.parentId]));
    expect(parents["m1"]).toBeNull();
    expect(parents["m2"]).toBe("m1");
    expect(parents["m3"]).toBe("m2");
    expect(parents["m4"]).toBe("m3");
    // ...and the head resolves to the last PERSISTED id, not the last row id.
    expect(writeBack.headId).toBe("m4");

    // Same fixture through the OPTION B repository path: identical rendered rows,
    // identical parents, but NO recoverable binding (the plan-level finding).
    const h = createProof({ window: ADJACENT });
    const exported = h.repository.export() as unknown as {
      messages: Array<{ message: { id: string }; parentId: string | null }>;
    };
    const repoRows = exported.messages.map((e) => e.message.id);
    const repoParents = exported.messages.map((e) => [e.message.id, e.parentId]);
    const repoWriteBack = expandForWriteBack(
      { messages: exported.messages, headId: repoRows.at(-1) ?? null } as never,
    );
    console.log("  option B repo rows :", repoRows.join(","), JSON.stringify(repoParents));
    console.log("  option B write-back:", repoWriteBack.messages.map((m) => m.id).join(",") || "(none)");
    expect(repoRows).toEqual(["m1", "m2", "m4"]);
    expect(repoWriteBack.messages.map((m) => m.id)).toEqual([]);
    h.dispose();
  });
});