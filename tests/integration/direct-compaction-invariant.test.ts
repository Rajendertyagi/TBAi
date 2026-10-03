/**
 * The compaction-validation invariant.
 *
 * ## The defect this exists to prevent
 *
 * Compaction is CONTAINED: `summarizeSpan` returns `{ok:false}` rather than throwing, so
 * `assembleForRequest` can resolve having compacted NOTHING. Recovery used to treat a
 * resolved assembly as proof of success and retry — re-sending the identical oversized
 * history to the same provider, which can only overflow again. Worse, the summariser
 * request had already been made, so it looked like a recovery had happened.
 *
 * The invariant: a summariser invocation is NOT authorisation to retry. Only an applied
 * compaction is, and only the explicit boolean proves it.
 *
 * ## Response shape, which was the original false lead
 *
 * The summariser goes through `generateText` — a NON-streaming call needing a single JSON
 * body. A stub that answers every request with SSE looks exactly like broken compaction
 * (`summarize_failed:provider_error`) when it is merely modelling half the API. Both call
 * styles are served here, as a real endpoint does.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import chatApp from "../../src/routes/chat";

const app = new Hono();
app.route("/", chatApp);

const JSON_HEADERS = { "Content-Type": "application/json" };
const PROVIDER_ID = "prov-compaction-invariant";
const MODEL_ID = "invariant-model";

/** Model attempts and summariser calls are different requests and counted apart. */
let attemptCalls = 0;
let summariserCalls = 0;
let controlled: ReturnType<typeof Bun.serve> | null = null;

const OVERFLOW_BODY = {
  error: {
    message:
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.",
    type: "invalid_request_error",
    code: "context_length_exceeded",
  },
};

function jsonError(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sse(rows: unknown[]): Response {
  return new Response(
    [...rows.map((r) => `data: ${JSON.stringify(r)}\n\n`), "data: [DONE]\n\n"].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

/** The non-streaming shape `generateText` requires. */
function jsonCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-inv",
      object: "chat.completion",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function wantsStream(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

type Behaviour = (kind: "attempt" | "summariser") => Response;

async function seed(behaviour: Behaviour): Promise<void> {
  attemptCalls = 0;
  summariserCalls = 0;
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = await req.text().catch(() => "");
      const streaming = wantsStream(raw);
      const kind: "attempt" | "summariser" = streaming ? "attempt" : "summariser";
      if (kind === "attempt") attemptCalls += 1;
      else summariserCalls += 1;
      return behaviour(kind);
    },
  });
  controlled.unref();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'compaction-invariant', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, `http://127.0.0.1:${controlled.port}/v1`, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
}

function longHistory(): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 12; i += 1) {
    messages.push({ id: `u${i}`, role: "user", parts: [{ type: "text", text: `question ${i} ${"detail ".repeat(40)}` }] });
    messages.push({
      id: `a${i}`,
      role: "assistant",
      parts: [{ type: "text", text: `answer ${i} ${"reply ".repeat(40)}`, state: "done" }],
    });
  }
  messages.push({ id: "live", role: "user", parts: [{ type: "text", text: "the current question" }] });
  return messages;
}

function shortHistory(): Array<Record<string, unknown>> {
  return [{ id: "live", role: "user", parts: [{ type: "text", text: "the current question" }] }];
}

function countChunks(sseText: string, type: string): number {
  let n = 0;
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      if (((JSON.parse(payload) as { type?: unknown }).type as string) === type) n += 1;
    } catch {
      /* keepalive */
    }
  }
  return n;
}

async function post(messages: Array<Record<string, unknown>>): Promise<string> {
  const conv = await conversationService.create({
    title: "compaction-invariant",
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
      body: JSON.stringify({ providerId: PROVIDER_ID, model: MODEL_ID, id: conv.id, messages }),
    });
    return await res.text();
  } finally {
    await conversationService.delete(conv.id);
  }
}

afterEach(() => {
  try {
    controlled?.stop(true);
  } catch {
    /* closed */
  }
  controlled = null;
});
afterAll(async () => {
  db.run("DELETE FROM provider_configs WHERE id = ?", [PROVIDER_ID]);
  await registry.loadFromDb(db);
});

describe("summariser invocation alone must NEVER authorise a retry", () => {
  it("a summariser that fails means no second model attempt", async () => {
    // The exact defect: the summariser IS called, it fails, and compaction does not
    // apply. A retry here would re-send the same oversized history to the same provider.
    await seed((kind) =>
      kind === "summariser"
        ? jsonError(500, { error: { message: "summariser unavailable" } })
        : jsonError(400, OVERFLOW_BODY),
    );
    const body = await post(longHistory());

    console.log("INVARIANT_FAIL", JSON.stringify({ attemptCalls, summariserCalls }));

    // The summariser really was invoked — so this test would pass vacuously if the
    // invariant were trivially satisfied by never compacting.
    expect(summariserCalls).toBeGreaterThan(0);
    // And yet there is no second attempt.
    expect(attemptCalls).toBe(1);
    // The ORIGINAL provider overflow is what the user is told, exactly once.
    expect(countChunks(body, "error")).toBe(1);
  }, 90000);

  it("nothing compactable means no summariser and no retry", async () => {
    await seed((kind) =>
      kind === "summariser" ? jsonCompletion("summary") : jsonError(400, OVERFLOW_BODY),
    );
    const body = await post(shortHistory());

    console.log("INVARIANT_NOTHING", JSON.stringify({ attemptCalls, summariserCalls }));

    // A single message has no span, so compaction is never attempted and nothing is
    // retried.
    expect(summariserCalls).toBe(0);
    expect(attemptCalls).toBe(1);
    expect(countChunks(body, "error")).toBe(1);
  }, 90000);
});

describe("the positive case: an APPLIED compaction does authorise the retry", () => {
  it("compacts, then issues exactly one more model attempt", async () => {
    await seed((kind) => {
      if (kind === "summariser") return jsonCompletion("summary of the earlier turns");
      return attemptCalls === 1
        ? jsonError(400, OVERFLOW_BODY)
        : sse([
            {
              id: "chatcmpl-inv",
              object: "chat.completion.chunk",
              created: 0,
              model: MODEL_ID,
              choices: [{ index: 0, delta: { role: "assistant", content: "recovered" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 900, completion_tokens: 10, total_tokens: 910 },
            },
          ]);
    });
    const body = await post(longHistory());

    console.log("INVARIANT_OK", JSON.stringify({ attemptCalls, summariserCalls }));

    // This is the control for the two tests above: same overflow, but compaction really
    // applied, so the retry is authorised. Without it the invariant tests could pass for
    // the wrong reason.
    expect(summariserCalls).toBe(1);
    expect(attemptCalls).toBe(2);
    expect(countChunks(body, "error")).toBe(0);
    expect(body).toContain("recovered");
  }, 90000);
});