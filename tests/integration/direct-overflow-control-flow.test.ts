/**
 * PHASE 3D — runtime control-flow proof for provider-overflow recovery.
 *
 * Drives the REAL `POST /api/chat` with a programmable local provider: attempt 1 is
 * rejected as a context overflow, attempt 2 answers normally. The point is to observe
 * the whole chain rather than infer it, because two previous attempts at this wiring
 * failed for reasons that were both misdiagnosed.
 *
 * The conversation is seeded with enough history for a span to exist, because a
 * single-message conversation has nothing compactable and would prove only the
 * nothing-to-compact path.
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
const PROVIDER_ID = "prov-recovery-proof";
const MODEL_ID = "recovery-model";

let upstreamCalls = 0;
let controlled: ReturnType<typeof Bun.serve> | null = null;

const OVERFLOW_BODY = {
  error: {
    message:
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.",
    type: "invalid_request_error",
    code: "context_length_exceeded",
  },
};

function sse(rows: unknown[]): Response {
  return new Response(
    [...rows.map((r) => `data: ${JSON.stringify(r)}\n\n`), "data: [DONE]\n\n"].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

/**
 * A NON-streaming completion, as `generateText` requires.
 *
 * The stub originally answered every request with SSE. That models only half of the
 * provider contract: `streamText` asks for `stream: true` and expects `text/event-stream`,
 * but the compaction summariser goes through `generateText`, which asks for a single JSON
 * body. Handing an SDK non-streaming client an SSE stream is a malformed response, and it
 * surfaced as `summarize_failed:provider_error` — which looked like broken compaction but
 * was the stub lying about the API.
 *
 * A real endpoint serves both shapes on the same URL, so the stub now does too.
 */
function jsonCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-recovery",
      object: "chat.completion",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

/** Whether a request asked for a streamed response. */
function wantsStream(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

function textChunk(content: string, finish: string): unknown {
  return {
    id: "chatcmpl-recovery",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }],
    usage: { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 },
  };
}

/** attempt 1 overflows; every later attempt answers. */
async function seed(): Promise<void> {
  upstreamCalls = 0;
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = await req.text().catch(() => "");
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return new Response(JSON.stringify(OVERFLOW_BODY), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      // The compaction summariser is a NON-streaming call; the retried model turn is a
      // streaming one. Serving the right shape for each is what a real endpoint does.
      if (!wantsStream(raw)) return jsonCompletion("summary of the earlier turns");
      return sse([textChunk("recovered answer", "stop")]);
    },
  });
  controlled.unref();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'recovery-proof', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, `http://127.0.0.1:${controlled.port}/v1`, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
}

/** A conversation with real history, so a compactable span exists. */
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

describe("CONTROL FLOW: overflow → compact → rebuild → retry", () => {
  it("issues a second provider attempt and streams only the recovered answer", async () => {
    await seed();
    const conv = await conversationService.create({
      title: "recovery-proof",
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
          messages: longHistory(),
        }),
      });
      const body = await res.text();

      console.log(
        "RECOVERY_PROOF",
        JSON.stringify({
          upstreamCalls,
          errorChunks: countChunks(body, "error"),
          textChunks: countChunks(body, "text-delta"),
          startChunks: countChunks(body, "start"),
          hasRecoveredText: body.includes("recovered answer"),
        }),
      );

      // THREE upstream calls, and the count is itself the proof:
      //   1. attempt #1  — rejected as a context overflow
      //   2. the compaction SUMMARISER — recovery compacts through the same model, by
      //      design, so summarising is a real provider call
      //   3. attempt #2  — the retry, which answers
      //
      // A fourth call would mean a second recovery, which the gate must never permit.
      expect(upstreamCalls).toBe(3);
      // Exactly one logical response: one `start`, no terminal error from the discarded
      // attempt, and the recovered answer present.
      expect(countChunks(body, "start")).toBe(1);
      expect(countChunks(body, "error")).toBe(0);
      expect(body).toContain("recovered answer");
    } finally {
      await conversationService.delete(conv.id);
    }
  }, 90000);
});
