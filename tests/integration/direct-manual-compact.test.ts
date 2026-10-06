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
/** Raw bodies of SUMMARISER calls, so the prompt the engine actually built is assertable. */
let summariserBodies: string[] = [];
let controlled: ReturnType<typeof Bun.serve> | null = null;

/**
 * What the stub summariser returns.
 *
 * Sized deliberately. `wideHistory` puts ~10.5k tokens in the removable span, so the
 * summary-adequacy floor lands near 106 tokens, and an eleven-token stub is refused by
 * it. That refusal is correct — a one-line response to a ten-thousand-token span is
 * the defect the guard exists to catch — but these tests are about the ROUTE, so the
 * stand-in has to be an adequate summary or nothing downstream is exercised.
 *
 * Built rather than typed so its length stays a fact about the fixture instead of a
 * magic literal, and asserted through this constant everywhere below.
 */
const SUMMARY_TEXT = Array.from(
  { length: 12 },
  (_, i) =>
    `${i + 1}. The user asked about storage internals and the assistant explained page layout and write-ahead logging.`,
).join(" ");

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
  summariserBodies = [];
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
        summariserBodies.push(raw);
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

      // NO conversational artefact in the RESPONSE: the stream still carries the
      // status part and nothing else — no run, no text, no assistant reply.
      expect(partsOfType(body, "start")).toHaveLength(0);
      expect(partsOfType(body, "text")).toHaveLength(0);
      expect(partsOfType(body, "data-tbai-progress")).toHaveLength(0);

      // Exactly ONE stored row, and it is the transcript divider — not a message.
      //
      // The command's durable artefact is a labelled separator in the transcript,
      // so there is now a row. What must NOT exist is a conversational one: a
      // `/compact` user bubble, a fake assistant reply, or an empty row. A divider
      // alone is what makes the outcome survive a reload, which is the whole point
      // of the feature.
      const rows = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?",
        )
        .get(id);
      expect(rows?.n ?? 0).toBe(1);

      const stored = db
        .query<{ content: string }, [string]>(
          "SELECT content FROM messages WHERE conversation_id = ?",
        )
        .all(id)
        .map(
          (r) =>
            JSON.parse(r.content) as {
              role: string;
              parts: Array<{ type: string; data?: Record<string, unknown> }>;
            },
        );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.role).toBe("assistant");
      expect(stored[0]?.parts).toHaveLength(1);
      expect(stored[0]?.parts[0]?.type).toBe("data-tbai-compact");

      // The client is told the row's id, so "durable" is a checkable fact rather
      // than an assumption.
      expect(status?.anchorMessageId).toBe(
        db
          .query<{ id: string }, [string]>(
            "SELECT id FROM messages WHERE conversation_id = ?",
          )
          .get(id)?.id,
      );

      // The summary reaches BOTH the live status part and the durable row, so what
      // the user reads on screen is what a reload replays. Asserted on both, because
      // they are written by different code and a summary present in only one of them
      // is a divider that lies after a refresh.
      expect(status?.summary).toContain(SUMMARY_TEXT);
      const dividerData = stored[0]?.parts[0]?.data;
      expect(dividerData?.summary).toContain(SUMMARY_TEXT);
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

      // No summary either — not an empty one, not a stale one. A compaction that
      // replaced nothing has nothing to report, and a divider offering to reveal a
      // summary here would be describing history that is still fully present.
      expect(compactStatus(body)?.summary ?? null).toBeNull();
      const dividerRow = db
        .query<{ content: string }, [string]>(
          "SELECT content FROM messages WHERE conversation_id = ? AND content LIKE '%tbai-compact%'",
        )
        .all(id)
        .map(
          (r) =>
            (
              JSON.parse(r.content) as {
                parts: Array<{ data?: Record<string, unknown> }>;
              }
            ).parts[0]?.data ?? {},
        );
      for (const data of dividerRow) {
        expect(data).not.toHaveProperty("summary");
      }
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);
});

describe("B1 — command safety", () => {
  it("TEST 5: text that merely MENTIONS `/compact` is ordinary model input", async () => {
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("model answered")));
    const id = await newConversation("b5-safety");
    try {
      // `/compact now` is deliberately absent: since `/compact <instructions>` landed,
      // it is the command with the instruction "now", not a sentence. It used to be
      // in this list, and its removal is the behaviour change this asserts.
      for (const text of ["please run /compact", "explain /compact", "what does /compress do"]) {
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

// ── Automatic compaction ────────────────────────────────────────────────────
//
// The engine compacts on its own when a conversation's real occupancy crosses
// `DEFAULT_COMPACTION_POLICY.triggerFraction` of the RESOLVED limit. Reaching that
// with a 128k default window is not something a test can type, so the provider's
// model declares a small `contextWindow` — which is a real, supported
// configuration for a genuinely small-window model. Nothing about the trigger is
// stubbed: the same `assembleContext`, the same threshold, the same engine.
//
// What is asserted is the thing that had no output channel at all before: that the
// engine's own compaction reaches the transcript, as the SAME part and the SAME
// stored row a manual one produces, labelled as automatic.

/** Re-register the provider with a model that declares a small real window. */
async function seedWithWindow(behaviour: Behaviour, contextWindow: number): Promise<void> {
  await seed(behaviour);
  const models = JSON.stringify([
    { id: MODEL_ID, label: MODEL_ID, provider: "ollama", contextWindow, contextWindowSource: "configured", maxOutputTokens: 512, maxOutputTokensSource: "configured" },
  ]);
  db.run(
    `UPDATE provider_configs SET models = ? WHERE id = ?`,
    [models, PROVIDER_ID],
  );
  await registry.loadFromDb(db);
}

describe("AUTOMATIC — the engine's own compaction reaches the transcript", () => {
  it("streams the divider inside the turn that compacted, and stores the row", async () => {
    // 8k window, safety margin and output reservation applied, triggers at 80%.
    // `wideHistory` is comfortably past that, so the ONLY reason to compact is the
    // engine's own occupancy judgement.
    await seedWithWindow(
      (kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("answered")),
      24_000,
    );
    const id = await newConversation("auto-compaction");
    try {
      const body = await post(id, wideHistory());

      // The part is in the response, inside this turn's assistant message.
      const parts = partsOfType(body, "data-tbai-compact");
      expect(parts).toHaveLength(1);
      const data = (parts[0]?.data ?? {}) as Record<string, unknown>;
      expect(data.kind).toBe("tbai-compact");
      expect(data.outcome).toBe("compacted");
      // The one field that distinguishes it from a user-pressed compaction.
      expect(data.origin).toBe("automatic");
      expect(Number(data.generation)).toBeGreaterThan(0);

      // The summariser actually ran: this is not a fabricated divider.
      expect(summariserCalls).toBeGreaterThan(0);

      // And the durable row exists, in the same envelope a manual one uses.
      const rows = db
        .query<{ content: string }, [string]>(
          "SELECT content FROM messages WHERE conversation_id = ? ORDER BY order_seq",
        )
        .all(id)
        .map((r) => JSON.parse(r.content) as { role: string; parts: Array<{ type: string; data?: Record<string, unknown> }> });
      const divider = rows.find(
        (r) => r.parts[0]?.type === "data-tbai-compact",
      );
      expect(divider).toBeDefined();
      expect(divider?.role).toBe("assistant");
      expect(divider?.parts[0]?.data?.origin).toBe("automatic");

      // An engine-triggered compaction is auditable on the same terms as a manual one.
      // If the user cannot read what the engine removed, they cannot consent to it —
      // and an engine removing history unasked is exactly the case that needs it.
      expect(data.summary).toContain(SUMMARY_TEXT);
      expect(divider?.parts[0]?.data?.summary).toContain(SUMMARY_TEXT);
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);

  it("compacts AGAIN at generation 2, with its own divider and no duplicate", async () => {
    // Engine-level generations 2-5 are proven in
    // `src/context/compaction/forward-progress.test.ts`, but that suite calls
    // `maybeCompact` directly and therefore cannot see a stream part or a stored row.
    // This is the route-level half: what a user would see after a second automatic
    // compaction in the SAME conversation.
    await seedWithWindow(
      (kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("answered")),
      24_000,
    );
    const id = await newConversation("auto-compaction-generation-2");
    try {
      // ── generation 1 ──────────────────────────────────────────────────────
      const first = await post(id, [
        ...wideHistory(12),
        userMessage("live-1", "the first question"),
      ]);
      const gen1Part = (partsOfType(first, "data-tbai-compact")[0]?.data ?? {}) as Record<string, unknown>;
      const gen1Record = compactionStore.get(id);
      expect(gen1Part.origin).toBe("automatic");
      expect(gen1Part.generation).toBe(1);
      expect(gen1Record?.generation).toBe(1);
      const coveredAfterGen1 = gen1Record?.coveredMessageIds ?? [];

      // ── the conversation keeps going, and grows past the trigger again ────
      const second = await post(id, [
        ...wideHistory(24),
        userMessage("live-2", "a much later question"),
      ]);
      const parts2 = partsOfType(second, "data-tbai-compact");
      const gen2Part = (parts2[0]?.data ?? {}) as Record<string, unknown>;
      const gen2Record = compactionStore.get(id);

      // Generation 2 happened, and the stream said so.
      expect(parts2).toHaveLength(1);
      expect(gen2Part.origin).toBe("automatic");
      expect(gen2Part.outcome).toBe("compacted");
      expect(gen2Part.generation).toBe(2);

      // The divider's generation MATCHES the durable checkpoint, so the transcript
      // and the record cannot describe different compactions.
      expect(gen2Part.generation).toBe(gen2Record?.generation);
      expect(gen2Record?.generation).toBe(2);

      // Coverage advanced and never regressed: the second span subsumes the first.
      expect(gen2Record?.coveredMessageIds.length ?? 0).toBeGreaterThan(coveredAfterGen1.length);
      for (const coveredId of coveredAfterGen1) {
        expect(gen2Record?.coveredMessageIds).toContain(coveredId);
      }

      // A distinct span: the second compaction covered something the first did not.
      expect(gen2Record?.spanFingerprint).not.toBe(gen1Record?.spanFingerprint);
      expect(gen2Record?.spanEndIndex ?? 0).toBeGreaterThan(gen1Record?.spanEndIndex ?? 0);

      // EXACTLY one stored divider per compaction operation — two operations, two
      // rows, no more. This is the duplicate-output guard: a second compaction must
      // not overwrite the first divider, and must not write two of its own.
      const dividerRows = db
        .query<{ content: string }, [string]>(
          "SELECT content FROM messages WHERE conversation_id = ? AND content LIKE '%tbai-compact%' ORDER BY order_seq",
        )
        .all(id)
        .map(
          (r) =>
            (
              JSON.parse(r.content) as {
                parts: Array<{ type: string; data?: Record<string, unknown> }>;
              }
            ).parts[0]?.data ?? {},
        );
      expect(dividerRows).toHaveLength(2);
      expect(dividerRows.map((d) => d.generation)).toEqual([1, 2]);

      // Distinct operation identity per compaction: the divider row id is derived
      // from it, so this is what makes "one row per operation" structural.
      const opIds = dividerRows.map((d) => d.operationId);
      expect(new Set(opIds).size).toBe(2);
      expect(opIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true);

      // The summariser ran once per compaction — chained, not re-reading the prefix
      // as a fresh first compaction would.
      expect(summariserCalls).toBe(2);
    } finally {
      await conversationService.delete(id);
    }
  }, 120000);

  it("writes nothing when occupancy is below the trigger", async () => {
    // The negative case, and the one that would catch a divider written
    // unconditionally. A short conversation in the same window must leave no trace.
    await seedWithWindow(
      (kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("answered")),
      128_000,
    );
    const id = await newConversation("auto-compaction-below-trigger");
    try {
      const body = await post(id, [userMessage("u1", "hello"), userMessage("u2", "and again")]);
      expect(partsOfType(body, "data-tbai-compact")).toHaveLength(0);
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
it("a second `/compact` adds exactly ONE more row, never a duplicate of the first", async () => {
    // The count half of the manual persistence invariant. The client also appends a
    // divider to the live thread, and that append is deliberately non-persisting, so
    // the server's write is the only one that decides how many rows exist. Two
    // commands must therefore produce exactly two rows, each keyed by its own
    // operation — never four (client + server both persisting), never one (the second
    // clobbering the first).
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("unused")));
    const id = await newConversation("b-two-compactions");
    try {
      const dividerRows = (): Array<Record<string, unknown>> =>
        db
          .query<{ content: string }, [string]>(
            "SELECT content FROM messages WHERE conversation_id = ? AND content LIKE '%tbai-compact%' ORDER BY order_seq",
          )
          .all(id)
          .map(
            (r) =>
              (
                JSON.parse(r.content) as {
                  parts: Array<{ data?: Record<string, unknown> }>;
                }
              ).parts[0]?.data ?? {},
          );

      const first = await post(id, [...wideHistory(), userMessage("cmd-1", "/compact")]);
      expect(compactStatus(first)?.anchorMessageId).toBeTruthy();
      const afterFirst = dividerRows();
      expect(afterFirst).toHaveLength(1);

      // A second command on the SAME conversation. Its span may no longer be eligible
      // — that is irrelevant here; what matters is that it still reports one honest
      // outcome and still leaves exactly one row.
      const second = await post(id, [...wideHistory(), userMessage("cmd-2", "/compact")]);
      const secondStatus = compactStatus(second);
      expect(["compacted", "skipped", "failed"]).toContain(secondStatus?.outcome);
      const afterSecond = dividerRows();
      expect(afterSecond).toHaveLength(2);

      // Two distinct operations, so the rows cannot be the same compaction.
      const opIds = afterSecond.map((d) => d.operationId);
      expect(new Set(opIds).size).toBe(2);
      // And each row's id is the operation-derived key, one row per operation.
      const ids = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM messages WHERE conversation_id = ? AND content LIKE '%tbai-compact%' ORDER BY order_seq",
        )
        .all(id)
        .map((r) => r.id);
      expect(new Set(ids).size).toBe(2);
      for (const rowId of ids) {
        expect(rowId).toMatch(/^data-tbai-compact-/);
      }
    } finally {
      await conversationService.delete(id);
    }
  }, 120000);

describe("INSTRUCTIONS — `/compact <instructions>` reaches the summariser", () => {
  it("adds the user's words to the summariser prompt", async () => {
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("unused")));
    const id = await newConversation("compact-instructions");
    try {
      const body = await post(id, [
        ...wideHistory(),
        userMessage("cmd", "/compact keep the API decisions and drop the colour discussion"),
      ]);
      expect(compactStatus(body)?.outcome).toBe("compacted");
      // The summariser ran, and it was told what to keep.
      expect(summariserCalls).toBeGreaterThan(0);
      const summariserBody = summariserBodies.at(-1) ?? "";
      expect(summariserBody).toContain("keep the API decisions and drop the colour discussion");
      // And the base preservation contract is still in force: instructions narrow the
      // summary, they never replace the rules that make it honest.
      expect(summariserBody).toContain("Report only what is in the transcript");
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);

  it("leaves the prompt untouched when no instructions were given", async () => {
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : sseText("unused")));
    const id = await newConversation("compact-no-instructions");
    try {
      const body = await post(id, [...wideHistory(), userMessage("cmd", "/compact")]);
      expect(compactStatus(body)?.outcome).toBe("compacted");
      const summariserBody = summariserBodies.at(-1) ?? "";
      expect(summariserBody).toContain("Report only what is in the transcript");
      // No instructions heading at all, so the request is byte-identical in shape to
      // the behaviour from before instructions existed.
      expect(summariserBody).not.toContain("Additional instructions");
    } finally {
      await conversationService.delete(id);
    }
  }, 90000);
});

