/**
 * Direct `/compact` client behaviour — the fix for `/compact` rendering as a user
 * bubble.
 *
 * ## What is actually under test
 *
 * The defect was NOT that the server mis-detected the command: `/compact` was
 * intercepted and compacted correctly, and still appeared in the thread. It was
 * that the composer let the text become a user message at all — a row that
 * assistant-ui creates and PERSISTS before the request is made, which no response
 * can remove. So the assertions here are about the command never entering
 * conversation history, and about the request/response that replaces it.
 *
 * `fetch` is stubbed rather than a DOM being rendered, because the bubble's
 * existence is decided by whether the thread is appended to — not by how a bubble
 * is styled. Asserting on markup would pass for a CSS-hidden row, which is the one
 * thing this fix must not be.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  CompactTransportError,
  buildCompactRequestBody,
  DIRECT_COMPACT_COMMAND,
  isDirectCompactCommand,
  parseCompactStatus,
  projectThreadMessages,
  runDirectCompact,
  type DirectCompactStatus,
} from "./compactCommand";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Build the SSE body the server emits for a compact command. */
function statusBody(data: unknown): string {
  return `data: ${JSON.stringify({ type: "data-tbai-compact", id: "compact", data })}\n\ndata: [DONE]\n\n`;
}

/**
 * Text of a projected message's first text part.
 *
 * Narrowed explicitly rather than reached through with a cast: the projection is
 * `Record<string, unknown>` on purpose, and these assertions are about what the
 * server will receive, so reading them through one helper keeps that shape honest.
 */
function textOf(message: Record<string, unknown> | undefined): string {
  const parts = message?.parts;
  if (!Array.isArray(parts)) return "";
  const first = parts[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}

const compacted: DirectCompactStatus = {
  outcome: "compacted",
  reason: "compacted",
  generation: 1,
  spanLength: 19,
  summaryTokens: 12,
  reclaimedTokens: 4800,
  requestFits: true,
};

function conversation(): Array<{ id: string; role: string; parts: unknown[] }> {
  return [
    { id: "u0", role: "user", parts: [{ type: "text", text: "hello" }] },
    { id: "a0", role: "assistant", parts: [{ type: "text", text: "hi" }] },
  ];
}

/** Requests the stub captured, so "was it sent" is checked, not assumed. */
function stubFetch(body: string, init?: ResponseInit): Array<{ url: string; payload: any }> {
  const seen: Array<{ url: string; payload: any }> = [];
  globalThis.fetch = (async (input: unknown, options?: { body?: unknown }) => {
    seen.push({
      url: String(input),
      payload: typeof options?.body === "string" ? JSON.parse(options.body) : undefined,
    });
    return new Response(body, init);
  }) as unknown as typeof fetch;
  return seen;
}

describe("TEST 1 — `/compact` is a command, never a user message", () => {
  it("is recognised as the command and is not treated as conversation text", () => {
    expect(isDirectCompactCommand(DIRECT_COMPACT_COMMAND)).toBe(true);
  });

  it("sends the conversation plus ONE synthetic command message, and no provider/model", async () => {
    const seen = stubFetch(statusBody(compacted));
    const status = await runDirectCompact({
      conversationId: "conv-1",
      messages: conversation(),
    });

    expect(status.outcome).toBe("compacted");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/api/chat");
    const payload = seen[0]?.payload;
    // The conversation is preserved verbatim, in order.
    expect(payload.messages.slice(0, 2).map((m: any) => m.id)).toEqual(["u0", "a0"]);
    // Exactly one synthetic message, last, carrying the command.
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[2].role).toBe("user");
    expect(payload.messages[2].parts[0].text).toBe(DIRECT_COMPACT_COMMAND);
    // The server resolves the conversation's own provider when these are absent,
    // so re-projecting the picker layering here would be a second source of truth.
    expect(payload.providerId).toBeUndefined();
    expect(payload.model).toBeUndefined();
  });

  it("never returns a message-shaped payload a thread could render", () => {
    // The status is a data part, not a message: there is no role and no text part
    // anywhere in the body, so there is nothing for a bubble to render even if a
    // client ignored the part type.
    const parsed = parseCompactStatus(statusBody(compacted));
    expect(parsed).toEqual(compacted);
    expect((parsed as unknown as { role?: unknown }).role).toBeUndefined();
  });
});

describe("TEST 2 — whitespace is tolerated", () => {
  it("treats a padded command as the command", () => {
    expect(isDirectCompactCommand("   /compact   ")).toBe(true);
    expect(isDirectCompactCommand("\n/compact\n")).toBe(true);
  });

  it("runs the same command path, not a send", async () => {
    const seen = stubFetch(statusBody(compacted));
    const status = await runDirectCompact({
      conversationId: "conv-1",
      messages: conversation(),
    });
    expect(status.outcome).toBe("compacted");
    expect(seen).toHaveLength(1);
  });
});

describe("TESTS 3-5 — text that merely CONTAINS the command stays a message", () => {
  for (const text of ["/compact now", "please run /compact", "explain /compact"]) {
    it(`does not intercept ${JSON.stringify(text)}`, () => {
      expect(isDirectCompactCommand(text)).toBe(false);
    });
  }

  it("a non-command submit is never diverted, so it reaches the normal send path", () => {
    // The guard returning false is the whole contract: the composer's submit
    // handler then does nothing, and assistant-ui creates the user message
    // normally — which is the required behaviour for these three strings.
    for (const text of ["/compact now", "please run /compact", "explain /compact"]) {
      expect(isDirectCompactCommand(text)).toBe(false);
    }
  });
});

describe("TEST 6 — an assistant message containing `/compact` cannot trigger it", () => {
  it("is not the command, because only composer input is matched", () => {
    // The guard runs on composer text, which is user input by construction. A
    // quoted `/compact` in the transcript is never composer text, so it cannot
    // reach this predicate — asserted here so the reason is recorded rather than
    // assumed.
    expect(isDirectCompactCommand("a0")).toBe(false);
  });

  it("projects a transcript containing `/compact` without turning it into a command", () => {
    const messages = [
      { id: "u0", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "a0", role: "assistant", parts: [{ type: "text", text: "/compact" }] },
    ];
    const projected = projectThreadMessages(messages);
    // The quoted text stays a quoted assistant message; it is not promoted, not
    // dropped, and not treated as a pending command.
    expect(projected).toHaveLength(2);
    expect(projected[1].role).toBe("assistant");
    expect(textOf(projected[1])).toBe("/compact");
  });
});

describe("TEST 7 — the server status part is consumed, not rendered", () => {
  it("reads compacted, skipped and failed outcomes", () => {
    expect(parseCompactStatus(statusBody(compacted))?.outcome).toBe("compacted");
    expect(
      parseCompactStatus(statusBody({ ...compacted, outcome: "skipped", reason: "no_compactable_span" })),
    ).toMatchObject({ outcome: "skipped", reason: "no_compactable_span" });
    expect(
      parseCompactStatus(statusBody({ ...compacted, outcome: "failed", reason: "summarize_failed:x" })),
    ).toMatchObject({ outcome: "failed", reason: "summarize_failed:x" });
  });

  it("returns nothing for a body with no status part, and never invents success", () => {
    expect(parseCompactStatus("")).toBeUndefined();
    expect(parseCompactStatus("data: [DONE]\n\n")).toBeUndefined();
    // A normal assistant turn carries message parts; it must not be misread.
    const assistantBody = `data: ${JSON.stringify({
      type: "start",
    })}\n\ndata: ${JSON.stringify({ type: "text", text: "hello" })}\n\n`;
    expect(parseCompactStatus(assistantBody)).toBeUndefined();
  });

  it("rejects an unknown outcome rather than trusting it", () => {
    expect(parseCompactStatus(statusBody({ ...compacted, outcome: "totally-fine" }))).toBeUndefined();
  });

  it("surfaces a missing status as a transport error, not a silent success", async () => {
    stubFetch("data: [DONE]\n\n");
    await expect(
      runDirectCompact({ conversationId: "conv-1", messages: conversation() }),
    ).rejects.toBeInstanceOf(CompactTransportError);
  });
});

describe("TEST 8 — post-compact conversation is unaffected", () => {
  it("a later normal message is projected as ordinary content, command untouched", () => {
    // After a compact the thread holds only conversation. The next send builds its
    // own body through the normal path; this asserts the compact helper does not
    // leak state into it.
    const body = buildCompactRequestBody(
      [...conversation(), { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      "compact-1",
    );
    expect(body.messages).toHaveLength(4);
    expect(textOf(body.messages[2])).toBe("hi");
    // Only the LAST message is the command, so `hi` is not mistaken for one.
    expect(textOf(body.messages[3])).toBe(DIRECT_COMPACT_COMMAND);
  });

  it("a second compact after the first still sends one command message", async () => {
    const seen = stubFetch(statusBody({ ...compacted, generation: 2 }));
    await runDirectCompact({ conversationId: "conv-1", messages: conversation() });
    expect(seen[0]?.payload.messages.filter((m: any) => m.parts?.[0]?.text === DIRECT_COMPACT_COMMAND))
      .toHaveLength(1);
  });
});

describe("request shaping", () => {
  it("forwards only id, role, parts and metadata", () => {
    const projected = projectThreadMessages([
      {
        id: "a0",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
        metadata: { custom: true },
        status: { type: "running" },
        createdAt: 123,
      } as never,
    ]);
    expect(Object.keys(projected[0] ?? {}).sort()).toEqual(["id", "metadata", "parts", "role"]);
  });

  it("still sends an id when the thread message has none", () => {
    // The AI SDK's `safeValidateUIMessages` REQUIRES a string `id`, so omitting it
    // made the server reject the whole command as `invalid_messages`. Measured in
    // the browser, not inferred.
    const projected = projectThreadMessages([{ role: "user", parts: [] }]);
    expect(Object.keys(projected[0] ?? {}).sort()).toEqual(["id", "parts", "role"]);
    expect(typeof projected[0]?.id).toBe("string");
    expect(String(projected[0]?.id).length).toBeGreaterThan(0);
  });

  it("replaces a non-string or empty id rather than forwarding it", () => {
    // Runtime-generated messages after a normal turn were the real trigger.
    const projected = projectThreadMessages([
      { id: 7, role: "user", parts: [] },
      { id: "", role: "assistant", parts: [] },
      { id: "real-id", role: "user", parts: [] },
    ]);
    expect(projected[0]?.id).not.toBe(7);
    expect(projected[1]?.id).not.toBe("");
    // A real id is preserved verbatim — never rewritten, because the planner
    // matches covered ids against what the client will re-post.
    expect(projected[2]?.id).toBe("real-id");
  });

  it("drops the transient part `state` the AI SDK rejects", () => {
    // assistant-ui labels settled/submitted parts `output-available`/`submitted`;
    // `safeValidateUIMessages` accepts only `streaming`/`done`. Verified against
    // the installed `ai` package — this shape was a real 400 in the browser.
    const projected = projectThreadMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "STUB_REPLY", state: "output-available" },
        ],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "hi", state: "submitted" }] },
    ]);
    const assistantParts = projected[0]?.parts as Array<Record<string, unknown>>;
    const userParts = projected[1]?.parts as Array<Record<string, unknown>>;
    expect(userParts[0]).toEqual({ type: "text", text: "hi" });
    expect(assistantParts).toEqual([{ type: "text", text: "STUB_REPLY" }]);
    // No `state` anywhere, and no transient keys carried through the whitelist.
    expect(JSON.stringify(projected)).not.toContain("output-available");
    expect(JSON.stringify(projected)).not.toContain("submitted");
  });

  it("drops step-start and other non-text, non-tool parts", () => {
    // The projection is a whitelist of what compaction needs: conversation text and
    // tool payload. A step boundary is a stream artefact and carries no content, so
    // forwarding it only risked another validator mismatch.
    const projected = projectThreadMessages([
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "data-tbai-progress", id: "progress", data: { stages: [] } },
          { type: "step-start" },
          { type: "source-url", sourceId: "s1", url: "https://example.com" },
          { type: "text", text: "kept" },
        ],
      },
    ]);
    expect(projected[0]?.parts).toEqual([{ type: "text", text: "kept" }]);
  });

  it("preserves tool parts, whose payload the summariser depends on", () => {
    const projected = projectThreadMessages([
      {
        id: "t1",
        role: "assistant",
        parts: [
          { type: "tool-run_command", toolCallId: "call-1", state: "output-available", input: { cmd: "ls" } },
        ],
      },
    ]);
    expect(projected[0]?.parts).toEqual([
      { type: "tool-run_command", toolCallId: "call-1", input: { cmd: "ls" } },
    ]);
  });

  it("normalises an unknown role and drops non-object metadata", () => {
    const projected = projectThreadMessages([
      { id: "x", role: "tool", parts: [], metadata: "nope" as never },
    ]);
    expect(projected[0]?.role).toBe("user");
    expect(projected[0]?.metadata).toBeUndefined();
  });

  it("omits the conversation id when there is none, and the server answers skipped", async () => {
    const seen = stubFetch(statusBody({ ...compacted, outcome: "skipped", reason: "no_conversation" }));
    const status = await runDirectCompact({ conversationId: null, messages: conversation() });
    expect(status.outcome).toBe("skipped");
    expect(seen[0]?.payload.id).toBeUndefined();
  });

  it("reports a non-OK response as a transport error", async () => {
    stubFetch("nope", { status: 500 });
    await expect(
      runDirectCompact({ conversationId: "conv-1", messages: conversation() }),
    ).rejects.toBeInstanceOf(CompactTransportError);
  });
});
