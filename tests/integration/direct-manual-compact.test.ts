/**
 * B — manual `/compact` on the Direct route, proven through the REAL `/api/chat`
 * production handler rather than the compaction modules.
 *
 * ## Why route-level
 *
 * Every claim below is about the command path as a user reaches it: was the
 * command intercepted, was a chat run created, did compaction actually apply, was
 * a checkpoint written, was a fake message persisted, and did the NEXT turn read
 * the compacted state. None of those are visible from inside `assembleContext`, so
 * none of them are asserted there.
 *
 * ## Counting the two kinds of provider request
 *
 * Inherited from the A1 harness and for the same reason — a manual compaction also
 * makes two DIFFERENT requests:
 *
 *   - a MODEL ATTEMPT — `streamText`, so `stream: true`;
 *   - a SUMMARISER call — `generateText`, non-streaming, so it needs a single JSON body.
 *
 * They are separated by request SHAPE, never by call index, and one endpoint serves
 * both — so the stub does too. For this suite the separation is also the headline
 * assertion: an intercepted `/compact` performs ONE upstream call (the summariser)
 * and ZERO model attempts.
 *
 * ## Persistence here is `conversation_compactions`
 *
 * The `messages` table is written by the client history adapter, so it is
 * legitimately empty for unattached route tests. Its emptiness here is therefore
 * never used as positive proof that no message was persisted; the proof that the
 * command created no run and no conversational artefact is `chatRuns.counts()` plus
 * the `chat_streams` row count, both of which this route genuinely owns.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import { compactionStore } from "../../src/services/compaction";
import { chatRuns } from "../../src/services/chat-runs";
import chatApp from "../../src/routes/chat";

const app = new Hono();
app.route("/", chatApp);

const JSON_HEADERS = { "Content-Type": "application/json" };
const PROVIDER_ID = "prov-b-compact";
const MODEL_ID = "compact-model";

let attemptCalls = 0;
let summariserCalls = 0;
/** Raw bodies of MODEL attempts only, for proving what context was actually sent. */
let attemptBodies: string[] = [];
let controlled: ReturnType<typeof Bun.serve> | null = null;

const SUMMARY_TEXT = "summary of the earlier turns";

function jsonCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-b",
      object: "chat.completion",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function jsonError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: "invalid_request_error" } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function sseText(content: string): Response {
  return new Response(
    [
      "data: " +
        JSON.stringify({
          id: "chatcmpl-b",
          object: "chat.completion.chunk",
          created: 0,
          model: MODEL_ID,
          choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
        }) +
        "\n\n",
      "data: " +
        JSON.stringify({
          id: "chatcmpl-b",
          object: "chat.completion.chunk",
          created: 0,
          model: MODEL_ID,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 900, completion_tokens: 10, total_tokens: 910 },
        }) +
        "\n\n",
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
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
  attemptBodies = [];
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = await req.text().catch(() => "");
      const kind: "attempt" | "summariser" = wantsStream(raw) ? "attempt" : "summariser";
      if (kind === "attempt") {
        attemptBodies.push(raw);
        attemptCalls += 1;
      } else {
        summariserCalls += 1;
      }
      return behaviour(kind, kind === "attempt" ? attemptCalls : summariserCalls);
    },
  });
  controlled.unref();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'b-compact', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, `http://127.0.0.1:${controlled.port}/v1`, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
}

function userMessage(id: string, text: string): Record<string, unknown> {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

/**
 * A transcript whose compactable span is comfortably larger than
 * `DEFAULT_COMPACTION_POLICY.maxSummaryTokens` (1500).
 *
 * The size is load-bearing rather than decorative: the planner refuses with
 * `summary_would_not_reclaim_enough` when the span is no bigger than the summary
 * replacing it, and the default tail retains 6 messages. A "reasonable looking"
 * short history would therefore be legitimately un-compactable, which is TEST 3's
 * case rather than TEST 2's.
 */
function wideHistory(turns = 12): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push(userMessage(`u${i}`, `question ${i} ${"detail ".repeat(200)}`));
    messages.push({
      id: `a${i}`,
      role: "assistant",
      parts: [{ type: "text", text: `answer ${i} ${"reply ".repeat(200)}`, state: "done" }],
    });
  }
  return messages;
}

/** One user message: there is no span, so nothing is compactable. */
function tinyHistory(): Array<Record<string, unknown>> {
  return [userMessage("only", "/compact")];
}

/** Every SSE `data:` payload of a given part type. */
function partsOfType(sseText: string, type: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (parsed.type === type) found.push(parsed);
    } catch {
      /* keepalive */
    }
  }
  return found;
}

/** The status part the command emits, or `undefined` if it emitted none. */
function compactStatus(sseText: string): Record<string, unknown> | undefined {
  const [part] = partsOfType(sseText, "data-tbai-compact");
  return part?.data as Record<string, unknown> | undefined;
}

function outcomeOf(sseText: string): string | undefined {
  return compactStatus(sseText)?.outcome as string | undefined;
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

/** Durable stream rows for a conversation — one per settled chat run. */
function streamRows(conversationId: string): number {
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM chat_streams WHERE conversation_id = ?",
    )
    .get(conversationId);
  return row?.n ?? 0;
}

const report = (label: string): void => {
  console.log(
    label,
    JSON.stringify({ attemptCalls, summariserCalls, upstream: attemptCalls + summariserCalls }),
  );
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

describe("B1/B2 — detection and interception", () => {
  it("TEST 1: exact `/compact` is intercepted and never becomes a model attempt", async () => {
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("should not happen")));
    const id = await newConversation("b1-exact");
    try {
      const body = await post(id, [...wideHistory(), userMessage("cmd", "/compact")]);
      report("B_TEST_1");

      // THE interception proof: zero streaming model attempts reached the provider.
      // The only upstream call is the summariser, which is not a chat model call.
      expect(attemptCalls).toBe(0);
      expect(summariserCalls).toBe(1);
      // And the command text itself was never sent as a prompt.
      expect(body).not.toContain("should not happen");
      expect(outcomeOf(body)).toBe("compacted");
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);

  it("surrounding whitespace is tolerated and the outcome is unchanged", async () => {
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("should not happen")));
    const id = await newConversation("b1-whitespace");
    try {
      const body = await post(id, [...wideHistory(), userMessage("cmd", "   /compact   ")]);
      report("B_WHITESPACE");

      expect(attemptCalls).toBe(0);
      expect(outcomeOf(body)).toBe("compacted");
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);

  it("TEST 7: the command creates NO chat run and NO durable stream row", async () => {
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("unused")));
    const id = await newConversation("b-run-lifecycle");
    try {
      const before = chatRuns.counts();
      const body = await post(id, [...wideHistory(), userMessage("cmd", "/compact")]);
      const after = chatRuns.counts();
      report("B_RUN_LIFECYCLE");

      // No run was created, so nothing can be left running or orphaned. This is
      // the assertion that fails if the intercept is ever moved below
      // `chatRuns.create`.
      expect(after).toEqual(before);
      expect(chatRuns.counts().running).toBe(0);
      expect(streamRows(id)).toBe(0);
      // And the response carried the status part, so it was genuinely served.
      expect(outcomeOf(body)).toBe("compacted");
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);
});

describe("B3/B4/B5/B7 — compaction, outcomes and durability", () => {
  it("TEST 2: success applies real compaction, writes a checkpoint, and emits no message part", async () => {
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("unused")));
    const id = await newConversation("b2-success");
    try {
      expect(compactionStore.has(id)).toBe(false);
      const body = await post(id, [...wideHistory(), userMessage("cmd", "/compact")]);
      report("B_TEST_2");

      const status = compactStatus(body);
      expect(status?.outcome).toBe("compacted");
      // The RAW report reason on success is `compacted`; `applied` is the
      // budget-gate's mechanism vocabulary for the same fact. Both are carried, so
      // neither is invented by this command.
      expect(status?.reason).toBe("compacted");
      expect(status?.mechanism).toEqual({ kind: "exhausted", reason: "applied" });
      expect(status?.generation).toBe(1);
      expect(status?.spanLength).toBeGreaterThan(0);
      expect(status?.reclaimedTokens).toBeGreaterThan(0);

      // Durable checkpoint, readable back through the same store the seam wrote.
      expect(compactionStore.has(id)).toBe(true);
      const record = compactionStore.get(id);
      expect(record?.summaryText).toContain(SUMMARY_TEXT);
      expect(record?.generation).toBe(1);

      // NO conversational artefact: no message part of any kind, only the status.
      expect(partsOfType(body, "start")).toHaveLength(0);
      expect(partsOfType(body, "text")).toHaveLength(0);
      expect(partsOfType(body, "data-tbai-progress")).toHaveLength(0);
      const rows = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?",
        )
        .get(id);
      expect(rows?.n ?? 0).toBe(0);
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);

  it("TEST 3: nothing compactable is `skipped` and fabricates no checkpoint", async () => {
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("unused")));
    const id = await newConversation("b3-noop");
    try {
      const body = await post(id, tinyHistory());
      report("B_TEST_3");

      // No summariser call: the planner never found a span.
      expect(summariserCalls).toBe(0);
      expect(attemptCalls).toBe(0);
      expect(outcomeOf(body)).toBe("skipped");
      // The raw reason is preserved rather than flattened to the outcome label.
      expect(String(compactStatus(body)?.reason)).toMatch(
        /no_compactable_span|span_too_small_to_compact|force_requested_no_compactable_span/,
      );
      // No fabricated checkpoint.
      expect(compactionStore.has(id)).toBe(false);
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);

  it("TEST 4: a summariser failure is `failed` with no false success and no dangling state", async () => {
    await seed((kind) =>
      kind === "summariser"
        ? jsonError(500, "summariser backend unavailable")
        : sseText("unused"),
    );
    const id = await newConversation("b4-summariser-failure");
    try {
      const body = await post(id, [...wideHistory(), userMessage("cmd", "/compact")]);
      report("B_TEST_4");

      expect(outcomeOf(body)).toBe("failed");
      expect(String(compactStatus(body)?.reason)).toMatch(/^summarize_failed/);
      // The invariant under test: a summariser that RAN is not a compaction.
      expect(compactStatus(body)?.outcome).not.toBe("compacted");
      expect(summariserCalls).toBeGreaterThan(0);
      // No retry, no checkpoint, no model attempt, no run.
      expect(attemptCalls).toBe(0);
      expect(compactionStore.has(id)).toBe(false);
      expect(streamRows(id)).toBe(0);
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);
});

describe("B1 — command safety", () => {
  it("TEST 5: text merely CONTAINING `/compact` is ordinary model input", async () => {
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("model answered")));
    const id = await newConversation("b5-safety");
    try {
      for (const text of ["/compact now", "please run /compact", "explain /compact"]) {
        const body = await post(id, [...wideHistory(), userMessage(`cmd-${text.length}`, text)]);
        report(`B_SAFETY_${JSON.stringify(text)}`);

        // Executed as a normal turn: one model attempt, no summariser, no status part.
        expect(attemptCalls).toBe(1);
        expect(summariserCalls).toBe(0);
        expect(compactStatus(body)).toBeUndefined();
        expect(body).toContain("model answered");
        attemptCalls = 0;
      }
      // No compaction happened at any point, so nothing was persisted.
      expect(compactionStore.has(id)).toBe(false);
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);

  it("a `/compact` quoted in an assistant message cannot trigger the command", async () => {
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("model answered")));
    const id = await newConversation("b5-assistant-quote");
    try {
      const body = await post(id, [
        ...wideHistory(),
        {
          id: "quoted",
          role: "assistant",
          parts: [{ type: "text", text: "/compact", state: "done" }],
        },
        userMessage("followup", "carry on"),
      ]);
      report("B_ASSISTANT_QUOTE");

      expect(attemptCalls).toBe(1);
      expect(summariserCalls).toBe(0);
      expect(compactStatus(body)).toBeUndefined();
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);
});

describe("B8 — the next turn consumes compacted context", () => {
  it("TEST 6: after a successful compact the follow-up turn reads the summary, not the old span", async () => {
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("follow-up answer")));
    const id = await newConversation("b6-next-turn");
    try {
      const compactBody = await post(id, [...wideHistory(), userMessage("cmd", "/compact")]);
      expect(outcomeOf(compactBody)).toBe("compacted");
      expect(compactionStore.has(id)).toBe(true);
      expect(attemptBodies).toHaveLength(0);

      // The follow-up turn, as the real client produces it. The command emitted NO
      // user message and NO assistant message, so the transcript the client holds is
      // the original history plus the new question — there is no `/compact` bubble
      // to re-post. Its last user message is not the command, so detection correctly
      // leaves it alone and the ordinary path runs.
      const nextBody = await post(id, [
        ...wideHistory(),
        userMessage("followup", "and what did we decide?"),
      ]);
      report("B_TEST_6");

      expect(attemptCalls).toBe(1);
      expect(nextBody).toContain("follow-up answer");
      expect(attemptBodies).toHaveLength(1);

      // The decisive assertions — about what the provider was ACTUALLY sent.
      //
      // 1. The durable checkpoint is consumed, identified by its own generation.
      //    Without this marker the turn was assembled from raw history and the
      //    command was a no-op that merely looked like success.
      const sent = attemptBodies[0] ?? "";
      expect(sent).toContain("generation 1");
      // 2. The summary is present and attributed as a summary.
      expect(sent).toContain(SUMMARY_TEXT);
      expect(sent).toContain("model_generated_summary");
      // 3. The reduction is real and quantified, not asserted by a boolean.
      expect(sent).toContain("19 earlier message(s) summarized");
      // 4. The new turn survives compaction. A summary that swallowed the question
      //    would satisfy 1-3 and still be a broken turn.
      expect(sent).toContain("and what did we decide?");
      // 5. Strictly fewer messages than were submitted — pre-compaction history was
      //    replaced, not merely annotated.
      const wire = JSON.parse(sent || "{}") as { messages?: unknown[] };
      expect((wire.messages ?? []).length).toBeLessThan(wideHistory().length + 1);
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);
});
