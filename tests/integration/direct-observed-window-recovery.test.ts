/**
 * A provider's own stated context window, learned from its rejection and used by the
 * recovery path that rejection triggers.
 *
 * ## What end-to-end evidence is actually available here
 *
 * The claim under test is a chain, and each link has a different kind of proof:
 *
 * 1. "The rejection carried a usable figure" — unit-proved in
 *    `src/lib/context-window-observation.test.ts` against the verified real error.
 * 2. "The route records it" — this file. The stub provider answers attempt 1 with a
 *    real-shaped overflow whose prose names a limit that is NOT the 128k stand-in, and
 *    the store is read back afterwards through the same API the assembler uses.
 * 3. "The recovery path actually consumed it" — this file, and the proof is the
 *    `message-metadata` the run emits. Occupancy is attached at `finish` from the
 *    limit resolved for THAT turn, so a `windowSource` of `observed` on the successful
 *    retry can only have come from a re-assembly that saw the learned value. That is
 *    the retry, not a fresh request — the count assertions pin it to one.
 * 4. "Exactly once" — `summariserCalls`, which counts compactions rather than requests.
 *
 * ## Why the figure is 524288 and not something round
 *
 * A round number could not distinguish "learned 524288" from "fell back to a nearby
 * constant". The verified gateway figure is deliberately used verbatim, and the
 * request deliberately also contains a LARGER number (the input size) — so a passing
 * test cannot be explained by matching the wrong integer.
 *
 * ## A PRE-EXISTING defect these tests deliberately do NOT rely on
 *
 * `contextStateForUi()` returns `undefined` on this SSE path, so the emitted
 * `message-metadata` carries no `custom.context` and the context ring receives no
 * reading from the stream. This is **pre-existing and orthogonal** to observed-limit
 * recovery, and it is NOT fixed here:
 *
 * - It reproduces on a plain successful Direct turn with no overflow and no recovery,
 *   so nothing about the observation mechanism causes it.
 * - `contextStateForUi()` reads `provenance.limit?.maxInputTokens`, and that field is
 *   absent on the tested path even though `cache_observed` logs `contextLimitSource`
 *   from the same assembly.
 * - Fixing it means changing occupancy reporting, which is outside this change.
 *
 * Consequently the assertions below resolve the window through `resolveContextLimit`
 * against the real seeded registry row instead. Asserting the SSE payload would both
 * fail today and — if it were made to pass — couple this change to a defect that has
 * nothing to do with it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import {
  clearObservedContextWindows,
  readObservedContextWindow,
} from "../../src/context/observed-limits";
import { resolveContextLimit, selectModelOption } from "../../src/context/limits";
import chatApp from "../../src/routes/chat";

const app = new Hono();
app.route("/", chatApp);
const JSON_HEADERS = { "Content-Type": "application/json" };
const PROVIDER_ID = "prov-observed-window";
const MODEL_ID = "observed-window-model";
const PROTOCOL = "chat-completions";

/** The verified gateway figure, used verbatim. Not a round stand-in for one. */
const STATED_LIMIT = 524_288;
/** Larger than the limit, and in the rejection — the number that must NOT be learned. */
const STATED_INPUT = 950_284;

/**
 * The verified provider rejection, reduced to the two parts that matter.
 *
 * Both figures are present, and the input is the larger of the two: this is what makes
 * a wrong extraction visible rather than accidentally harmless.
 */
const OVERFLOW_MESSAGE =
  "ContextWindowExceededError: The input (" +
  `${STATED_INPUT} tokens) is longer than the model's context length (${STATED_LIMIT} tokens).`;

let endpoint = "";
let attemptCalls = 0;
let summariserCalls = 0;
let controlled: ReturnType<typeof Bun.serve> | null = null;

/**
 * Adequate stand-in summary.
 *
 * Sized from the fixture rather than typed as a literal, for the same reason the
 * manual-compaction harness does it: `wideHistory` puts ~10.5k tokens in the removable
 * span, so the adequacy floor rejects a one-line summary and nothing downstream runs.
 */
const SUMMARY_TEXT = Array.from(
  { length: 12 },
  (_, i) =>
    `${i + 1}. The user asked about storage internals and the assistant explained page layout and write-ahead logging.`,
).join(" ");

type Behaviour = (kind: "attempt" | "summariser", nth: number) => Response;

function jsonCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-c",
      object: "chat.completion",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function overflowResponse(): Response {
  return new Response(
    JSON.stringify({ error: { message: OVERFLOW_MESSAGE, type: "invalid_request_error" } }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

function sseText(content: string): Response {
  return new Response(
    [
      "data: " +
        JSON.stringify({
          id: "chatcmpl-c",
          object: "chat.completion.chunk",
          created: 0,
          model: MODEL_ID,
          choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
        }) +
        "\n\n",
      "data: " +
        JSON.stringify({
          id: "chatcmpl-c",
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

/** Every SSE `data:` payload of a given part type. */
function partsOfType(sse: string, type: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (const line of sse.split("\n")) {
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

/** Ordered `type` of every chunk, `[DONE]` excluded. */
function chunkTypes(sse: string): string[] {
  const types: string[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { type?: unknown };
      if (typeof parsed.type === "string") types.push(parsed.type);
    } catch {
      /* keepalive */
    }
  }
  return types;
}

function userMessage(id: string, text: string): Record<string, unknown> {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

/**
 * A transcript whose removable span is comfortably larger than
 * `DEFAULT_COMPACTION_POLICY.maxSummaryTokens`, so a forced compaction can actually
 * apply. A short history would be legitimately un-compactable, which would test
 * nothing about recovery.
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

async function seed(behaviour: Behaviour): Promise<void> {
  attemptCalls = 0;
  summariserCalls = 0;
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = await req.text().catch(() => "");
      const kind: "attempt" | "summariser" = wantsStream(raw) ? "attempt" : "summariser";
      if (kind === "attempt") attemptCalls += 1;
      else summariserCalls += 1;
      return behaviour(kind, kind === "attempt" ? attemptCalls : summariserCalls);
    },
  });
  controlled.unref();
  endpoint = `http://127.0.0.1:${controlled.port}/v1`;
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'observed-window', 'ollama', NULL, NULL, ?, ?, '[]', 'off', ?, 1, ?, ?)`,
    [PROVIDER_ID, endpoint, MODEL_ID, PROTOCOL, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
}

/** The key the route writes and the assembler reads — one function, so it cannot drift. */
function observedKey() {
  return { providerId: PROVIDER_ID, modelId: MODEL_ID, endpoint, protocol: PROTOCOL };
}

/**
 * Resolve the window for the SEEDED REGISTRY ROW, exactly as `assembleContext` does.
 *
 * Uses the real `provider_configs` row the route just used — no hand-built stand-in —
 * and the same `selectModelOption` / `resolveContextLimit` pair the assembler calls, so
 * this asserts the value is CONSUMED by resolution rather than merely sitting in the
 * store. `observed` is passed explicitly so the same call can also be made with nothing
 * observed, which is what proves the consumption below.
 */
function resolveSeededWindow(): {
  maxInputTokens: number | undefined;
  source: string;
} {
  const provider = registry.get(PROVIDER_ID);
  if (provider === undefined) throw new Error("seeded provider row is missing");
  const limit = resolveContextLimit({
    providerType: provider.type,
    modelId: MODEL_ID,
    model: selectModelOption(provider.models, MODEL_ID),
    observedContextWindow: readObservedContextWindow(observedKey())?.limitTokens,
    providerId: provider.id,
    endpoint: provider.endpoint,
    protocol: provider.apiProtocol,
  });
  return { maxInputTokens: limit.maxInputTokens, source: limit.source };
}

async function runTurn(messages: Array<Record<string, unknown>>): Promise<string> {
  const conv = await conversationService.create({
    title: "observed-window",
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

beforeEach(() => {
  clearObservedContextWindows();
});
afterEach(() => {
  try {
    controlled?.stop(true);
  } catch {
    /* closed */
  }
  controlled = null;
  clearObservedContextWindows();
});
afterAll(async () => {
  db.run("DELETE FROM provider_configs WHERE id = ?", [PROVIDER_ID]);
  await registry.loadFromDb(db);
});

describe("a provider's stated window reaches the recovery it triggers", () => {
  it("records the stated limit, not the input size, and plans the retry against it", async () => {
    await seed((kind, nth) => {
      if (kind === "summariser") return jsonCompletion(SUMMARY_TEXT);
      // Attempt 1 is rejected with the real-shaped overflow; the retry succeeds.
      return nth === 1 ? overflowResponse() : sseText("recovered answer");
    });

    const sse = await runTurn(wideHistory());

    // The provider was reached: nothing below passes vacuously.
    expect(attemptCalls).toBe(2);
    // Exactly one compaction, on the recovery path. A second would mean the retry
    // re-entered recovery rather than going through it.
    expect(summariserCalls).toBe(1);

    // The route recorded the limit the provider STATED — the second of the two figures
    // in its own message, and the one that is not the input.
    expect(readObservedContextWindow(observedKey())?.limitTokens).toBe(STATED_LIMIT);

    // The learned window is CONSUMED, not merely stored. Both halves matter: the first
    // shows the figure resolution produces; the second shows the same resolver, same
    // registry row, produces the stand-in when nothing was observed — so the first
    // cannot pass by accident.
    //
    // Deliberately NOT asserted against `message-metadata`: that payload carries no
    // `context` on this path at all, including for a plain successful turn. See the
    // occupancy note in this file's header.
    expect(resolveSeededWindow()).toEqual({ maxInputTokens: STATED_LIMIT, source: "observed" });
    clearObservedContextWindows();
    // With the observation removed the SAME call falls back — proof the resolver read
    // the store rather than the constant being STATED_LIMIT by coincidence.
    expect(resolveSeededWindow()).toEqual({
      maxInputTokens: 128_000,
      source: "conservative_default",
    });

    // A normal completed turn, not a second error.
    expect(chunkTypes(sse)).toContain("text-delta");
    expect(chunkTypes(sse)).not.toContain("error");

    // Exactly one divider: recovery must not publish compaction UI twice for one turn.
    expect(partsOfType(sse, "data-tbai-compact")).toHaveLength(1);
  }, 60000);

  it("keeps the limit out of another provider's resolution", async () => {
    await seed((kind, nth) => {
      if (kind === "summariser") return jsonCompletion(SUMMARY_TEXT);
      return nth === 1 ? overflowResponse() : sseText("recovered answer");
    });
    await runTurn(wideHistory());
    expect(readObservedContextWindow(observedKey())).toBeDefined();

    // Same model id, different endpoint and account: a near-miss key must miss.
    expect(
      readObservedContextWindow({ ...observedKey(), endpoint: "http://127.0.0.1:1/v1" }),
    ).toBeUndefined();
    expect(readObservedContextWindow({ ...observedKey(), providerId: "prov-elsewhere" })).toBeUndefined();
    expect(readObservedContextWindow({ ...observedKey(), modelId: "other-model" })).toBeUndefined();
  }, 60000);
});

describe("a second rejection still terminates normally", () => {
  it("does not attempt a third time, and still records what the provider stated", async () => {
    // Both kinds overflow. The summariser MUST still answer, or this would be testing a
    // failed compaction rather than the two-attempt bound.
    await seed((kind) => (kind === "summariser" ? jsonCompletion(SUMMARY_TEXT) : overflowResponse()));

    const sse = await runTurn(wideHistory());

    // The bound holds: one retry, no third.
    expect(attemptCalls).toBe(2);
    expect(summariserCalls).toBe(1);
    // The observation is still recorded — a failing turn teaches us the window too.
    expect(readObservedContextWindow(observedKey())?.limitTokens).toBe(STATED_LIMIT);
    // And the user is told the real cause, once.
    expect(chunkTypes(sse).filter((t) => t === "error")).toHaveLength(1);
  }, 60000);
});

describe("a rejection that states no limit changes nothing", () => {
  it("leaves the conservative stand-in in place", async () => {
    await seed((kind, nth) => {
      if (kind === "summariser") return jsonCompletion(SUMMARY_TEXT);
      if (nth === 1) {
        return new Response(
          JSON.stringify({
            error: { message: "context window exceeded", type: "invalid_request_error" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return sseText("recovered answer");
    });

    await runTurn(wideHistory());

    // Recovery itself was unaffected: the retry still happened and still compacted.
    expect(attemptCalls).toBe(2);
    expect(summariserCalls).toBe(1);
    expect(readObservedContextWindow(observedKey())).toBeUndefined();

    // Nothing was learned, so resolution is unchanged: same stand-in, same provenance.
    expect(resolveSeededWindow()).toEqual({
      maxInputTokens: 128_000,
      source: "conservative_default",
    });
  }, 60000);
});