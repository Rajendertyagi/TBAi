/**
 * SPIKE â€” P2 Candidate D, Phase 4: THE CRITICAL SEMANTIC BOUNDARY.
 * TEMPORARY, REMOVABLE.
 *
 * Question under test:
 *   authoritative history  m1..m500
 *   visible window         m451..m500
 *   user sends             m501
 * Does the model receive only m451..m500, the whole conversation, or something
 * else?
 *
 * Method: build the REAL AI SDK `Chat` (the object the transport submits from)
 * over a capturing transport that records the exact `messages` array handed to
 * `sendMessages`. Nothing is inferred from source: the payload is the array
 * the AI SDK itself produced at submit time.
 */

import { describe, expect, it } from "bun:test";
import { Chat } from "D:/Temp/ai-chat-app/node_modules/.bun/@assistant-ui+ai-sdk@0.0.11+4c71a919fb8f23d6/node_modules/@ai-sdk/react/dist/index.js";
import { buildChain, sliceChain, type UiMessage } from "../harness.ts";

type Captured = {
  messages: unknown[];
  chatId?: string;
  trigger?: string;
};

type UIMessage = {
  id: string;
  role: "user" | "assistant";
  parts: Array<{ type: "text"; text: string }>;
};

const chain = buildChain(500);

/** AI SDK UIMessage shape: `parts`, not `content`. */
function toAiMessages(slice: readonly UiMessage[]): UIMessage[] {
  return slice.map((m) => ({
    id: m.id,
    role: m.role,
    parts: [{ type: "text" as const, text: m.content[0].text }],
  }));
}

/**
 * A transport that records what it was asked to send and then settles, so the
 * Chat reaches a terminal state without a server.
 */
function capturingTransport(captured: Captured[]) {
  return {
    async sendMessages(options: {
      chatId?: string;
      messages: unknown[];
      trigger?: string;
      abortSignal?: AbortSignal;
    }) {
      captured.push({
        messages: JSON.parse(JSON.stringify(options.messages)) as unknown[],
        chatId: options.chatId,
        trigger: options.trigger,
      });
      // An empty readable stream is the terminal "no chunks" response; the Chat
      // treats the run as finished and stops.
      return new ReadableStream<never>({
        start(controller) {
          controller.close();
        },
      });
    },
    async reconnectToStream() {
      return new ReadableStream<never>({
        start(controller) {
          controller.close();
        },
      });
    },
  };
}

describe("P2 spike â€” what does the AI SDK actually submit?", () => {
  it("submits ONLY the messages the Chat holds, not the authoritative history", async () => {
    const captured: Captured[] = [];
    // The Chat is seeded with the bounded window only. It has no other source.
    const chat = new Chat({
      id: "spike-thread",
      transport: capturingTransport(captured),
      messages: toAiMessages(sliceChain(chain, 451, 500)),
    });

    await chat.sendMessage({
      id: "m501",
      role: "user",
      parts: [{ type: "text", text: "next" }],
    });

    expect(captured.length).toBe(1);
    const sent = captured[0].messages as Array<{ id: string }>;
    const ids = sent.map((m) => m.id);

    // MEASURED: 51 â€” the 50-message window plus the new one. The 450 older
    // messages are absent from the submission.
    console.log("=== PROBE: submitted payload with a bounded window ===");
    console.log("submitted count:", ids.length);
    console.log("submitted first:", ids[0]);
    console.log("submitted last:", ids[ids.length - 1]);
    console.log("contains m1?", ids.includes("m1"));
    console.log("contains m450?", ids.includes("m450"));

    expect(ids.length).toBe(51);
    expect(ids[0]).toBe("m451");
    expect(ids[ids.length - 1]).toBe("m501");
    expect(ids).not.toContain("m1");
    expect(ids).not.toContain("m450");
  });

  it("submits the whole array when the Chat holds the whole conversation", async () => {
    const captured: Captured[] = [];
    const chat = new Chat({
      id: "spike-thread",
      transport: capturingTransport(captured),
      messages: toAiMessages(chain),
    });

    await chat.sendMessage({
      id: "m501",
      role: "user",
      parts: [{ type: "text", text: "next" }],
    });

    const ids = (captured[0].messages as Array<{ id: string }>).map((m) => m.id);
    console.log("=== PROBE: submitted payload with the full chain ===");
    console.log("submitted count:", ids.length);
    expect(ids.length).toBe(501);
    expect(ids[0]).toBe("m1");
  });

  it("confirming the boundary: payload length tracks the Chat, not the window manager", async () => {
    const captured: Captured[] = [];
    const chat = new Chat({
      id: "spike-thread",
      transport: capturingTransport(captured),
      messages: toAiMessages(sliceChain(chain, 351, 400)),
    });

    await chat.sendMessage({
      id: "m401",
      role: "user",
      parts: [{ type: "text", text: "next" }],
    });

    const ids = (captured[0].messages as Array<{ id: string }>).map((m) => m.id);
    console.log("=== PROBE: window that EXCLUDES the tip ===");
    console.log("submitted count:", ids.length);
    console.log("submitted last:", ids[ids.length - 1]);
    // A window ending at m400 with the authoritative tip at m500 submits a
    // history that stops at m401. Nothing downstream can know m401..m500 existed.
    expect(ids.length).toBe(51);
    expect(ids[ids.length - 1]).toBe("m401");
  });
});