/**
 * SPIKE — OPTION B PROOF: HISTORICAL_VIEW on the real runtime (section 9).
 * TEMPORARY, removable.
 *
 * The full capability matrix. `isSendDisabled` blocks the composer send but
 * NOT edit — so edit/regenerate/delete/branch are blocked by CAPABILITY
 * ABSENCE (omitted callbacks), and append is blocked by `isSendDisabled` PLUS
 * the controller exposing no direct-append path.
 */

import { describe, expect, it } from "bun:test";
import { createProof, chainFromTo, ai, type AiMsg } from "./proof-harness";

const enc = new TextEncoder();
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream({ start: (c) => { for (const x of chunks) c.enqueue(x); c.close(); } });

describe("Option B — HISTORICAL_VIEW (real runtime)", () => {
  it("blocks all five mutations while sync keeps working; restore re-enables", async () => {
    const h = createProof({ window: chainFromTo(351, 400) });
    h.setHistoricalView(true);

    const caps = h.capabilities();
    console.log("\n=== HISTORICAL_VIEW capabilities ===");
    console.log("  ", JSON.stringify(caps));
    console.log("  isSendDisabled:", (h.runtime as never as { isSendDisabled: boolean }).isSendDisabled);

    // Capability ABSENCE for edit/regenerate/delete/branch.
    expect(caps.edit).toBe(false);
    expect(caps.reload).toBe(false);
    expect(caps.delete).toBe(false);
    expect(caps.switchToBranch).toBe(false);
    // Append blocked at the COMPOSER via isSendDisabled.
    expect((h.runtime as never as { isSendDisabled: boolean }).isSendDisabled).toBe(true);
    expect((h.runtime.composer as never as { canSend: boolean }).canSend).toBe(false);

    // Composer send → 0 submissions.
    await (h.runtime.composer as never as { send: () => Promise<void> }).send();
    await new Promise((r) => setTimeout(r, 30));
    console.log("  submissions after composer send:", h.submissions.length);
    expect(h.submissions.length).toBe(0);

    // Synchronization still works: repository replacement.
    h.setWindow(chainFromTo(340, 400));
    expect(h.visibleIds().length).toBe(61);
    console.log("  repository replacement: visible", h.visibleIds().length);

    // Restore to tip re-enables everything.
    h.setHistoricalView(false);
    h.setWindow(chainFromTo(451, 500));
    const restored = h.capabilities();
    console.log("  restored capabilities:", JSON.stringify(restored));
    expect(restored.edit).toBe(true);
    expect(restored.reload).toBe(true);
    expect(restored.delete).toBe(true);
    expect(restored.switchToBranch).toBe(true);
    expect((h.runtime as never as { isSendDisabled: boolean }).isSendDisabled).toBe(false);

    await h.send("back");
    expect(h.submissions.length).toBe(1);
    h.dispose();
  });

  it("streaming synchronization remains functional in HISTORICAL_VIEW", async () => {
    const h = createProof({
      window: chainFromTo(351, 400),
      onFetch: () =>
        new Response(
          streamOf([
            sse({ type: "start", messageId: "s1" }),
            sse({ type: "text-start", id: "t1" }),
            sse({ type: "text-delta", id: "t1", delta: "chunk" }),
            sse({ type: "text-end", id: "t1" }),
            sse({ type: "finish" }),
          ]),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    h.setHistoricalView(true);

    // A stream delta arrives (e.g. an in-flight run from before the navigation).
    // The window ends on a USER message (the one that triggered the run), so the
    // incoming assistant delta is not merged with a preceding assistant.
    h.setWindow([...chainFromTo(351, 399), ai("s1", "assistant", "chunk")]);
    const visible = h.visibleIds();
    console.log("\n=== HISTORICAL_VIEW: stream sync ===");
    console.log("  visible after stream sync:", visible.length, "last:", visible.at(-1));
    expect(visible.length).toBe(50);
    expect(visible.at(-1)).toBe("s1");
    h.dispose();
  });

  it("approval/tool state remains functional in HISTORICAL_VIEW", () => {
    const h = createProof({ window: chainFromTo(351, 400) });
    h.setHistoricalView(true);
    h.setWindow([
      ai("m390", "user"),
      {
        id: "m391",
        role: "assistant",
        parts: [
          {
            type: "tool-read",
            toolCallId: "tc1",
            state: "approval-requested",
            input: { path: "x" },
            approval: { id: "ap-1", prompt: "Delete?" },
          },
        ],
      } as AiMsg,
    ]);

    const exported = h.repository.export().messages as unknown as Array<{
      message: { id: string; content: Array<Record<string, unknown>>; status?: { type: string } };
    }>;
    const assistant = exported.find((e) => e.message.id === "m391")?.message;
    const toolPart = assistant?.content.find((c) => c.type === "tool-call");

    console.log("\n=== HISTORICAL_VIEW: approval state ===");
    console.log("  approval id:", JSON.stringify(toolPart?.approval ?? null));
    console.log("  message status:", JSON.stringify(assistant?.status ?? null));

    expect((toolPart?.approval as { id?: string })?.id).toBe("ap-1");
    h.dispose();
  });
});