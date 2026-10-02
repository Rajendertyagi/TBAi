/**
 * Provider-boundary guard — Generation-400, the `input: null` production case.
 *
 * ## Why this suite exists
 *
 * The Generation-400 repair treated `input !== undefined` as usable arguments.
 * The AI SDK substitutes with `part.input ?? part.rawInput` (`ai@7.0.93`) and
 * `@ai-sdk/openai-compatible@3.0.44` serializes the result as
 * `arguments: JSON.stringify(part.input)`. `??` treats `null` as absent, so a
 * part carrying `input: null` fell through to its truncated `rawInput` and put
 * text on the wire — the production defect, reachable through a key the earlier
 * repair never inspected.
 *
 * ## What this suite asserts
 *
 * The unit suite proves the repair seam classifies each shape. This suite proves
 * the CONSEQUENCE on the wire: it stands a local OpenAI-compatible endpoint
 * behind a seeded provider, drives the REAL `POST /api/chat`, and audits every
 * `tool_calls[].function.arguments` in the captured outbound request.
 *
 * The endpoint REPRODUCES the production rejection rather than tolerating it —
 * it answers 400 to any request carrying a non-object `arguments`, exactly as
 * the gateway did. The validator is itself asserted below, so the endpoint's
 * authority to fail a case is proven rather than assumed.
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

// ── The verbatim production payload ───────────────────────────────────────────
const POISONED_TOOL_CALL_ID = "call_92b132ffbdcd4877bad7ab9b";
/** The truncated argument text the gateway actually cut. */
const POISONED_RAW_INPUT = '{"path": "project-console/projects.json"';
const POISONED_ERROR_TEXT = "A tool call failed. See diagnostics and retry.";

const PROVIDER_ID = "prov-null-input-boundary";
const MODEL_ID = "void-model";

interface Captured {
  path: string;
  body: Record<string, unknown>;
  problem: string | null;
}

let captured: Captured[] = [];
let controlled: ReturnType<typeof Bun.serve> | null = null;

/**
 * Validate the outbound `tool_calls[].function.arguments` exactly as an
 * OpenAI-compatible provider must: `arguments` is a JSON **object**. A JSON
 * string, array, `null`, malformed text or an absent field are all rejections,
 * each reported with the location that failed.
 */
function validateToolArguments(body: Record<string, unknown>): string | null {
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
      if (args === undefined || args === null) return `${at} is absent`;
      if (typeof args !== "string") return `${at} is ${typeof args}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(args);
      } catch {
        return `${at} is malformed JSON`;
      }
      if (parsed === null) return `${at} parses to null, not an object`;
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        return `${at} parses to ${Array.isArray(parsed) ? "an array" : typeof parsed}, not an object`;
      }
    }
  }
  return null;
}

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

/** Tool-result `tool_call_id`s on the wire — the orphan check. */
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

function chatCompletionChunk(delta: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-null-input",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

async function seedControlledProvider(): Promise<void> {
  captured = [];
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const problem = validateToolArguments(body);
      captured.push({ path: url.pathname, body, problem });
      if (problem) {
        return new Response(
          JSON.stringify({
            error: { message: `Bad Request: ${problem}`, type: "invalid_request_error", param: "tool", code: "invalid_tool_arguments" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        [chatCompletionChunk({ role: "assistant", content: "ok" }), chatCompletionChunk({}, "stop"), "data: [DONE]\n\n"].join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  controlled.unref();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'null-input-boundary', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, `http://127.0.0.1:${controlled.port}`, MODEL_ID, Date.now(), Date.now()],
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
  captured = [];
}

beforeEach(() => {
  captured = [];
});
afterEach(() => {
  stopControlledProvider();
});
afterAll(async () => {
  db.run("DELETE FROM provider_configs WHERE id = ?", [PROVIDER_ID]);
  await registry.loadFromDb(db);
});

const userMessage = (text: string, id: string) => ({ id, role: "user", parts: [{ type: "text", text }] });

/** The production assistant turn, with a caller-chosen `input` shape. */
function assistantTurn(toolCallId: string, inputField: Record<string, unknown>) {
  return {
    id: `msg-assistant-${toolCallId}`,
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "text", text: "Creating the file now." },
      {
        type: "tool-write_file",
        toolCallId,
        state: "output-error",
        rawInput: POISONED_RAW_INPUT,
        errorText: POISONED_ERROR_TEXT,
        ...inputField,
      },
    ],
  };
}

async function sendOne(messages: Array<Record<string, unknown>>): Promise<{
  outbound: Record<string, unknown>;
  problem: string | null;
}> {
  const conv = await conversationService.create({
    title: "null-input-boundary",
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
    await res.text();
    expect(captured.length).toBe(1);
    return { outbound: captured[0].body, problem: captured[0].problem };
  } finally {
    await conversationService.delete(conv.id);
  }
}

// ── 13: the endpoint's own authority to fail a case ───────────────────────────
describe("null-input boundary: the controlled endpoint is a real validator", () => {
  const call = (args: unknown) => ({
    messages: [{ role: "assistant", tool_calls: [{ id: "c1", function: { name: "write_file", arguments: args } }] }],
  });

  it.each([
    ['a JSON string (the production defect)', '"{\\"path\\": \\"a.txt\\"}"', true],
    ["a JSON array", '"[1,2]"', true],
    ["JSON null", '"null"', true],
    ["malformed JSON", '"{\\"path\\":"', true],
    ["an absent field", undefined, true],
    // A well-formed object document — the shape every accepted request carries.
    ["a valid object", '{"path":"a.txt"}', false],
  ])("rejects %s", (_label, args, shouldFail) => {
    const problem = validateToolArguments(call(args) as Record<string, unknown>);
    if (shouldFail) expect(problem).not.toBeNull();
    else expect(problem).toBeNull();
  });

  it("passes a request that carries no tool calls at all", () => {
    expect(validateToolArguments({ messages: [{ role: "user", content: "hi" }] })).toBeNull();
  });
});

// ── 1, 3–5: every non-object input must not reach the wire ────────────────────
describe("null-input boundary: non-object input never reaches the provider", () => {
  it.each([
    ["null", null],
    ["an array", [1, 2, 3]],
    ["a string", "not-an-object"],
    ["a number", 42],
    ["a boolean", true],
  ])("input = %s is repaired away before conversion", async (_label, badInput) => {
    await seedControlledProvider();
    const id = `call_bad_${_label}`;
    const { outbound, problem } = await sendOne([
      userMessage("write it", "msg-u1"),
      assistantTurn(id, { input: badInput }),
      userMessage("continue please", "msg-u2"),
    ]);

    // Had the malformed argument reached the endpoint it would have answered 400.
    expect(problem).toBeNull();
    expect(toolCallIdsOnWire(outbound)).not.toContain(id);
    // And no orphan tool result survives for the removed call.
    expect(toolResultIdsOnWire(outbound)).not.toContain(id);
  }, 30000);
});

// ── 1: the exact `input: null` production case ────────────────────────────────
describe("null-input boundary: the exact poisoned production case", () => {
  it("input: null with the truncated rawInput is repaired (BEFORE: answered 400)", async () => {
    await seedControlledProvider();
    const { outbound, problem } = await sendOne([
      userMessage("write it", "msg-u1"),
      assistantTurn(POISONED_TOOL_CALL_ID, { input: null }),
      userMessage("continue please", "msg-u2"),
    ]);

    expect(problem).toBeNull();
    expect(toolCallIdsOnWire(outbound)).not.toContain(POISONED_TOOL_CALL_ID);
    expect(toolResultIdsOnWire(outbound)).not.toContain(POISONED_TOOL_CALL_ID);
  }, 30000);

  it("the identical payload with the key ABSENT stays repaired (the Generation-400 case)", async () => {
    await seedControlledProvider();
    const { outbound, problem } = await sendOne([
      userMessage("write it", "msg-u1"),
      assistantTurn("call_absent_key"),
      userMessage("continue please", "msg-u2"),
    ]);
    expect(problem).toBeNull();
    expect(toolCallIdsOnWire(outbound)).not.toContain("call_absent_key");
  }, 30000);

  it("6. a valid input object still reaches the wire as an object", async () => {
    await seedControlledProvider();
    const validInput = { path: "notes.txt", content: "hello" };
    const { outbound, problem } = await sendOne([
      userMessage("write it", "msg-u1"),
      {
        id: "msg-assistant-valid",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "Wrote it." },
          { type: "tool-write_file", toolCallId: "call_valid", state: "output-available", input: validInput, output: { ok: true } },
        ],
      },
      userMessage("continue please", "msg-u2"),
    ]);

    expect(problem).toBeNull();
    expect(toolCallIdsOnWire(outbound)).toContain("call_valid");
    const messages = outbound.messages as Array<Record<string, unknown>>;
    const withCall = messages.find((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
    const first = (withCall?.tool_calls as Array<{ function: { arguments: string } }>)[0];
    expect(JSON.parse(first.function.arguments)).toEqual(validInput);
  }, 30000);

  it("7. input: null with a VALID object rawInput is recovered and replayed as an object", async () => {
    await seedControlledProvider();
    const recovered = { path: "notes.txt", content: "hello" };
    const { outbound, problem } = await sendOne([
      userMessage("write it", "msg-u1"),
      {
        id: "msg-assistant-recover",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "Attempted it." },
          {
            type: "tool-write_file",
            toolCallId: "call_recover",
            state: "output-error",
            input: null,
            rawInput: JSON.stringify(recovered),
            errorText: POISONED_ERROR_TEXT,
          },
        ],
      },
      userMessage("continue please", "msg-u2"),
    ]);

    expect(problem).toBeNull();
    // Lenient recovery preserves genuine arguments rather than discarding them.
    expect(toolCallIdsOnWire(outbound)).toContain("call_recover");
    const messages = outbound.messages as Array<Record<string, unknown>>;
    const withCall = messages.find((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
    const first = (withCall?.tool_calls as Array<{ function: { arguments: string } }>)[0];
    expect(JSON.parse(first.function.arguments)).toEqual(recovered);
  }, 30000);

  it("9. an open approval gate stays off the wire and keeps the conversation usable", async () => {
    await seedControlledProvider();
    const { outbound, problem } = await sendOne([
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
      userMessage("continue please", "msg-u2"),
    ]);

    expect(problem).toBeNull();
    expect(toolCallIdsOnWire(outbound)).not.toContain("call_gate");
  }, 30000);

  it("12. a healthy sibling call survives beside a repaired one", async () => {
    await seedControlledProvider();
    const mixed = assistantTurn("call_broken", { input: null });
    (mixed.parts as unknown[]).push({
      type: "tool-write_file",
      toolCallId: "call_sibling",
      state: "output-available",
      input: { path: "other.txt", content: "y" },
      output: { ok: true },
    });

    const { outbound, problem } = await sendOne([
      userMessage("write it", "msg-u1"),
      mixed,
      userMessage("continue please", "msg-u2"),
    ]);

    expect(problem).toBeNull();
    const ids = toolCallIdsOnWire(outbound);
    expect(ids).not.toContain("call_broken");
    expect(ids).toContain("call_sibling");
  }, 30000);
});