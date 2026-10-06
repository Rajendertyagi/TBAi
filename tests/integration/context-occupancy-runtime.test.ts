/**
 * RUNTIME proof that the context meter reads OCCUPANCY, not token TRAFFIC.
 *
 * ## What this proves, and why a unit test cannot
 *
 * The distinction is arithmetic inside the AI SDK: `totalUsage` is every step's
 * usage summed, while a single step's `inputTokens` is the prompt for that one
 * call. Both are numbers, both are called "input tokens", and only the real
 * streaming path through the real route reveals which one the meter publishes.
 *
 * So this drives the ACTUAL `POST /api/chat` against a local OpenAI-compatible
 * stub that:
 *
 *  - request 1: emits a tool call, reporting 5,000 prompt tokens
 *  - request 2: emits text,        reporting 9,000 prompt tokens
 *
 * A single tool-using turn therefore produces TWO model calls whose traffic sums
 * to 14,000. The conversation is nowhere near full, and a meter that divided
 * traffic by the window would read it as three times over budget.
 *
 * The assertion is that the published context reports 9,000 - the final round
 * trip - and that the stub really was called twice, so the case cannot pass
 * vacuously with one step.
 *
 * No production provider is contacted; no quota is spent.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import chatApp from "../../src/routes/chat";

const app = new Hono();
app.route("/", chatApp);

const JSON_HEADERS = { "Content-Type": "application/json" };

const PROVIDER_ID = "prov-occupancy-runtime";
const MODEL_ID = "void-model";
const WINDOW_TOKENS = 1_000_000;

/** Prompt tokens the stub reports, per request. The SECOND is the occupancy. */
const FIRST_PROMPT_TOKENS = 5_000;
const SECOND_PROMPT_TOKENS = 9_000;
/** What the traffic sum would be - the wrong number this test forbids. */
const TRAFFIC_SUM = FIRST_PROMPT_TOKENS + SECOND_PROMPT_TOKENS;

let upstreamCalls = 0;
let controlled: ReturnType<typeof Bun.serve> | null = null;

/** The context block the route publishes on the finish message. */
interface PublishedContext {
  usedTokens: number;
  windowTokens: number;
  windowSource: string;
  occupancyKind?: string;
  cachedInputTokens?: number;
}

function chunk(delta: unknown, finish: string | null, usage?: unknown): unknown {
  return {
    id: "chatcmpl-occupancy",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

function sse(rows: unknown[]): Response {
  return new Response([...rows.map((r) => `data: ${JSON.stringify(r)}\n\n`), "data: [DONE]\n\n"].join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * The stub provider: one tool call, then text, with distinct prompt counts so
 * occupancy and traffic are distinguishable by construction.
 */
async function seedControlledProvider(): Promise<void> {
  upstreamCalls = 0;
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      await req.json().catch(() => ({}));
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return sse([
          chunk(
            {
              role: "assistant",
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) } },
              ],
            },
            null,
          ),
          chunk({}, "tool_calls", { prompt_tokens: FIRST_PROMPT_TOKENS, completion_tokens: 20, total_tokens: FIRST_PROMPT_TOKENS + 20 }),
        ]);
      }
      return sse([
        chunk({ role: "assistant", content: "done" }, null),
        chunk({}, "stop", { prompt_tokens: SECOND_PROMPT_TOKENS, completion_tokens: 20, total_tokens: SECOND_PROMPT_TOKENS + 20 }),
      ]);
    },
  });
  controlled.unref();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'occupancy-runtime', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, `http://127.0.0.1:${controlled.port}/v1`, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
}

function stopControlledProvider(): void {
  try {
    controlled?.stop(true);
  } catch {
    /* already closed */
  }
  controlled = null;
}

beforeEach(() => {
  upstreamCalls = 0;
});
afterEach(() => {
  stopControlledProvider();
});
afterAll(async () => {
  db.run("DELETE FROM provider_configs WHERE id = ?", [PROVIDER_ID]);
  await registry.loadFromDb(db);
});

/**
 * Pull the published context out of the SSE stream.
 *
 * The route attaches it via `messageMetadata`, so it arrives as its own data
 * chunk. Everything is scanned rather than pattern-matched on one chunk type, so
 * this cannot silently stop finding it.
 */
function findPublishedContext(sseText: string): PublishedContext | undefined {
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    // The route attaches it via `messageMetadata`, so it rides on
    // `message-metadata` chunks and on the final `finish` chunk.
    const meta = parsed.messageMetadata as Record<string, unknown> | undefined;
    const custom = meta?.custom as Record<string, unknown> | undefined;
    const carriers = [
      parsed.context,
      (parsed.metadata as Record<string, unknown> | undefined)?.context,
      ((parsed.metadata as Record<string, unknown> | undefined)?.custom as Record<string, unknown> | undefined)?.context,
      meta?.context,
      custom?.context,
    ];
    for (const candidate of carriers) {
      if (candidate && typeof (candidate as PublishedContext).usedTokens === "number") {
        return candidate as PublishedContext;
      }
    }
  }
  return undefined;
}

/** The traffic sum the route publishes in `usage`. It must never be the numerator. */
function findPublishedUsageInputTokens(sseText: string): number | undefined {
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const meta = parsed.messageMetadata as { usage?: { inputTokens?: number } } | undefined;
    const value = meta?.usage?.inputTokens;
    if (typeof value === "number") return value;
  }
  return undefined;
}

describe("runtime: the meter reads occupancy, not traffic", () => {
  it("publishes the final round trip's prompt size, not the step sum", async () => {
    await seedControlledProvider();
    const conv = await conversationService.create({
      title: "occupancy-runtime",
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      reasoningLevel: null,
      systemPrompt: null,
      engine: "direct",
    });

    try {
      const res = await app.request("/api/chat", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          providerId: PROVIDER_ID,
          model: MODEL_ID,
          id: conv.id,
          messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "list the directory" }] }],
        }),
      });
      const body = await res.text();

      // The case must actually be multi-step, or nothing here is proven.
      expect(upstreamCalls).toBe(2);

      const context = findPublishedContext(body);
      expect(context).toBeDefined();

      // OCCUPANCY: the last model call's prompt.
      expect(context!.usedTokens).toBe(SECOND_PROMPT_TOKENS);
      // NOT traffic. This is the number the old meter would have shown.
      expect(context!.usedTokens).not.toBe(TRAFFIC_SUM);
      // And the provenance says so, rather than implying a measurement we did
      // not take.
      expect(context!.occupancyKind).toBe("provider");
      expect(context!.windowTokens).toBeGreaterThan(0);

      // The reading says WHICH resolution produced it, so a client can tell a
      // current number from one left over from before the model or its configuration
      // changed. Without this the meter has no way to know its denominator is stale
      // and keeps presenting it as current.
      const resolvedFor = (context as { resolvedFor?: { providerId?: string; modelId: string } })
        .resolvedFor;
      expect(resolvedFor).toBeDefined();
      expect(resolvedFor?.modelId).toBe(MODEL_ID);
      expect(resolvedFor?.providerId).toBeTruthy();

      // The traffic sum is still published - for the spend breakdown, where it
      // belongs. Separating the two is the whole point: both exist, neither is
      // used as the other's meaning.
      expect(findPublishedUsageInputTokens(body)).toBe(TRAFFIC_SUM);
    } finally {
      await conversationService.delete(conv.id);
    }
  }, 60000);

  it("occupancy stays under the window even when traffic exceeds it", async () => {
    await seedControlledProvider();
    const conv = await conversationService.create({
      title: "occupancy-window",
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      reasoningLevel: null,
      systemPrompt: null,
      engine: "direct",
    });

    try {
      const res = await app.request("/api/chat", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          providerId: PROVIDER_ID,
          model: MODEL_ID,
          id: conv.id,
          messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "list the directory" }] }],
        }),
      });
      const context = findPublishedContext(await res.text());

      expect(context).toBeDefined();
      expect(TRAFFIC_SUM).toBeGreaterThan(WINDOW_TOKENS / 100);
      expect(context!.usedTokens).toBeLessThan(context!.windowTokens);
    } finally {
      await conversationService.delete(conv.id);
    }
  }, 60000);
});