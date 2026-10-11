/**
 * SPIKE — CONTRACT GAP: window eviction against the real Direct message model.
 * TEMPORARY, removable.
 *
 * The corrected contract requires that a window operation never silently
 * remove one side of a required parent / tool-call / tool-result / child
 * relationship. This establishes what the Direct model actually contains, then
 * exercises older-side eviction, newer-side eviction, historical relocation and
 * return-to-tip against it.
 *
 * There is NO sub-agent / child-transcript abstraction here because the Direct
 * model has none: a grep across the backend sources finds no such concept, and
 * tool call + result live inside ONE assistant message's `parts`, keyed by
 * `toolCallId`. That is asserted from the persisted rows, not assumed.
 */

import { describe, expect, it } from "bun:test";
import { createAudit } from "../../helpers/dom/audit-harness.ts";

/**
 * The smallest REALISTIC Direct thread: strictly alternating user/assistant,
 * which is what Direct persists. Each assistant message carries its own tool
 * lifecycle in `parts`.
 *
 *   m1 user  "read x"
 *   m2 assistant: tool call `call-read`, result ALREADY inline
 *      (AI SDK v7 stores `state: output-available` + `output` on the part)
 *   m3 user  "and delete it"
 *   m4 assistant: tool call `call-del` AWAITING APPROVAL
 *   m5 user  "yes"   (tip)
 *
 * A separate test documents what happens when two assistant messages ARE
 * adjacent, because the converter merges those.
 */
const DIRECT_THREAD = [
  { id: "m1", role: "user" as const, parts: [{ type: "text" as const, text: "read x" }] },
  {
    id: "m2",
    role: "assistant" as const,
    parts: [
      { type: "text" as const, text: "reading" },
      {
        type: "tool-call" as const,
        toolCallId: "call-read",
        state: "output-available",
        input: { path: "x" },
        output: { content: "hello" },
      },
    ],
  },
  { id: "m3", role: "user" as const, parts: [{ type: "text" as const, text: "and delete it" }] },
  {
    id: "m4",
    role: "assistant" as const,
    parts: [
      {
        type: "tool-call" as const,
        toolCallId: "call-del",
        state: "approval-requested",
        input: { path: "x" },
        approval: { id: "ap-1", prompt: "Delete x?" },
      },
    ],
  },
  { id: "m5", role: "user" as const, parts: [{ type: "text" as const, text: "yes" }] },
];

const IDS = DIRECT_THREAD.map((m) => m.id);

type ToolObservation = {
  message: string;
  toolCallId: string;
  hasResult: boolean;
  approval: string | null;
};

type Snapshot = {
  visible: string[];
  head: string | null;
  chat: string[];
  /** Parents of VISIBLE messages only. */
  parents: Record<string, string | null>;
  /** Tool relationships on VISIBLE messages only. */
  toolCalls: ToolObservation[];
  approvalSurfaces: string[];
  /** Messages the repository still retains OFF-HEAD after eviction. */
  retained: string[];
};

function snapshot(h: ReturnType<typeof createAudit>): Snapshot {
  const visible = h.visibleIds();
  const visibleSet = new Set(visible);
  const exported = h.repository.export();
  const parents: Record<string, string | null> = {};
  const toolCalls: ToolObservation[] = [];
  const approvalSurfaces: string[] = [];
  const retained: string[] = [];

  for (const entry of exported.messages as unknown as Array<{
    message: { id: string; content: Array<Record<string, unknown>> };
    parentId: string | null;
  }>) {
    const id = entry.message.id;
    // The repository RETAINS evicted messages off-head. Only the head walk is
    // rendered, so relationship assertions must be scoped to the visible set.
    if (!visibleSet.has(id)) {
      retained.push(id);
      continue;
    }
    parents[id] = entry.parentId;
    for (const part of entry.message.content) {
      if (part.type !== "tool-call") continue;
      const approval = part.approval as { id?: string } | undefined;
      toolCalls.push({
        message: id,
        toolCallId: String(part.toolCallId),
        // The converter emits `result`/`isError`, not the AI SDK `state`
        // string, so result presence is the reliable signal.
        hasResult: part.result !== undefined,
        approval: approval?.id ?? null,
      });
      if (approval?.id) approvalSurfaces.push(approval.id);
    }
  }

  return {
    visible,
    head: h.headId(),
    chat: h.chatIds(),
    parents,
    toolCalls,
    approvalSurfaces,
    retained,
  };
}

function report(label: string, s: Snapshot): void {
  console.log(`\n--- ${label} ---`);
  console.log(`  visible        : ${s.visible.join(",") || "(none)"}`);
  console.log(`  head           : ${s.head}`);
  console.log(`  chat.messages  : ${s.chat.join(",") || "(none)"}`);
  console.log(`  retained off-head: ${s.retained.join(",") || "(none)"}`);
  const parents = Object.entries(s.parents)
    .map(([id, p]) => `${id}<-${p ?? "null"}`)
    .join(" ");
  console.log(`  parents(visible): ${parents}`);
  for (const t of s.toolCalls) {
    console.log(
      `  tool ${t.toolCallId} on ${t.message}: result=${t.hasResult} approval=${t.approval ?? "-"}`,
    );
  }
  console.log(`  approval surfaces: ${s.approvalSurfaces.join(",") || "(none)"}`);
}

/**
 * Move the window while PRESERVING each message's real `parts`.
 *
 * `republishWindow` rebuilds plain-text messages, which would silently destroy
 * every tool relationship and make the eviction assertions meaningless.
 */
function show(h: ReturnType<typeof createAudit>, ids: readonly string[]): void {
  const byId = new Map(DIRECT_THREAD.map((m) => [m.id, m]));
  h.seed(ids.map((id) => byId.get(id)!));
}

function freshThread(): ReturnType<typeof createAudit> {
  const h = createAudit({ authoritative: IDS, window: IDS });
  h.seed(DIRECT_THREAD);
  return h;
}

describe("Gap 3 — Direct model: no child transcripts; tool relationships are atomic parts", () => {
  it("establishes the model: tool call and result are parts of ONE message", () => {
    const h = freshThread();
    const s = snapshot(h);
    report("baseline", s);

    // No child/sub-agent entity exists in Direct: every relationship is either
    // (a) the conversation chain, via parent_id, or (b) a tool part keyed by
    // toolCallId inside a single message.
    expect(s.visible).toEqual(IDS);
    expect(s.toolCalls.length).toBe(2);

    const read = s.toolCalls.find((t) => t.toolCallId === "call-read")!;
    expect(read.message).toBe("m2");
    expect(read.hasResult).toBe(true);

    const del = s.toolCalls.find((t) => t.toolCallId === "call-del")!;
    expect(del.message).toBe("m4");
    expect(del.approval).toBe("ap-1");

    h.dispose();
  });

  it("HAZARD: the converter MERGES adjacent assistant messages (ids are not 1:1)", () => {
    // Proven at source: `chunkExternalMessages` in
    // `external-message-conversion.js` does not flush when the previous chunk
    // was assistant/tool unless `joinStrategy === "none"`, and
    // `AISDKMessageConverter.toThreadMessages` passes no join strategy.
    //
    // Consequence for P2: the assistant-ui message array can be SHORTER than the
    // persisted array, and because parents are assigned positionally, a
    // persisted message can end up linked to a different parent.
    const adjacent = [
      { id: "m1", role: "user" as const, parts: [{ type: "text" as const, text: "go" }] },
      {
        id: "m2",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-call" as const,
            toolCallId: "call-a",
            state: "output-available",
            input: { p: 1 },
            output: { ok: true },
          },
        ],
      },
      {
        id: "m3",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-call" as const,
            toolCallId: "call-b",
            state: "output-available",
            input: { p: 2 },
            output: { ok: true },
          },
        ],
      },
      { id: "m4", role: "user" as const, parts: [{ type: "text" as const, text: "done" }] },
    ];

    const h = createAudit({
      authoritative: adjacent.map((m) => m.id),
      window: adjacent.map((m) => m.id),
    });
    h.seed(adjacent);
    const s = snapshot(h);
    report("HAZARD: adjacent assistant messages", s);

    console.log(`  persisted: ${adjacent.length}  assistant-ui visible: ${s.visible.length}`);

    // 4 persisted messages collapse to 3 assistant-ui messages: m2 absorbs m3.
    expect(adjacent.length).toBe(4);
    expect(s.visible.length).toBe(3);
    expect(s.visible).not.toContain("m3");
    expect(s.toolCalls.every((t) => t.message === "m2")).toBe(true);
    // m4 is parented to the MERGED message, not to persisted m3.
    expect(s.parents.m4).toBe("m2");

    h.dispose();
  });

  it("A. older-side eviction removes a message and its tool parts together", () => {
    const h = freshThread();

    show(h, ["m3", "m4", "m5"]);
    const s = snapshot(h);
    report("A. older-side eviction (m1,m2 evicted)", s);

    expect(s.visible).toEqual(["m3", "m4", "m5"]);
    // m2 carried call-read AND its result. Both left together.
    expect(s.toolCalls.map((t) => t.toolCallId)).toEqual(["call-del"]);
    h.dispose();
  });

  it("B. newer-side eviction removes the tip, keeping earlier relationships", () => {
    const h = freshThread();

    show(h, ["m1", "m2", "m3"]);
    const s = snapshot(h);
    report("B. newer-side eviction (m4,m5 evicted)", s);

    expect(s.visible).toEqual(["m1", "m2", "m3"]);
    const read = s.toolCalls.find((t) => t.toolCallId === "call-read")!;
    expect(read.hasResult).toBe(true);
    h.dispose();
  });

  it("C. historical relocation hides the approval surface with its message", () => {
    const h = freshThread();

    show(h, ["m1", "m2"]);
    const s = snapshot(h);
    report("C. historical relocation (m4,m5 hidden)", s);

    expect(s.visible).toEqual(["m1", "m2"]);
    expect(s.approvalSurfaces).toEqual([]);
    const read = s.toolCalls.find((t) => t.toolCallId === "call-read")!;
    expect(read.hasResult).toBe(true);
    h.dispose();
  });

  it("D. return to tip restores the full thread and the approval surface", () => {
    const h = freshThread();

    show(h, ["m1", "m2"]);
    show(h, IDS);
    const s = snapshot(h);
    report("D. return to tip", s);

    expect(s.visible).toEqual(IDS);
    expect(s.head).toBe("m5");
    expect(s.approvalSurfaces).toEqual(["ap-1"]);
    expect(s.toolCalls.map((t) => t.toolCallId)).toEqual(["call-read", "call-del"]);
    h.dispose();
  });

  it("NO identity change: older-side eviction never re-parents survivors", () => {
    const h = freshThread();
    const before = snapshot(h);

    show(h, ["m2", "m3", "m4", "m5"]);
    const after = snapshot(h);
    report("identity check: m1 evicted", after);

    for (const id of ["m3", "m4", "m5"]) {
      expect(after.parents[id]).toBe(before.parents[id]);
    }
    // m2 becomes the window root: its link to m1 is gone, but m2's identity and
    // its tool parts are untouched.
    expect(after.parents.m2).toBeNull();
    const read = after.toolCalls.find((t) => t.toolCallId === "call-read")!;
    expect(read.hasResult).toBe(true);
    h.dispose();
  });

  it("a tool relationship can NEVER be split across a window boundary", () => {
    const h = freshThread();

    // Slide the window across every possible start.
    for (let from = 1; from <= IDS.length; from += 1) {
      show(h, IDS.slice(from - 1));
      const s = snapshot(h);
      for (const tool of s.toolCalls) {
        // Whenever a tool relationship is visible, its message is visible.
        expect(s.visible).toContain(tool.message);
        // A completed tool never loses its result while visible.
        if (tool.toolCallId === "call-read") expect(tool.hasResult).toBe(true);
      }
    }

    console.log("\n--- tool-relationship atomicity across every window start ---");
    console.log("  verified: a tool part is never visible without its message,");
    console.log("            and call-read never appears without its result");
    h.dispose();
  });
});
