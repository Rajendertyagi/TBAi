/**
 * Phase 3 closure — the Anthropic request-shape contract TBAi depends on.
 *
 * ## Why this file exists
 *
 * P3-R3 asked whether TBAi's request construction is compatible with Anthropic
 * AUTOMATIC caching, whose breakpoint sits on the **last cacheable block**. That
 * question cannot be answered by reading TBAi's Layer A/B/C types, because the
 * provider caches a *serialised* prefix whose block order and contents are decided
 * by the SDK adapter. So these tests capture the real HTTP body the installed SDK
 * produces and assert the properties caching depends on.
 *
 * ## What is asserted, and why each matters for caching
 *
 * 1. `cache_control` is emitted at the TOP LEVEL only. That is what selects
 *    automatic caching. A per-block marker would select explicit caching, which
 *    Phase 3 deliberately does not use.
 * 2. **No message id is serialised.** This is the load-bearing finding. TBAi's
 *    `PrefixIdentity` digests retained message *ids*; if those ids reached the
 *    provider body, any id churn would silently invalidate the cache. They do
 *    not — Anthropic messages are `{role, content}` only.
 * 3. Turn N's `messages` are a **byte-exact prefix** of turn N+1's. This is what
 *    makes append-only growth the reusable shape, and it is why a same-length
 *    pair can never produce a read under automatic caching.
 *
 * ## Deliberately not asserted
 *
 * Vendor internals. Nothing here copies a documented threshold or block-count
 * rule; those live in `capabilities.ts` with a source and a date. This file tests
 * **TBAi's adapter contract** — what TBAi sends and can therefore rely on.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, generateText, tool, type UIMessage } from "ai";
import { z } from "zod";

/** The Anthropic request body, reduced to the fields caching depends on. */
interface AnthropicBody {
  model?: string;
  max_tokens?: number;
  cache_control?: { type?: string; ttl?: string } | undefined;
  system?: unknown;
  messages?: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  tools?: Array<{ name: string }>;
}

const MODEL_ID = "claude-opus-5-5";
const origFetch = globalThis.fetch;

/** Install a fetch that captures every Anthropic request body. */
function captureAnthropicRequests(): { bodies: AnthropicBody[] } {
  const bodies: AnthropicBody[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.includes("anthropic.com")) return origFetch(input, init);
    bodies.push(JSON.parse(String(init?.body)) as AnthropicBody);
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { bodies };
}

/** Synthetic, non-sensitive content. No real prompt ever enters this file. */
const TOOLS = {
  read_file: tool({
    description: "Read a file from the workspace.",
    inputSchema: z.object({ path: z.string() }),
    execute: async () => "synthetic",
  }),
};

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}
function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text, state: "done" }] } as unknown as UIMessage;
}

async function send(messages: UIMessage[], system: string): Promise<void> {
  const prompt = await convertToModelMessages(messages, {
    tools: TOOLS,
    ignoreIncompleteToolCalls: true,
  });
  await generateText({
    model: createAnthropic({ apiKey: "test-key" })(MODEL_ID),
    tools: TOOLS,
    system,
    prompt,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  });
}

/** One completed turn plus the next user turn — TBAi's real per-request shape. */
function turnWithTail(tail: string): UIMessage[] {
  return [
    user("u1", "FIRST"),
    assistant("a1", "REPLY-A"),
    user("u2", "SECOND"),
    assistant("a2", "REPLY-B"),
    user("u3", tail),
  ];
}

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("Anthropic automatic-cache request shape", () => {
  it("emits cache_control at the TOP LEVEL only, selecting automatic caching", async () => {
    const { bodies } = captureAnthropicRequests();
    await send(turnWithTail("TAIL"), "STABLE SYSTEM");

    const body = bodies[0] as AnthropicBody;
    // Top level → automatic caching, which needs no per-block marker and
    // therefore no Phase 2 change.
    expect(body.cache_control).toEqual({ type: "ephemeral" });

    // No per-block marker anywhere. A per-block marker would switch the request
    // to EXPLICIT caching, which Phase 3 deliberately does not use.
    const serialised = JSON.stringify(body.messages);
    expect(serialised).not.toContain("cache_control");
  });

  it("serialises NO message id, so id churn cannot invalidate the cache", async () => {
    const { bodies } = captureAnthropicRequests();
    await send(turnWithTail("TAIL"), "STABLE SYSTEM");

    const serialised = JSON.stringify(bodies[0]);
    // The load-bearing finding. TBAi's PrefixIdentity digests retained message
    // ids; if those reached the provider body, id churn would silently break
    // reuse. Anthropic messages are {role, content} only.
    for (const id of ["u1", "a1", "u2", "a2", "u3"]) {
      expect(serialised).not.toContain(`"${id}"`);
    }
  });

  it("places instructions and tools OUTSIDE messages, in the documented order", async () => {
    const { bodies } = captureAnthropicRequests();
    await send(turnWithTail("TAIL"), "STABLE SYSTEM");

    const body = bodies[0] as AnthropicBody;
    // Anthropic documents the cacheable order as tools -> system -> messages.
    // These are three separate top-level fields, so their relative order is fixed
    // by the schema rather than by message ordering.
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.tools?.map((t) => t.name)).toEqual(["read_file"]);
    expect(body.messages?.every((m) => m.content.length > 0)).toBe(true);
  });

  it("makes turn N's messages a BYTE-EXACT prefix of turn N+1's", async () => {
    // This is what makes append-only growth the reusable shape under automatic
    // caching, and it is the evidence P3-R3 was closed on.
    const { bodies } = captureAnthropicRequests();
    const turn1 = [user("u1", "FIRST"), assistant("a1", "REPLY-A")];
    const turn2 = [...turn1, user("u2", "SECOND"), assistant("a2", "REPLY-B"), user("u3", "THIRD")];

    await send(turn1, "STABLE SYSTEM");
    await send(turn2, "STABLE SYSTEM");

    const first = bodies[0] as AnthropicBody;
    const second = bodies[1] as AnthropicBody;
    const firstMessages = first.messages ?? [];
    const secondPrefix = (second.messages ?? []).slice(0, firstMessages.length);

    expect(firstMessages.length).toBe(2);
    expect(secondPrefix.length).toBe(firstMessages.length);
    expect(JSON.stringify(secondPrefix)).toBe(JSON.stringify(firstMessages));
    // And the growth is genuinely appended, not rewritten.
    expect((second.messages ?? []).length).toBeGreaterThan(firstMessages.length);
  });

  it("varies only the final block when the suffix changes", async () => {
    const { bodies } = captureAnthropicRequests();
    await send(turnWithTail("TAIL-A"), "STABLE SYSTEM");
    await send(turnWithTail("TAIL-B"), "STABLE SYSTEM");

    const a = bodies[0] as AnthropicBody;
    const b = bodies[1] as AnthropicBody;
    const strip = (body: AnthropicBody) => JSON.stringify((body.messages ?? []).slice(0, -1));
    expect(strip(a)).toBe(strip(b));
    expect(a.messages?.[a.messages.length - 1]?.content[0]?.text).toBe("TAIL-A");
    expect(b.messages?.[b.messages.length - 1]?.content[0]?.text).toBe("TAIL-B");
  });

  it("sends a stable prefix when the conversation has no instructions", async () => {
    // Layer A is CONDITIONALLY ABSENT in TBAi: `toStreamTextOptions()` yields no
    // `instructions` key at all when the conversation has no system prompt. An
    // absent system field must not disturb the message prefix.
    //
    // NOTE: passing an EMPTY string is a different case and is deliberately not
    // used here — the SDK emits an empty `system` block for it, which would
    // occupy the system slot. TBAi omits the key rather than sending "".
    const { bodies } = captureAnthropicRequests();
    const prompt = await convertToModelMessages(turnWithTail("TAIL"), {
      tools: TOOLS,
      ignoreIncompleteToolCalls: true,
    });
    await generateText({
      model: createAnthropic({ apiKey: "test-key" })(MODEL_ID),
      tools: TOOLS,
      prompt,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });

    const body = bodies[0] as AnthropicBody;
    expect(body.system).toBeUndefined();
    expect(body.messages?.length).toBe(5);
    // The cacheable order still holds with Layer A absent: tools, then messages.
    expect(body.tools?.map((t) => t.name)).toEqual(["read_file"]);
  });
});

describe("P3-R3 · the shape automatic caching can and cannot reuse", () => {
  it("CONFIRMS the reusable shape: append growth keeps the earlier prefix intact", async () => {
    // Under automatic caching the breakpoint lands on the last cacheable block.
    // Because turn N's blocks are a byte-exact prefix of turn N+1's, the earlier
    // write is still present and the provider's documented lookback can find it.
    // This is the vendor's own multi-turn table, reproduced against TBAi's shape.
    const { bodies } = captureAnthropicRequests();
    const turn1 = [user("u1", "FIRST"), assistant("a1", "REPLY-A")];
    const turn2 = [...turn1, user("u2", "SECOND")];
    await send(turn1, "STABLE SYSTEM");
    await send(turn2, "STABLE SYSTEM");

    const first = bodies[0] as AnthropicBody;
    const second = bodies[1] as AnthropicBody;
    const earlier = first.messages ?? [];
    const later = second.messages ?? [];
    // The earlier request's ENTIRE message list survives unchanged in the later.
    expect(JSON.stringify(later.slice(0, earlier.length))).toBe(JSON.stringify(earlier));
    expect(later.length).toBeGreaterThan(earlier.length);
  });

  it("CONFIRMS the non-reusable shape: a same-length pair changes the breakpoint block", async () => {
    // Regenerate / edit-and-resend / retry all produce this: the final block
    // changes at the SAME position. The automatic breakpoint lands on it, its
    // hash differs from the earlier write at that position, and the lookback
    // finds nothing. Cost is a fresh cache WRITE, not a correctness problem —
    // which is why this is a documented limitation rather than a defect.
    const { bodies } = captureAnthropicRequests();
    await send([user("u1", "ORIGINAL")], "STABLE SYSTEM");
    await send([user("u1", "EDITED")], "STABLE SYSTEM");

    const first = bodies[0] as AnthropicBody;
    const second = bodies[1] as AnthropicBody;
    expect(first.messages?.length).toBe(second.messages?.length);
    // Same position, different content — the breakpoint block is NOT stable.
    expect(JSON.stringify(first.messages?.[0])).not.toBe(JSON.stringify(second.messages?.[0]));
  });

  it("records the limitation as a KNOWN one, not an unhandled defect", async () => {
    // The decision itself is pinned: automatic caching is retained, and the
    // same-length case is a documented provider limitation. A future change that
    // silently "fixes" this by injecting markers into Layer C would break the
    // Phase 2 invariant this file exists to protect.
    const { bodies } = captureAnthropicRequests();
    await send(turnWithTail("TAIL"), "STABLE SYSTEM");

    const body = bodies[0] as AnthropicBody;
    // Exactly ONE cache_control in the whole request, and it is the top-level
    // field. Layer C is untouched by the cache layer.
    const wholeRequest = JSON.stringify(body);
    expect(wholeRequest.match(/"cache_control"/g) ?? []).toHaveLength(1);
    // And nothing inside the messages array carries one.
    expect(JSON.stringify(body.messages)).not.toContain("cache_control");
  });
});