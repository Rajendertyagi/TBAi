/**
 * Fix B — the duplicate `streamWriter` binding.
 *
 * The route builds the terminal batcher BEFORE assembly (assembly wires the tap into
 * `run_command`), so its sink has to reach the writer the stream phase installs later.
 * The extraction gave each phase its OWN `streamWriter` variable: the route captured a
 * binding nothing ever assigned, so every `data-tbai-terminal` part was dropped in
 * silence. Terminal output from `run_command` never reached the client.
 *
 * This drives a REAL `POST /api/chat` against a stub provider that emits a genuine
 * `run_command` call, answers the approval gate the way the client does, lets the tool
 * ACTUALLY execute a shell command, and asserts its output arrives as
 * `data-tbai-terminal` parts.
 *
 * The approval round-trip is not incidental: `run_command` is `"user-approval"` in the
 * route, so a single request never executes anything. The existing `terminal-wiring`
 * unit tests cover the batcher and the tap in isolation and never make this assertion —
 * which is exactly why the defect survived a green overflow suite. Overflow recovery
 * does not invoke `run_command` at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { db } from "@/db";
import { registry } from "@/config/providers.ts";
import { conversationService } from "@/services/storage";
import chatApp from "@/routes/chat.ts";
import { conversationInput } from "../../helpers/conversation-fixtures";

const app = new Hono();
app.route("/", chatApp);

const JSON_HEADERS = { "Content-Type": "application/json" };
const PROVIDER_ID = "prov-terminal-delivery";
const MODEL_ID = "terminal-model";
const PROOF = "TERMINAL_DELIVERY_PROOF";
const TOOL_CALL_ID = "call_terminal_1";

let controlled: ReturnType<typeof Bun.serve> | null = null;
let upstreamCalls = 0;

function sse(rows: unknown[]): Response {
  return new Response(
    [...rows.map((r) => `data: ${JSON.stringify(r)}\n\n`), "data: [DONE]\n\n"].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

/**
 * A streamed assistant tool call, the shape a real OpenAI-compatible endpoint emits.
 *
 * Two frames, not one: the call carries `finish_reason: null` and a SEPARATE empty-delta
 * frame carries `finish_reason: "tool_calls"`. Folding the finish onto the call frame
 * makes the SDK see a finished stream with nothing in it — a 200 with no tool executed.
 */
function toolCallFrames(): unknown[] {
  return [
    {
      id: "chatcmpl-tool",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: TOOL_CALL_ID,
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify({ command: `Write-Output ${PROOF}` }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-tool",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

function textFrames(content: string): unknown[] {
  return [
    {
      id: "chatcmpl-text",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    {
      id: "chatcmpl-text",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}

async function seed(): Promise<void> {
  upstreamCalls = 0;
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      upstreamCalls += 1;
      // Attempt 1 asks for the tool; every later call is the post-tool answer.
      if (upstreamCalls === 1) return sse(toolCallFrames());
      return sse(textFrames("done"));
    },
  });
  controlled.unref();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'terminal-delivery', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, `http://127.0.0.1:${controlled.port}/v1`, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
}

const userMsg = (text: string) => ({ id: "u1", role: "user", parts: [{ type: "text", text }] });

/** Pull the approval request the gate emitted out of an SSE body. */
function approvalFrom(body: string): { approvalId: string; signature?: string } {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (parsed.type === "tool-approval-request") {
      return parsed as unknown as { approvalId: string; signature?: string };
    }
  }
  throw new Error(`no tool-approval-request in stream: ${body.slice(0, 600)}`);
}

async function postChat(id: string, messages: unknown[]): Promise<string> {
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ providerId: PROVIDER_ID, model: MODEL_ID, id, messages }),
  });
  return res.text();
}

beforeAll(seed);
afterEach(async () => {
  controlled?.stop(true);
  controlled = null;
  await registry.loadFromDb(db);
});
afterAll(async () => {
  db.run("DELETE FROM provider_configs WHERE id = ?", [PROVIDER_ID]);
  await registry.loadFromDb(db);
});

describe("TERMINAL DELIVERY: run_command output reaches the client stream", () => {
  it("emits data-tbai-terminal parts carrying the command's real output", async () => {
    await seed();
    const conv = await conversationService.create(
      conversationInput({
        title: "terminal-delivery",
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        reasoningLevel: null,
        systemPrompt: null,
        engine: "direct",
      }),
    );

    // Turn 1: the gate holds `run_command` for approval and executes nothing.
    const first = await postChat(conv.id, [userMsg("run the command")]);
    const approval = approvalFrom(first);
    expect(approval.approvalId).toBeTruthy();

    // Turn 2: the client approves, exactly as the runtime does.
    const approved = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-run_command",
          toolCallId: TOOL_CALL_ID,
          input: { command: `Write-Output ${PROOF}` },
          state: "approval-responded",
          approval: { id: approval.approvalId, approved: true, signature: approval.signature },
        },
      ],
    };
    const second = await postChat(conv.id, [userMsg("run the command"), approved]);

    // The tool really ran: turn 1 asked for it, and turn 2's provider call only happens
    // AFTER the tool result was appended. Two calls is the full round trip.
    expect(upstreamCalls).toBeGreaterThanOrEqual(2);

    // THE ASSERTION. Before the fix the route's sink closed over a binding nothing ever
    // assigned, so terminal parts were dropped even though the tool executed and the
    // phase flushed its own writer.
    expect((second.match(/data-tbai-terminal/g) ?? []).length).toBeGreaterThan(0);
    expect(second).toContain(PROOF);
  });
});