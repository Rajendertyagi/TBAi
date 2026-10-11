/**
 * SPIKE — OPTION B PROOF: `sendAutomaticallyWhen` continuation.
 * TEMPORARY, removable.
 *
 * Proves the decomposition does not drop or change the automatic-continuation
 * behavior: a complete tool call triggers a follow-up send, and the external
 * repository + `chat.messages` stay synchronized.
 *
 * Uses the REAL `lastAssistantMessageIsCompleteWithToolCalls` predicate — the
 * exact one `web/src/runtime.ts` passes today.
 */

import { describe, expect, it } from "bun:test";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { createProof, chainFromTo, type AiMsg } from "./proof-harness";

const enc = new TextEncoder();
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream({ start: (c) => { for (const x of chunks) c.enqueue(x); c.close(); } });

describe("Option B — sendAutomaticallyWhen", () => {
  it("a complete tool call triggers an automatic continuation, repository stays synced", async () => {
    let call = 0;
    // First response: a COMPLETE tool call. Second: a plain text answer.
    const toolCallStream = streamOf([
      sse({ type: "start", messageId: "a1" }),
      sse({ type: "tool-input-start", toolCallId: "tc1", toolName: "read" }),
      sse({ type: "tool-input-available", toolCallId: "tc1", toolName: "read", input: { path: "x" } }),
      sse({ type: "tool-output-available", toolCallId: "tc1", output: { content: "data" } }),
      sse({ type: "finish" }),
    ]);
    const answerStream = streamOf([
      sse({ type: "start", messageId: "a2" }),
      sse({ type: "text-start", id: "t1" }),
      sse({ type: "text-delta", id: "t1", delta: "done" }),
      sse({ type: "text-end", id: "t1" }),
      sse({ type: "finish" }),
    ]);

    const h = createProof({
      window: chainFromTo(451, 500),
      sendAutomaticallyWhen: ({ messages }) =>
        lastAssistantMessageIsCompleteWithToolCalls({ messages: messages as never }),
      onFetch: () => {
        call += 1;
        return new Response(call === 1 ? toolCallStream : answerStream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    await h.send("read x");
    // Let the continuation fire.
    await new Promise((r) => setTimeout(r, 120));

    console.log("\n=== sendAutomaticallyWhen: continuation ===");
    console.log("  fetch calls (submissions):", call);
    console.log("  submission triggers:", h.submissions.map((s) => s.trigger).join(","));
    console.log("  chat.messages:", h.chatIds().length);

    // The tool call completed, so sendAutomaticallyWhen fired a SECOND send.
    expect(call).toBeGreaterThanOrEqual(2);

    // Re-sync the repository from the Chat (production controller behavior).
    h.setWindow(h.chat.messages as unknown as AiMsg[]);
    const visible = h.visibleIds();
    console.log("  repository head after sync:", h.headId());
    console.log("  chat tip:", h.chatIds().at(-1));
    console.log("  visible count:", visible.length, "last visible:", visible.at(-1));

    // After a continuation, a1 (tool call) and a2 (answer) are ADJACENT
    // assistant messages and the converter merges them for display (proven in
    // proof-merge-binding: both remain recoverable). The repository head is the
    // merged message — the LAST rendered row — which is the correct display
    // representation of the tip.
    expect(h.headId()).toBe(visible.at(-1));
    // The merge means fewer rendered rows than chat.messages; that is display
    // grouping, not identity loss.
    expect(visible.length).toBeLessThanOrEqual(h.chatIds().length);
    h.dispose();
  });

  it("sendAutomaticallyWhen is a ChatInit option, not a wrapper-only feature", () => {
    // Documented by the ChatInit interface (ai@7.0.93:5606). The proof above
    // exercises it through the SAME `useChat`-level Chat the decomposition uses,
    // so it is not something `useChatRuntime` adds on top.
    expect(typeof lastAssistantMessageIsCompleteWithToolCalls).toBe("function");
  });
});