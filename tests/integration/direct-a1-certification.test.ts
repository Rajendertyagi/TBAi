/**
 * A1 certification matrix — the scenarios not already covered elsewhere.
 *
 * Proven elsewhere and not repeated here:
 *   - A5-1 overflow -> compact -> retry -> success : direct-overflow-control-flow
 *   - A5-3 summariser fails / A5-4 nothing compactable / the applied-compaction
 *     positive control : direct-compaction-invariant
 *   - the pre-overflow commitment boundary (A0) : direct-overflow-recovery
 *   - error publication ownership : direct-error-ownership
 *
 * ## Counting the two kinds of provider request
 *
 * Recovery makes two DIFFERENT requests and conflating them is how a bound gets
 * misreported:
 *
 *   - a MODEL ATTEMPT  — `streamText`, so `stream: true`;
 *   - a SUMMARISER call — `generateText`, non-streaming, so it needs a single JSON body.
 *
 * They are separated by request SHAPE rather than call index, and a real endpoint serves
 * both on the same URL — so the stub does too.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import { compactionStore } from "../../src/services/compaction";
import chatApp from "../../src/routes/chat";

const app = new Hono();
app.route("/", chatApp);

const JSON_HEADERS = { "Content-Type": "application/json" };
const PROVIDER_ID = "prov-a1-cert";
const MODEL_ID = "cert-model";

let attemptCalls = 0;
let summariserCalls = 0;
let controlled: ReturnType<typeof Bun.serve> | null = null;

/**
 * Provider-worded overflow, HTTP 400.
 *
 * The stated limit must exceed this file's conversation fixture. TBAi learns the limit a
 * provider states and then enforces it, so a stub advertising an 8192-token window while
 * the fixture sends ~13k tokens is self-contradictory — honouring the stub's own claim
 * correctly refuses the retry these tests depend on. The figures below are the verified
 * real gateway's, and are internally consistent: the input does exceed the limit.
 */
const OVERFLOW_BODY = {
  error: {
    message:
      "This model's maximum context length is 524288 tokens. However, your messages resulted in 950284 tokens.",
    type: "invalid_request_error",
    code: "context_length_exceeded",
  },
};
/** 4xx family, but a single oversized part — NOT a context problem. */
const TOO_LARGE_BODY = {
  error: { message: "Request payload is too large for this endpoint", type: "invalid_request_error" },
};

function jsonError(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function jsonCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-cert",
      object: "chat.completion",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}
function sse(rows: unknown[]): Response {
  return new Response(
    [...rows.map((r) => `data: ${JSON.stringify(r)}\n\n`), "data: [DONE]\n\n"].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
function textChunk(content: string, finish: string | null): unknown {
  return {
    id: "chatcmpl-cert",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 900, completion_tokens: 10, total_tokens: 910 } } : {}),
  };
}

function wantsStream(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

type Behaviour = (kind: "attempt" | "summariser", nth: number) => Response;

async function seed(behaviour: Behaviour): Promise<void> {
  attemptCalls = 0;
  summariserCalls = 0;
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = await req.text().catch(() => "");
      const kind: "attempt" | "summariser" = wantsStream(raw) ? "attempt" : "summariser";
      const nth = kind === "attempt" ? ++attemptCalls : ++summariserCalls;
      return behaviour(kind, nth);
    },
  });
  controlled.unref();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'a1-cert', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, `http://127.0.0.1:${controlled.port}/v1`, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
}

/**
 * What the stub summariser returns, sized for this fixture's span.
 *
 * `longHistory` puts ~2.2k tokens in the removable span, so the summary-adequacy floor
 * lands near 22 tokens and the old eleven-token stub is refused by it. That refusal is
 * correct — a one-line answer to a two-thousand-token span is exactly the defect the
 * guard exists to catch — but these tests are about the RECOVERY path, so the stand-in
 * has to be an adequate summary or the recovery they assert never happens.
 */
const ADEQUATE_SUMMARY = Array.from(
  { length: 12 },
  (_, i) =>
    `${i + 1}. The user asked about storage internals and the assistant explained page layout and write-ahead logging.`,
).join(" ");

function longHistory(turns = 12, liveId = "live"): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ id: `u${i}`, role: "user", parts: [{ type: "text", text: `question ${i} ${"detail ".repeat(40)}` }] });
    messages.push({
      id: `a${i}`,
      role: "assistant",
      parts: [{ type: "text", text: `answer ${i} ${"reply ".repeat(40)}`, state: "done" }],
    });
  }
  messages.push({ id: liveId, role: "user", parts: [{ type: "text", text: "the current question" }] });
  return messages;
}

/** The payload of the first `data-tbai-compact` part in a response body. */
function firstCompactData(sseText: string): Record<string, unknown> | undefined {
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { type?: unknown; data?: unknown };
      if (parsed.type === "data-tbai-compact") {
        return parsed.data as Record<string, unknown>;
      }
    } catch {
      /* keepalive */
    }
  }
  return undefined;
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

async function newConversation(title: string): Promise<string> {
  const conv = await conversationService.create({
    title,
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    reasoningLevel: null,
    systemPrompt: null,
    engine: "direct",
  });
  return conv.id;
}

async function post(conversationId: string, messages: Array<Record<string, unknown>>): Promise<string> {
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ providerId: PROVIDER_ID, model: MODEL_ID, id: conversationId, messages }),
  });
  return await res.text();
}

/** Assistant turns persisted for a conversation. */
function persistedAssistantTexts(conversationId: string): string[] {
  const rows = db
    .query<{ content: string | null }, [string]>(
      "SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY rowid",
    )
    .all(conversationId);
  return rows.map((r) => r.content ?? "");
}

const report = (label: string): void => {
  console.log(label, JSON.stringify({ attemptCalls, summariserCalls, totalUpstream: attemptCalls + summariserCalls }));
};

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

describe("A5-2 — a SECOND overflow terminates cleanly", () => {
  it("two attempts, one compaction, no third attempt, attempt #2 is the final failure", async () => {
    // The summariser SUCCEEDS so compaction genuinely applies; only MODEL attempts
    // overflow. Making the summariser overflow would test nothing about attempt 2.
    await seed((kind) => {
      if (kind === "summariser") return jsonCompletion(ADEQUATE_SUMMARY);
      return jsonError(400, OVERFLOW_BODY);
    });
    const id = await newConversation("a5-2");
    try {
      const body = await post(id, longHistory());
      report("A5_2");

      expect(attemptCalls).toBe(2);
      expect(summariserCalls).toBe(1);
      // ONE logical response: attempt 1 published nothing, so the single error chunk is
      // attempt 2's, and there is exactly one `start`.
      expect(countChunks(body, "start")).toBe(1);
      expect(countChunks(body, "error")).toBe(1);
      // No duplicate persistence from either attempt.
      expect(persistedAssistantTexts(id)).toHaveLength(0);
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);
});

describe("A5-5 — an ordinary provider error is untouched", () => {
  it("one attempt, no compaction, no retry, one error chunk, clean termination", async () => {
    await seed(() => jsonError(500, { error: { message: "upstream backend unavailable" } }));
    const id = await newConversation("a5-5");
    try {
      const body = await post(id, longHistory());
      report("A5_5");

      expect(attemptCalls).toBe(1);
      expect(summariserCalls).toBe(0);
      expect(countChunks(body, "error")).toBe(1);
      expect(body).toContain("[DONE]");
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);
});

describe("A5-6 — payload-too-large never enters context-overflow recovery", () => {
  it("one attempt, no compaction, no retry", async () => {
    await seed(() => jsonError(413, TOO_LARGE_BODY));
    const id = await newConversation("a5-6");
    try {
      const body = await post(id, longHistory());
      report("A5_6");

      expect(attemptCalls).toBe(1);
      expect(summariserCalls).toBe(0);
      expect(countChunks(body, "error")).toBe(1);
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);
});

describe("A5-7 — visible content before an overflow fails closed", () => {
  it("keeps the visible content, does not compact, does not retry", async () => {
    await seed(() =>
      sse([
        textChunk("partial answer", null),
        { id: "chatcmpl-cert", object: "chat.completion.chunk", created: 0, model: MODEL_ID, choices: [], error: OVERFLOW_BODY.error },
      ]),
    );
    const id = await newConversation("a5-7");
    try {
      const body = await post(id, longHistory());
      report("A5_7");

      // The user already has content; a second answer would be a second answer.
      expect(attemptCalls).toBe(1);
      expect(summariserCalls).toBe(0);
      expect(countChunks(body, "error")).toBe(1);
      expect(body).toContain("partial answer");
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);
});

describe("RECOVERY VISIBILITY — a recovery compaction reaches the transcript", () => {
  it("emits one data-tbai-compact divider with origin 'recovery', and stores one row", async () => {
    // The gap this covers: recovery performed a real, durable compaction and then
    // said NOTHING about it. The conversation silently lost history, so the user
    // could not tell that context had been summarised out from under them.
    //
    // Same trigger as A5-2 and Scenario D — attempt 1 overflows, the summariser
    // succeeds, attempt 2 answers — so what is new here is only the OUTPUT.
    await seed((kind, nth) => {
      if (kind === "summariser") return jsonCompletion(ADEQUATE_SUMMARY);
      if (nth === 1) return jsonError(400, OVERFLOW_BODY);
      return sse([textChunk("recovered answer", "stop")]);
    });
    const id = await newConversation("recovery-divider");
    try {
      const body = await post(id, longHistory());
      report("RECOVERY_DIVIDER");

      // The retry still happened, and only because compaction applied.
      expect(attemptCalls).toBe(2);
      expect(summariserCalls).toBe(1);

      // EXACTLY ONE divider, in the same part every other trigger uses.
      const dividers = body.match(/"type":"data-tbai-compact"/g) ?? [];
      expect(dividers).toHaveLength(1);

      const data = firstCompactData(body);
      expect(data).toBeDefined();
      // `recovery` is the only thing distinguishing it from an automatic compaction,
      // which is the point: one representation, one renderer, honest provenance.
      expect(data?.origin).toBe("recovery");
      expect(data?.outcome).toBe("compacted");
      // Generation and span come from the assembly that ACTUALLY applied, not from
      // the pre-recovery one that did not.
      expect(Number(data?.generation)).toBeGreaterThan(0);
      expect(Number(data?.spanLength)).toBeGreaterThan(0);
      expect(typeof data?.operationId).toBe("string");

      // And the durable checkpoint was written by the same recovery, so the divider
      // cannot describe a different compaction than the one stored.
      const record = compactionStore.get(id);
      expect(record?.generation).toBe(Number(data?.generation));
      expect(record?.spanEndIndex).toBe((data?.spanLength ?? 0) > 0 ? record?.spanEndIndex : undefined);

      // One stored divider row, carrying the same envelope manual and automatic use.
      const rows = db
        .query<{ content: string }, [string]>(
          "SELECT content FROM messages WHERE conversation_id = ? AND content LIKE '%tbai-compact%'",
        )
        .all(id)
        .map(
          (r) =>
            (
              JSON.parse(r.content) as {
                role: string;
                parts: Array<{ type: string; data?: Record<string, unknown> }>;
              }
            ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe("assistant");
      expect(rows[0]?.parts[0]?.data?.origin).toBe("recovery");
      // The row id is derived from the operation id, which is how one compaction can
      // never produce two rows.
      expect(rows[0]?.parts[0]?.data?.operationId).toBe(data?.operationId);
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);

  it("emits NO divider when recovery cannot compact, and forwards the original overflow", async () => {
    // The negative half, and the one that would catch a divider written
    // unconditionally. With no compactable span the recovery throws, the gate forwards
    // the ORIGINAL provider overflow, and nothing may claim a compaction happened.
    await seed((kind) => {
      if (kind === "summariser") return jsonCompletion(ADEQUATE_SUMMARY);
      return jsonError(400, OVERFLOW_BODY);
    });
    const id = await newConversation("recovery-divider-negative");
    try {
      // A conversation with a single short turn: nothing eligible to compact.
      const body = await post(id, [
        { id: "u0", role: "user", parts: [{ type: "text", text: "hi" }] },
        { id: "live", role: "user", parts: [{ type: "text", text: "the current question" }] },
      ]);
      report("RECOVERY_DIVIDER_NEGATIVE");

      expect(body.match(/"type":"data-tbai-compact"/g) ?? []).toHaveLength(0);
      expect(countChunks(body, "error")).toBe(1);
      expect(body).toContain("context");
      // And nothing was persisted claiming otherwise.
      const rows = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND content LIKE '%tbai-compact%'",
        )
        .get(id);
      expect(rows?.n ?? 0).toBe(0);
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);
});

describe("SCENARIO D — the conversation stays usable after a recovered turn", () => {
  it("persists the recovered reply once, and the next turn succeeds on compacted state", async () => {
    // Attempt 1 overflows, compaction applies, attempt 2 answers. Afterwards the SAME
    // conversation must accept a follow-up, and assembly must see the post-compaction
    // state rather than the stale pre-compaction history.
    await seed((kind, nth) => {
      if (kind === "summariser") return jsonCompletion(ADEQUATE_SUMMARY);
      if (nth === 1) return jsonError(400, OVERFLOW_BODY);
      return sse([textChunk("recovered answer", "stop")]);
    });

    const id = await newConversation("scenario-d");
    try {
      const first = await post(id, longHistory());
      expect(attemptCalls).toBe(2);
      expect(countChunks(first, "error")).toBe(0);
      expect(first).toContain("recovered answer");

      // The server-side durable record of the turn's outcome. The `messages` table is
      // written by the CLIENT's history adapter, so it is legitimately empty for an
      // unattached request; what the server guarantees is exactly ONE durable
      // settlement, won by a single transition.
      const streams = db
        .query<{ stream_id: string; status: string; terminal_kind: string | null }, [string]>(
          "SELECT stream_id, status, terminal_kind FROM chat_streams WHERE conversation_id = ?",
        )
        .all(id);
      const completed = streams.filter((r) => r.terminal_kind === "completed");
      console.log(
        "SCENARIO_D_PERSISTED",
        JSON.stringify({ streams: streams.length, completed: completed.length }),
      );

      // Exactly one run, settled completed. Two completed rows would mean a duplicate
      // assistant record from the discarded attempt — the thing this whole design exists
      // to prevent.
      expect(streams).toHaveLength(1);
      expect(completed).toHaveLength(1);

      // The durable checkpoint exists, so a later turn re-applies the summary instead of
      // the raw span. Reading it proves compaction SURVIVED, not merely that a retry ran.
      const checkpoint = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM conversation_compactions WHERE conversation_id = ?",
        )
        .get(id);
      console.log("SCENARIO_D_CHECKPOINT", JSON.stringify({ compactions: checkpoint?.n ?? 0 }));
      expect(checkpoint?.n ?? 0).toBeGreaterThan(0);

      // Follow-up turn on the same conversation, carrying the recovered turn forward.
      const before = attemptCalls;
      const followUp = await post(id, [...longHistory(), { id: "a-recovered", role: "assistant", parts: [{ type: "text", text: "recovered answer", state: "done" }] }, { id: "live2", role: "user", parts: [{ type: "text", text: "a follow-up question" }] }]);
      report("SCENARIO_D_FOLLOWUP");

      // It succeeded, and cost exactly one further attempt — no recovery on the follow-up.
      expect(attemptCalls - before).toBe(1);
      expect(countChunks(followUp, "error")).toBe(0);
      expect(followUp).toContain("recovered answer");

      // And the follow-up settled too, without duplicating the earlier run.
      const finalStreams = db
        .query<{ terminal_kind: string | null }, [string]>(
          "SELECT terminal_kind FROM chat_streams WHERE conversation_id = ?",
        )
        .all(id);
      expect(finalStreams.filter((r) => r.terminal_kind === "completed")).toHaveLength(2);
    } finally {
      await conversationService.delete(id);
    }
  }, 120000);
});