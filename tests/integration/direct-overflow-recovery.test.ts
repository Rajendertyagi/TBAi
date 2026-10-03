/**
 * PHASE A0 SPIKE — what reaches the client BEFORE a provider context overflow?
 *
 * ## Why this file exists
 *
 * Overflow recovery (compact → rebuild → retry once) can only be safe if the route has
 * not yet made an IRREVERSIBLE commitment to the client when the provider rejects.
 * That was never established; it was assumed. The plan for the recovery gate depends
 * entirely on the answer, so this measures it before any production code is written.
 *
 * If the provider's rejection arrives while the UI message stream has already emitted
 * only lifecycle markers, the gate can hold those few markers, compact, and stream the
 * retry as the one logical response. If ANY assistant-visible content has already been
 * emitted, a retry would produce two answers for one user turn, and the guarantee in
 * A6 is not achievable at this seam — which is a finding to report, not to engineer
 * around.
 *
 * ## Method
 *
 * Drives the REAL `POST /api/chat` against a local OpenAI-compatible stub that rejects
 * with provider-worded overflow prose — the same regex path `classifyError` uses
 * (`errors.ts`: "maximum context length"), at HTTP 400, which is how providers actually
 * report it. The ordered SSE chunk sequence is then recorded verbatim.
 *
 * DB isolation: `tests/setup.ts` (bunfig preload) redirects DATA_DIR to tmp.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import chatApp from "../../src/routes/chat";
import { classifyError } from "../../src/lib/errors";
import { isRecoverableOverflow } from "../../src/context/recovery";

const app = new Hono();
app.route("/", chatApp);

const JSON_HEADERS = { "Content-Type": "application/json" };
const PROVIDER_ID = "prov-overflow-spike";
const MODEL_ID = "overflow-model";

let upstreamCalls = 0;
let controlled: ReturnType<typeof Bun.serve> | null = null;

/**
 * Provider-worded overflow, HTTP 400.
 *
 * This is the real shape: providers report an oversized prompt as a 400 whose prose
 * names the context length. `CONTEXT_OVERFLOW_RE` is tested ahead of the 4xx/config
 * branch precisely so this classifies as `context_overflow` and not as "change your
 * provider".
 */
const OVERFLOW_BODY = {
  error: {
    message:
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.",
    type: "invalid_request_error",
    code: "context_length_exceeded",
  },
};

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function seedOverflowingProvider(): Promise<void> {
  upstreamCalls = 0;
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      await req.json().catch(() => ({}));
      upstreamCalls += 1;
      // Always overflow, for now: the spike is about what the client sees, not about
      // whether a retry would succeed.
      return errorResponse(400, OVERFLOW_BODY);
    },
  });
  controlled.unref();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'overflow-spike', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, `http://127.0.0.1:${controlled.port}/v1`, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
}

function stopProvider(): void {
  try {
    controlled?.stop(true);
  } catch {
    /* already closed */
  }
  controlled = null;
}

/** The ordered `type` of every chunk in an SSE body, `[DONE]` excluded. */
function chunkTypes(sseText: string): string[] {
  const types: string[] = [];
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { type?: unknown };
      if (typeof parsed.type === "string") types.push(parsed.type);
    } catch {
      /* non-JSON keepalive */
    }
  }
  return types;
}

/** Index of the first chunk that carries an error, or -1. */
function firstErrorIndex(types: readonly string[]): number {
  return types.indexOf("error");
}

/** Index of the first chunk that is model-visible to a user, or -1. */
function firstVisibleIndex(types: readonly string[]): number {
  const visible = new Set(["text-delta", "text", "reasoning-delta", "tool-input-delta", "tool-call"]);
  return types.findIndex((t) => visible.has(t));
}

/**
 * Chunk types that carry no model-visible content and may therefore be HELD by a
 * recovery gate and replayed, because a client that has seen only these has not been
 * told anything about the answer.
 */
const LIFECYCLE_ONLY = new Set(["data-tbai-progress", "start", "start-step", "message-metadata"]);

beforeEach(() => {
  upstreamCalls = 0;
});
afterEach(() => {
  stopProvider();
});
afterAll(async () => {
  db.run("DELETE FROM provider_configs WHERE id = ?", [PROVIDER_ID]);
  await registry.loadFromDb(db);
});

describe("SPIKE: the pre-overflow commitment boundary", () => {
  it("records the exact ordered chunk sequence a client receives before the error", async () => {
    await seedOverflowingProvider();
    const conv = await conversationService.create({
      title: "overflow-spike",
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
          messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }],
        }),
      });
      const body = await res.text();
      const types = chunkTypes(body);

      // The provider WAS called, so nothing here passes vacuously. This single-message

      // conversation has nothing compactable, so recovery runs, compaction declines, and the

      // RETRY is the attempt that fails: two calls, and no summariser call (nothing to

      // summarise). The chunk sequence above is unchanged by recovery, which is the point.

      expect(upstreamCalls).toBe(2);

      // ── THE SPIKE RESULT, pinned as a contract ──────────────────────────────
      //
      // Observed sequence at this commit:
      //   ["data-tbai-progress", "start", "error", "message-metadata"]
      //
      // Two lifecycle markers reach the client before the provider's rejection, and
      // NO assistant-visible content does. That is the fact the recovery gate rests
      // on: a gate may hold `data-tbai-progress` and `start` and replay them, because
      // a client that has seen only those has not been told anything about the answer.
      // If a future SDK emits content before the error, this assertion fails and the
      // recovery guarantee must be re-derived rather than assumed.
      expect(types).toEqual(["data-tbai-progress", "start", "error", "message-metadata"]);

      const errIndex = firstErrorIndex(types);
      expect(errIndex).toBeGreaterThanOrEqual(0);

      // Nothing model-visible may precede the rejection.
      const visibleIndex = firstVisibleIndex(types);
      expect(visibleIndex).toBe(-1);

      // Everything before the error is a replayable marker.
      for (const type of types.slice(0, errIndex)) {
        expect(LIFECYCLE_ONLY.has(type)).toBe(true);
      }

      // The eligibility rule the gate depends on, checked against the classifier the
      // route actually uses. `context_overflow` is matched on provider prose at a 400,
      // ahead of the generic 4xx branch — that ordering is why a 400 overflow is not
      // misreported as "change your provider".
      const asOverflow = classifyError(
        Object.assign(new Error(OVERFLOW_BODY.error.message), { status: 400 }),
      );
      expect(asOverflow.category).toBe("context_overflow");
      expect(isRecoverableOverflow(asOverflow.category)).toBe(true);

      // A large-payload rejection shares the 4xx family but is NOT a context problem:
      // it is one oversized part, which compacting a span may not fix. Because
      // eligibility requires exact equality with `context_overflow`, it cannot recover.
      const asTooLarge = classifyError(
        Object.assign(new Error("Request payload is too large for this endpoint"), { status: 413 }),
      );
      expect(asTooLarge.category).not.toBe("context_overflow");
      expect(isRecoverableOverflow(asTooLarge.category)).toBe(false);

      // `DIRECT_MAX_RETRIES` remains independent of overflow recovery: the retry above
      // came from the recovery gate's own bound of one, not from any generic retry
      // count. A THIRD call would mean the bound leaked, so the total is asserted
      // exactly rather than as "at least two".
      expect(upstreamCalls).toBe(2);
    } finally {
      await conversationService.delete(conv.id);
    }
  }, 60000);
});
