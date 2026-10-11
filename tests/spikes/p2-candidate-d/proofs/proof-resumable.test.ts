/**
 * SPIKE — OPTION B PROOF: resumable streaming (highest-risk unknown).
 * TEMPORARY, removable.
 *
 * Proves the decomposition preserves the resumable path:
 *   send → partial stream + `x-resumable-stream-id` → disconnect
 *   → resumeStream() → resumeApi(streamId) → continuation → same message.
 *
 * The transport and Chat are the REAL installed ones. Only `fetch` is
 * intercepted, and only to script a deterministic disconnect + resume.
 */

import { describe, expect, it } from "bun:test";
import { createProof, chainFromTo, type AiMsg } from "./proof-harness";

const enc = new TextEncoder();
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

/** A stream that emits `chunks` then closes (or stays open if `hold`). */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function inMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getStreamId: (t?: string) => map.get(t ?? "proof-thread") ?? null,
    setStreamId: (id: string, t?: string) => void map.set(t ?? "proof-thread", id),
    clear: (t?: string) => void map.delete(t ?? "proof-thread"),
    subscribe: () => () => {},
    _map: map,
  };
}

describe("Option B — resumable streaming", () => {
  it("send → disconnect → resumeStream continues the SAME message", async () => {
    const storage = inMemoryStorage();
    const resumeUrls: string[] = [];
    const MESSAGE_ID = "assistant-1";

    // Initial send: stream-id header + a PARTIAL assistant message, no finish.
    const partial = streamOf([
      sse({ type: "start", messageId: MESSAGE_ID }),
      sse({ type: "text-start", id: "t1" }),
      sse({ type: "text-delta", id: "t1", delta: "Hello" }),
      // disconnect: no text-end, no finish
    ]);
    // Resume: the continuation of the SAME message.
    const continuation = streamOf([
      sse({ type: "text-delta", id: "t1", delta: " world" }),
      sse({ type: "text-end", id: "t1" }),
      sse({ type: "finish" }),
    ]);

    const h = createProof({
      window: chainFromTo(451, 500),
      resumable: {
        storage,
        resumeApi: (streamId) => {
          resumeUrls.push(streamId);
          return `/api/chat/resume/${streamId}`;
        },
      },
      onFetch: (url) => {
        if (url.includes("/resume/")) {
          return new Response(continuation, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return new Response(partial, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "x-resumable-stream-id": "stream-1",
          },
        });
      },
    });

    // 1. Send. The partial stream arrives and the stream id is stored.
    await h.send("question");
    await new Promise((r) => setTimeout(r, 60));

    console.log("\n=== resumable: after partial send ===");
    console.log("  stored stream id:", storage.getStreamId());
    console.log("  chat status:", (h.chat as never as { status: string }).status);
    console.log("  chat.messages:", h.chatIds().length);

    expect(storage.getStreamId()).toBe("stream-1");

    const beforeResume = h.chatIds().length;

    // 2. Resume. The transport must hit resumeApi with the stored id.
    await (h.chat as never as { resumeStream: () => Promise<void> }).resumeStream();
    await new Promise((r) => setTimeout(r, 60));

    console.log("=== resumable: after resumeStream ===");
    console.log("  resumeApi called with:", resumeUrls.join(","));
    console.log("  chat.messages before/after:", beforeResume, "->", h.chatIds().length);
    console.log("  stream id after finish:", storage.getStreamId());

    // 3. The SAME message continued — no duplicate assistant message.
    expect(resumeUrls).toEqual(["stream-1"]);
    expect(h.chatIds().length).toBe(beforeResume);

    // 4. The finish marker cleared the stored stream id.
    expect(storage.getStreamId()).toBeNull();

    h.dispose();
  });

  it("the repository stays synchronized with the Chat across the resume", async () => {
    const storage = inMemoryStorage();
    const MESSAGE_ID = "assistant-2";

    const partial = streamOf([
      sse({ type: "start", messageId: MESSAGE_ID }),
      sse({ type: "text-start", id: "t1" }),
      sse({ type: "text-delta", id: "t1", delta: "abc" }),
    ]);
    const continuation = streamOf([
      sse({ type: "text-delta", id: "t1", delta: "def" }),
      sse({ type: "text-end", id: "t1" }),
      sse({ type: "finish" }),
    ]);

    const h = createProof({
      window: chainFromTo(451, 500),
      resumable: { storage, resumeApi: (id) => `/api/chat/resume/${id}` },
      onFetch: (url) =>
        url.includes("/resume/")
          ? new Response(continuation, { status: 200, headers: { "Content-Type": "text/event-stream" } })
          : new Response(partial, {
              status: 200,
              headers: { "Content-Type": "text/event-stream", "x-resumable-stream-id": "stream-2" },
            }),
    });

    await h.send("go");
    await new Promise((r) => setTimeout(r, 60));
    await (h.chat as never as { resumeStream: () => Promise<void> }).resumeStream();
    await new Promise((r) => setTimeout(r, 60));

    // Re-sync the repository from the Chat (what the production controller does
    // on every Chat change) and confirm the head is the new assistant message.
    h.setWindow(h.chat.messages as unknown as AiMsg[]);

    console.log("\n=== resumable: repository sync after resume ===");
    console.log("  chat tip:", h.chatIds().at(-1));
    console.log("  repository head:", h.headId());
    console.log("  visible count:", h.visibleIds().length);

    expect(h.headId()).toBe(h.chatIds().at(-1));
    h.dispose();
  });
});