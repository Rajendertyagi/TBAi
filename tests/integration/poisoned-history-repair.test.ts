/**
 * Provider-boundary guard for the replayable-history invariant.
 *
 * ## The production failure this pins
 *
 * On 2026-10-02 a Direct conversation against an OpenAI-compatible gateway
 * became permanently unusable: 18 consecutive sends answered HTTP 400 with the
 * copy "Generation failed. Retry or pick another provider/model."
 *
 * A prior run's tool call had its arguments cut mid-object by the gateway, so the
 * AI SDK persisted
 *
 *   { type: "tool-write_file", toolCallId: "call_92b1…", state: "output-error",
 *     input: undefined, rawInput: '{"path": "project-console/projects.json"' }
 *
 * `ai@7.0.93` substitutes `rawInput` for the missing `input`, and
 * `@ai-sdk/openai-compatible@3.0.44` serializes it as
 * `arguments: JSON.stringify(part.input)` — putting a JSON *string* where the wire
 * requires a JSON *object*. Every retry re-sent the identical malformed payload.
 *
 * ## What this suite asserts
 *
 * The unit suite proves the repair seam classifies the shape correctly. This suite
 * proves the CONSEQUENCE at the boundary that actually matters: the bytes on the
 * wire. It stands a local OpenAI-compatible endpoint behind a seeded provider,
 * drives the REAL chat route, and audits every `tool_calls[].function.arguments`
 * in the captured outbound request.
 *
 * The controlled endpoint answers 400 to any request carrying a non-object
 * `arguments` — i.e. it REPRODUCES the production rejection rather than
 * tolerating it. A case therefore fails if malformed arguments reach it at all,
 * which is the assertion that could not be written from a mirrored request.
 *
 * No production provider is contacted and no provider quota is spent.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import { logger } from "../../src/lib/logger";
import chatApp from "../../src/routes/chat";

const app = new Hono();
app.route("/", chatApp);

const JSON_HEADERS = { "Content-Type": "application/json" };

// ── Markers ───────────────────────────────────────────────────────────────────
const POISONED_TOOL_CALL_ID = "call_92b132ffbdcd4877bad7ab9b";
/** The verbatim truncated argument text from the production conversation. */
const POISONED_RAW_INPUT = '{"path": "project-console/projects.json"';
const POISONED_ERROR_TEXT = "A tool call failed. See diagnostics and retry.";
const VALID_INPUT = { path: "notes.txt", content: "hello" };
const VALID_RAW_INPUT = '{"path":"notes.txt","content":"hello"}';
const USER_TEXT = "continue please";

const PROVIDER_ID = "prov-poisoned-history";
const MODEL_ID = "void-model";

/** Outcome of the controlled endpoint's own argument validation. */
interface ArgumentVerdict {
  ok: boolean;
  reason: string;
}

/** Every request the controlled endpoint received, with its validation verdict. */
let captured: Array<{ path: string; body: Record<string, unknown>; verdict: ArgumentVerdict }> = [];
let controlled: ReturnType<typeof Bun.serve> | null = null;

/**
 * Validate the outbound `tool_calls[].function.arguments` the way an
 * OpenAI-compatible provider must.
 *
 * The contract is one field: `arguments` is a JSON **object**. A JSON string, an
 * array, `null`, malformed text, or an absent field are all rejections — and each
 * is reported with the reason so a failure names which defect reached the wire.
 */
function validateToolArguments(body: Record<string, unknown>): ArgumentVerdict {
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  for (const [mi, raw] of messages.entries()) {
    if (raw === null || typeof raw !== "object") continue;
    const toolCalls = (raw as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const [ci, rawCall] of toolCalls.entries()) {
      const call = rawCall as { function?: { name?: string; arguments?: unknown } };
      const name = call.function?.name ?? "?";
      const args = call.function?.arguments;
      const at = `messages[${mi}].tool_calls[${ci}](${name}).arguments`;
      if (args === undefined || args === null) {
        return { ok: false, reason: `${at} is absent — the provider requires an object` };
      }
      if (typeof args !== "string") {
        return { ok: false, reason: `${at} is ${typeof args}, expected a JSON object string` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(args);
      } catch (e) {
        return { ok: false, reason: `${at} is malformed JSON: ${(e as Error).message}` };
      }
      if (parsed === null) return { ok: false, reason: `${at} parses to null, not an object` };
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          ok: false,
          reason: `${at} parses to ${Array.isArray(parsed) ? "an array" : typeof parsed}, not an object`,
        };
      }
    }
  }
  return { ok: true, reason: "no tool_calls in this request" };
}

/** Every tool-call id present on the wire, in message order. */
function toolCallIdsOnWire(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  const ids: string[] = [];
  for (const raw of messages) {
    if (raw === null || typeof raw !== "object") continue;
    const toolCalls = (raw as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      const id = (call as { id?: unknown }).id;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

/** Tool-result `tool_call_id`s present on the wire (the orphan check). */
function toolResultIdsOnWire(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  const ids: string[] = [];
  for (const raw of messages) {
    if (raw === null || typeof raw !== "object") continue;
    if ((raw as { role?: unknown }).role !== "tool") continue;
    const id = (raw as { tool_call_id?: unknown }).tool_call_id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/**
 * When set, the controlled endpoint rejects the next request with this status and
 * an OpenAI-shaped error body carrying every field the diagnostic could be tempted
 * to log. Used to drive a REAL provider failure through the route.
 */
let rejectWith: { status: number } | null = null;

/** Provider prose that must never reach a log line. */
const PROVIDER_ERROR_PROSE = "PROVIDER_ERROR_PROSE_MARKER_prompt_echo";
const PROVIDER_ERROR_PARAM = "messages[9].tool_calls[0].function.arguments";
/**
 * Status line for the rejection fixture.
 *
 * Deliberately does NOT contain the words `invalid request` / `invalid payload`:
 * those are TBAi's own request-validation vocabulary (`VALIDATION_RE`), so a
 * fixture using them would be classified as an application-side `validation`
 * rejection and never exercise the provider-4xx copy path. The production
 * conversation this repair came from classified as `config`, so the fixture
 * reproduces that: a bare status phrase plus the marker.
 */
const PROVIDER_ERROR_STATUS_TEXT = "Bad Request";

function chatCompletionChunk(delta: unknown, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-poisoned-history",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/**
 * The controlled endpoint: validate, then answer.
 *
 * It rejects malformed tool arguments with the same status the production gateway
 * used (400) so a regression reproduces the user's failure rather than passing
 * quietly, and answers a clean request with a normal completion.
 */
function controlledResponse(body: Record<string, unknown>): Response {
  if (rejectWith) {
    return new Response(
      JSON.stringify({
        error: {
          message: `${PROVIDER_ERROR_STATUS_TEXT}: ${PROVIDER_ERROR_PROSE}`,
          type: "invalid_request_error",
          param: PROVIDER_ERROR_PARAM,
          code: "invalid_tool_arguments",
        },
      }),
      { status: rejectWith.status, headers: { "Content-Type": "application/json" } },
    );
  }
  const verdict = validateToolArguments(body);
  if (!verdict.ok) {
    return new Response(
      JSON.stringify({
        error: {
          message: `${PROVIDER_ERROR_STATUS_TEXT}: ${verdict.reason}`,
          type: "invalid_request_error",
          param: verdict.reason.split(" ")[0],
          code: "invalid_tool_arguments",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const sse = [
    chatCompletionChunk({ role: "assistant", content: "ok" }),
    chatCompletionChunk({}, "stop"),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
}

function startControlledProvider(): string {
  captured = [];
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      captured.push({ path: url.pathname, body, verdict: validateToolArguments(body) });
      return controlledResponse(body);
    },
  });
  controlled.unref();
  return `http://127.0.0.1:${controlled.port}`;
}

async function seedControlledProvider(): Promise<string> {
  const endpoint = startControlledProvider();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'poisoned-history', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, endpoint, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
  return endpoint;
}

function stopControlledProvider(): void {
  try {
    controlled?.stop(true);
  } catch {
    /* already closed */
  }
  controlled = null;
  captured = [];
}

afterAll(async () => {
  stopControlledProvider();
  db.run("DELETE FROM provider_configs WHERE id = ?", [PROVIDER_ID]);
  await registry.loadFromDb(db);
});

beforeEach(() => {
  captured = [];
  rejectWith = null;
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});
afterEach(() => {
  stopControlledProvider();
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

// ── History shapes ────────────────────────────────────────────────────────────

const userMessage = (text: string, id = "msg-user-1"): Record<string, unknown> => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

/** The production assistant turn: text plus the unreplayable tool part. */
function poisonedAssistantTurn(): Record<string, unknown> {
  return {
    id: "msg-assistant-1",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "text", text: "Creating the file now." },
      {
        type: "tool-write_file",
        toolCallId: POISONED_TOOL_CALL_ID,
        state: "output-error",
        rawInput: POISONED_RAW_INPUT,
        errorText: POISONED_ERROR_TEXT,
      },
    ],
  };
}

/** A healthy assistant turn with a real tool result. */
function validAssistantTurn(): Record<string, unknown> {
  return {
    id: "msg-assistant-valid",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "text", text: "Wrote it." },
      {
        type: "tool-write_file",
        toolCallId: "call_valid",
        state: "output-available",
        input: VALID_INPUT,
        output: { ok: true },
      },
    ],
  };
}

/** A healthy assistant turn using the LENIENT legacy shape. */
function legacyRecoverableAssistantTurn(): Record<string, unknown> {
  return {
    id: "msg-assistant-legacy",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "text", text: "Attempted it." },
      {
        type: "tool-write_file",
        toolCallId: "call_legacy",
        state: "output-error",
        rawInput: VALID_RAW_INPUT,
        errorText: POISONED_ERROR_TEXT,
      },
    ],
  };
}

async function createConversation(title: string): Promise<string> {
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

async function postChat(conversationId: string, messages: Array<Record<string, unknown>>): Promise<Response> {
  return app.request("/api/chat", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      providerId: PROVIDER_ID,
      model: MODEL_ID,
      id: conversationId,
      messages,
    }),
  });
}

/** Run one send and return the controlled endpoint's verdict on its request. */
async function sendAndCapture(
  conversationId: string,
  messages: Array<Record<string, unknown>>,
): Promise<{ status: number; body: string; outbound: Record<string, unknown>; verdict: ArgumentVerdict }> {
  const res = await postChat(conversationId, messages);
  const body = await res.text();
  expect(captured.length).toBe(1);
  const request = captured[0];
  return { status: res.status, body, outbound: request.body, verdict: request.verdict };
}

// ── Cases ─────────────────────────────────────────────────────────────────────

describe("poisoned history — the provider boundary", () => {
  it("never puts the malformed tool call on the wire", async () => {
    await seedControlledProvider();
    const conversationId = await createConversation("poisoned-history");

    try {
      const { status, outbound, verdict } = await sendAndCapture(conversationId, [
        userMessage("write it", "msg-u1"),
        poisonedAssistantTurn(),
        userMessage(USER_TEXT, "msg-u2"),
      ]);

      // The controlled endpoint validates exactly as a provider must; if the
      // malformed arguments had reached it, it would have answered 400.
      expect(verdict.ok).toBe(true);
      expect(status).toBe(200);
      // Belt and braces: assert the absence directly on the bytes.
      expect(toolCallIdsOnWire(outbound)).not.toContain(POISONED_TOOL_CALL_ID);
      // And no orphan tool result left behind for a call that is gone.
      expect(toolResultIdsOnWire(outbound)).not.toContain(POISONED_TOOL_CALL_ID);
      expect(outbound.messages).toBeDefined();
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("succeeds on a healthy tool call and keeps its arguments as an object", async () => {
    await seedControlledProvider();
    const conversationId = await createConversation("healthy-history");

    try {
      const { status, outbound, verdict } = await sendAndCapture(conversationId, [
        userMessage("write it", "msg-u1"),
        validAssistantTurn(),
        userMessage(USER_TEXT, "msg-u2"),
      ]);

      expect(verdict.ok).toBe(true);
      expect(status).toBe(200);
      // The healthy call is PRESERVED, not collateral damage.
      expect(toolCallIdsOnWire(outbound)).toContain("call_valid");
      const messages = outbound.messages as Array<Record<string, unknown>>;
      const assistantWithCall = messages.find(
        (m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
      );
      const call = (assistantWithCall?.tool_calls as Array<{ function: { arguments: string } }>)[0];
      expect(JSON.parse(call.function.arguments)).toEqual(VALID_INPUT);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("emits allowlisted provider error codes on a real 400 and never the body", async () => {
  await seedControlledProvider();
  const conversationId = await createConversation("provider-error-code");

  try {
    // Drive a genuine provider rejection through the route so the diagnostic
    // path actually executes — this is not a simulated log line.
    rejectWith = { status: 400 };
    const since = logger.lastSeq;
    const res = await postChat(conversationId, [userMessage("hello", "msg-u1")]);
    const body = await res.text();
    rejectWith = null;

    expect(captured.length).toBe(1);
    expect(res.status).toBe(200); // the run settles failed INSIDE the stream
    expect(body).toContain("error");

    const entries = logger.getRecentEntries(since);
    const rendered = entries.map((e) => JSON.stringify(e));

    const diagnostic = entries.filter((e) => e.event === "ai.provider_error_code");
    expect(diagnostic).toHaveLength(1);
    const fields = diagnostic[0] as unknown as Record<string, unknown>;
    // Exactly the allowlist — nothing more.
    expect(fields.errorType).toBe("invalid_request_error");
    expect(fields.errorCode).toBe("invalid_tool_arguments");
    expect(fields.errorParam).toBe(PROVIDER_ERROR_PARAM);
    expect(fields.statusCode).toBe(400);
    expect(fields.provider).toBe("ollama");
    expect(fields.model).toBe(MODEL_ID);
    expect(fields.requestId).toBeDefined();
    expect(fields.conversationId).toBe(conversationId);

    // The provider's PROSE and any body-shaped field must not appear anywhere.
    for (const line of rendered) {
      expect(line).not.toContain(PROVIDER_ERROR_PROSE);
      expect(line).not.toContain("responseBody");
      expect(line).not.toContain("requestBodyValues");
      expect(line).not.toContain(POISONED_RAW_INPUT);
    }

    // `ai.error` keeps its deliberate omission of the provider message.
    const aiError = entries.find((e) => e.event === "ai.error");
    expect(aiError).toBeDefined();
    expect(JSON.stringify(aiError)).not.toContain(PROVIDER_ERROR_PROSE);

    // The fixture must actually reach the `config` bucket, or this case proves
    // nothing about the 4xx copy. (An `Invalid request: …` fixture would be
    // claimed by VALIDATION_RE as an application-side rejection.)
    expect(aiError?.category).toBe("config");
  } finally {
    rejectWith = null;
    await conversationService.delete(conversationId);
  }
}, 30000);

it("answers a provider 400 with the new non-retry copy, never the generic one", async () => {
  await seedControlledProvider();
  const conversationId = await createConversation("provider-4xx-copy");

  try {
    rejectWith = { status: 400 };
    const res = await postChat(conversationId, [userMessage("hello", "msg-u1")]);
    const body = await res.text();
    rejectWith = null;

    expect(body).toContain("Retrying the same message will not help");
    expect(body).not.toContain("Generation failed. Retry or pick another provider/model.");
  } finally {
    rejectWith = null;
    await conversationService.delete(conversationId);
  }
}, 30000);

  it("replays the lenient legacy shape with recovered object arguments", async () => {
    await seedControlledProvider();
    const conversationId = await createConversation("legacy-history");

    try {
      const { status, outbound, verdict } = await sendAndCapture(conversationId, [
        userMessage("write it", "msg-u1"),
        legacyRecoverableAssistantTurn(),
        userMessage(USER_TEXT, "msg-u2"),
      ]);

      expect(verdict.ok).toBe(true);
      expect(status).toBe(200);
      // Lenient recovery keeps the interaction, and the SDK substitutes the
      // recovered object — which serializes as a valid object on the wire.
      expect(toolCallIdsOnWire(outbound)).toContain("call_legacy");
      const messages = outbound.messages as Array<Record<string, unknown>>;
      const assistantWithCall = messages.find(
        (m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
      );
      const call = (assistantWithCall?.tool_calls as Array<{ function: { arguments: string } }>)[0];
      expect(JSON.parse(call.function.arguments)).toEqual(VALID_INPUT);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("removes a poisoned call while preserving a sibling valid call", async () => {
    await seedControlledProvider();
    const conversationId = await createConversation("mixed-history");

    try {
      const mixed = poisonedAssistantTurn();
      const parts = mixed.parts as unknown[];
      parts.push({
        type: "tool-write_file",
        toolCallId: "call_sibling",
        state: "output-available",
        input: { path: "other.txt", content: "y" },
        output: { ok: true },
      });

      const { status, outbound, verdict } = await sendAndCapture(conversationId, [
        userMessage("write it", "msg-u1"),
        mixed,
        userMessage(USER_TEXT, "msg-u2"),
      ]);

      expect(verdict.ok).toBe(true);
      expect(status).toBe(200);
      const ids = toolCallIdsOnWire(outbound);
      expect(ids).not.toContain(POISONED_TOOL_CALL_ID);
      expect(ids).toContain("call_sibling");
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("keeps an open approval gate off the wire and the conversation usable", async () => {
    await seedControlledProvider();
    const conversationId = await createConversation("approval-gate");

    try {
      const { status, outbound, verdict } = await sendAndCapture(conversationId, [
        userMessage("write it", "msg-u1"),
        {
          id: "msg-assistant-gate",
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "text", text: "I need permission." },
            {
              type: "tool-write_file",
              toolCallId: "call_gate",
              state: "approval-requested",
              input: { path: "notes.txt", content: "x" },
              approval: { id: "ap-gate", isAutomatic: false },
            },
          ],
        },
        userMessage(USER_TEXT, "msg-u2"),
      ]);

      expect(verdict.ok).toBe(true);
      expect(status).toBe(200);
      // An open gate is filtered before conversion, so it reaches neither the
      // wire nor the drop path — the conversation stays usable either way. The
      // part carries `input` because the route's UIMessage schema REQUIRES it in
      // this state (verified against `safeValidateUIMessages`), so the
      // gate-without-input shape cannot reach the repair seam through the API.
      expect(toolCallIdsOnWire(outbound)).not.toContain("call_gate");
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});