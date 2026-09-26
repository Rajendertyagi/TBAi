/**
 * Direct hardening — the trust boundary of POST /api/chat (the Direct engine).
 *
 * Every case here is written against the DESIRED contract and is expected to
 * be RED today; they describe what a hardened Direct request boundary must do,
 * not what it happens to do. They drive the REAL chat route (real Zod
 * validation, real run registry, real structured logger) and stand a CONTROLLED
 * OpenAI-compatible endpoint behind the seeded provider, so every assertion is
 * about the bytes that actually reach the provider or land in the log capture —
 * never about a request the test mirrored by hand.
 *
 * Covered:
 *   0. the message shape the browser transport ACTUALLY sends (a user turn with
 *      no per-message `metadata`) is admitted — the baseline every other case
 *      depends on, and the one that catches a validator which over-constrains
 *      the real envelope and 400s all live traffic;
 *   1. a persisted conversation `systemPrompt` reaches the provider as system
 *      content (`instructions` on the Responses API, a system-role message on
 *      Chat Completions) instead of being persisted and then silently dropped;
 *   2. a malformed UIMessage (missing `id` or `parts`) is a diagnosable 400,
 *      never a request forwarded to the provider;
 *   3. a non-empty client-supplied top-level `system` / `tools` directive is a
 *      400 — the server owns model policy and the tool set (approval gates,
 *      sandboxing); and the route keeps accepting the legitimate `id` routing
 *      field plus an ABSENT/empty directive, so the fix cannot be a blanket
 *      `.strict()`;
 *   4. a provider stream that emits a valid text delta and then fails is NOT
 *      reported as a successful chat run (run registry, with the structured
 *      `ai.response` / `ai.error` fields as the diagnostic cross-check), and it
 *      is not REPLAYED: once a chunk has been streamed, the generation is no
 *      longer retryable, so the controlled endpoint must see exactly one model
 *      request rather than a fresh billing/duplicate-output retry;
 *   5. a Direct log capture carries no raw prompt/system text, no provider
 *      endpoint URL, and no raw provider error message;
 *   6. a terminal finish reason outside the Direct success set (`other`), and a
 *      stream that ends with NO terminal reason at all, both settle the run as
 *      FAILED and never emit `ai.response` — a run the server cannot vouch for
 *      must not be reported as a completed generation;
 *   7. a client detach does not decide the run: a producer failure observed
 *      AFTER the browser disconnected settles the run (never leaves it
 *      `running`), and a producer that completes normally after a detach stays
 *      `completed`;
 *   8. an unusable tool-approval secret (the HMAC key that makes an approval id
 *      unforgeable) is a diagnosable 500 at the boundary — before the run
 *      registry is touched and before the model leg is called, with the
 *      offending row restored afterwards.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import type { SQLQueryBindings } from "bun:sqlite";
import { RESUMABLE_STREAM_ID_HEADER } from "assistant-stream/resumable";
import { logger, type LogEntry } from "../../src/lib/logger";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import { chatRuns } from "../../src/services/chat-runs";
// The durable finish reason is only readable from the store: no test in the repo
// read it before, and `/api/chat/stream-status` does not expose it.
import { chatStreamStore } from "../../src/lib/resumable";
import { credentialStore } from "../../src/services/credentials";
import chatApp from "../../src/routes/chat";

const app = new Hono();
app.route("/", chatApp);

const JSON_HEADERS = { "Content-Type": "application/json" };

// ── Markers ──────────────────────────────────────────────────────────────────
// Every value under test is a distinctive literal, so "it leaked" is
// unambiguous and a substring can never match incidentally.
const SYSTEM_PROMPT_MARKER = "DIRECT_HARDENING_SYSTEM_PROMPT_MARKER";
const USER_TEXT_MARKER = "DIRECT_HARDENING_USER_TEXT_MARKER";
const INJECTED_SYSTEM_MARKER = "DIRECT_HARDENING_INJECTED_SYSTEM_MARKER";
const PROVIDER_ERROR_MARKER = "DIRECT_HARDENING_PROVIDER_ERROR_MARKER";
/** A tool argument the native toolkit echoes back inside its failure text. */
const TOOL_ERROR_MARKER = "DIRECT_HARDENING_TOOL_ERROR_MARKER.txt";
/** The single text delta the controlled provider emits before it can fail. */
const CONTROLLED_TEXT_DELTA = "partial answer";
/** The reply body the `finish-reason-length` behavior returns, capped mid-word. */
const LENGTH_TRUNCATED_TEXT = "the provider stopped at its output cap";

// ── Controlled OpenAI-compatible provider ────────────────────────────────────
const PROVIDER_ID = "prov-direct-hardening";
const MODEL_ID = "void-model";

/**
 * How the controlled endpoint answers one model request.
 *
 * `gated-*` park after the first delta on {@link gate} so a test can detach the
 * client WHILE the producer is mid-stream — the only window in which "the
 * connection went away and the run kept going" is a real observation rather
 * than a race the test cannot reproduce.
 */
type StreamBehavior =
  | "complete"
  | "text-then-error"
  | "finish-reason-other"
  | "finish-reason-length"
  | "no-finish-reason"
  | "tool-call-then-complete"
  | "gated-then-error"
  | "gated-then-complete";
let behavior: StreamBehavior = "complete";
/** Release point for the `gated-*` behaviors; see {@link armGate}. */
let gate: { promise: Promise<void>; open: () => void } | null = null;

/** Arm the mid-stream gate and return the promise the provider parks on. */
function armGate(): Promise<void> {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  gate = { promise, open };
  return promise;
}

/**
 * Outbound request bodies captured by the CURRENT controlled endpoint. Rebound
 * per server and cleared in `afterEach`, so a request left in flight by an
 * earlier case can never be counted as (or blamed on) a later one.
 */
let captured: Array<{ path: string; body: Record<string, unknown> }> = [];
let controlled: ReturnType<typeof Bun.serve> | null = null;

function chatCompletionChunk(delta: unknown, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-direct-hardening",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** One OpenAI-compatible tool-call delta, complete in a single chunk. */
function toolCallChunk(
  toolName: string,
  args: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-direct-hardening",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call-direct-hardening-1",
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: finishReason,
      },
    ],
  })}\n\n`;
}

/**
 * The controlled Chat Completions response.
 *
 * `pull` (not `start`) drives the sequence so the text delta is genuinely
 * consumed before the stream is torn down: the default high-water mark is 1, so
 * the second pull only happens after the reader has taken the first chunk. That
 * is what makes "a valid text delta, THEN a failure" a real mid-stream failure
 * rather than a request that never produced anything.
 *
 * A tool call makes the AI SDK issue a FOLLOW-UP model request (the tool loop
 * continues after a tool error), so the tool-call behavior only applies to the
 * first request of a case; every later request completes normally.
 */
function controlledResponse(): Response {
  const encoder = new TextEncoder();
  let stage = 0;
  const requestNumber = captured.length;
  const answerNormally = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    controller.enqueue(encoder.encode(chatCompletionChunk({}, "stop")));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stage === 0) {
        stage = 1;
        if (behavior === "tool-call-then-complete" && requestNumber === 1) {
          controller.enqueue(
            encoder.encode(toolCallChunk("read_file", { path: TOOL_ERROR_MARKER }, "tool_calls")),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(
            chatCompletionChunk({ role: "assistant", content: CONTROLLED_TEXT_DELTA }),
          ),
        );
        return;
      }
      if (stage !== 1) return;
      stage = 2;
      if (behavior === "text-then-error") {
        controller.error(new Error(PROVIDER_ERROR_MARKER));
        return;
      }
      if (behavior === "finish-reason-other") {
        controller.enqueue(encoder.encode(chatCompletionChunk({}, "other")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      if (behavior === "finish-reason-length") {
        // A truncated-but-WELL-FORMED reply: the provider stopped because it hit
        // its output cap, which is a success with a caveat — not a failure. The
        // text is real and must survive; only the finish reason says "partial".
        controller.enqueue(
          encoder.encode(chatCompletionChunk({ content: LENGTH_TRUNCATED_TEXT }, "length")),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      if (behavior === "no-finish-reason") {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      if (behavior === "gated-then-error" || behavior === "gated-then-complete") {
        await gate?.promise;
        if (behavior === "gated-then-error") {
          controller.error(new Error(PROVIDER_ERROR_MARKER));
          return;
        }
        answerNormally(controller);
        return;
      }
      answerNormally(controller);
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function startControlledProvider(): string {
  captured = [];
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      captured.push({ path: url.pathname, body });
      return controlledResponse();
    },
  });
  controlled.unref();
  return `http://127.0.0.1:${controlled.port}`;
}

/**
 * Seed an `ollama`-typed provider: that type speaks the OpenAI-compatible
 * Chat Completions wire protocol (see services/ai.ts DEFAULT_PROTOCOL) and
 * needs no credential, so the model leg is exercised without a secret.
 */
async function seedControlledProvider(): Promise<string> {
  const endpoint = startControlledProvider();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'direct-hardening', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, endpoint, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
  return endpoint;
}

/** Tear the endpoint down so no request from this case outlives the case. */
function stopControlledProvider(): void {
  try {
    controlled?.stop(true);
  } catch {
    /* already closed */
  }
  controlled = null;
  captured = [];
  gate = null;
}

afterAll(async () => {
  stopControlledProvider();
  db.run("DELETE FROM provider_configs WHERE id = ?", [PROVIDER_ID]);
  await registry.loadFromDb(db);
});

// ── Approval-secret setting row (case 8) ─────────────────────────────────────
/**
 * Mirrors the production setting key (kept private by the store), so the case
 * addresses the row exactly as the store does. A rename surfaces as a failing
 * case rather than a silent "row not found".
 */
const TOOL_APPROVAL_SECRET_SETTING_KEY = "security.tool_approval_secret";
/** Not a decryptable envelope: the store must refuse it, never regenerate it. */
const CORRUPTED_APPROVAL_SECRET = "not-an-encrypted-envelope";

interface ApprovalSecretRow {
  value: string;
  updated_at: number;
}

function readApprovalSecretRow(): ApprovalSecretRow | undefined {
  return (
    db
      .query<ApprovalSecretRow, SQLQueryBindings[]>(
        "SELECT value, updated_at FROM app_settings WHERE key = ?",
      )
      .get(TOOL_APPROVAL_SECRET_SETTING_KEY) ?? undefined
  );
}

function writeApprovalSecretRow(row: ApprovalSecretRow): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [TOOL_APPROVAL_SECRET_SETTING_KEY, row.value, row.updated_at],
  );
}

/**
 * Pre-case snapshot, restored in `afterEach`: the suite shares one SQLite file
 * with every other credential/approval test in the process, so the row is left
 * byte-identical (value AND updated_at) to how it was found.
 */
let approvalSecretSnapshot: ApprovalSecretRow | null = null;

function snapshotApprovalSecretRow(): void {
  approvalSecretSnapshot = readApprovalSecretRow() ?? null;
}

/**
 * Put the row back exactly as the snapshot found it. A case that never took a
 * snapshot is a no-op: the singleton store materializes the row on first use,
 * so "no snapshot" means the row is not this file's to restore.
 */
function restoreApprovalSecretRow(): void {
  if (approvalSecretSnapshot === null) return;
  if (approvalSecretSnapshot) {
    writeApprovalSecretRow(approvalSecretSnapshot);
  } else {
    db.run("DELETE FROM app_settings WHERE key = ?", [TOOL_APPROVAL_SECRET_SETTING_KEY]);
  }
  approvalSecretSnapshot = null;
}

// ── Per-test isolation ───────────────────────────────────────────────────────
beforeEach(() => {
  captured = [];
  behavior = "complete";
  gate = null;
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});
afterEach(() => {
  restoreApprovalSecretRow();
  stopControlledProvider();
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A well-formed UIMessage, exactly as the assistant-ui runtime sends it. */
function userMessage(text: string): Record<string, unknown> {
  return { id: "msg-user-1", role: "user", parts: [{ type: "text", text }] };
}

async function createDirectConversation(overrides: {
  title: string;
  systemPrompt?: string | null;
}): Promise<string> {
  const conv = await conversationService.create({
    title: overrides.title,
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    reasoningLevel: null,
    systemPrompt: overrides.systemPrompt ?? null,
    engine: "direct",
  });
  return conv.id;
}

async function postChat(body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/chat", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Fully consume the UI message stream so the run reaches a terminal state. */
async function drain(res: Response): Promise<string> {
  return res.text();
}

function streamIdOf(res: Response): string {
  const id = res.headers.get(RESUMABLE_STREAM_ID_HEADER);
  if (!id) throw new Error("response carried no resumable stream id");
  return id;
}

/**
 * Total number of run records the registry currently holds, across every
 * status. Compared before/after a request that must not mint a run: the counts
 * are summed rather than read per status because records left by earlier cases
 * can settle asynchronously, and only the TOTAL is invariant to that.
 */
function totalRunCount(): number {
  const counts = chatRuns.counts();
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/** UI message stream parts (the `data:` payloads), decoded. */
function uiStreamParts(text: string): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice("data:".length).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      parts.push(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      /* non-JSON frame — not a part we assert on */
    }
  }
  return parts;
}

function hasUiErrorPart(text: string): boolean {
  return uiStreamParts(text).some((p) => p.type === "error");
}

/**
 * Every string the outbound provider request carries in system position:
 * `instructions` (Responses API) or a system-role message (Chat Completions).
 * Either wire spelling satisfies the contract — what must not happen is the
 * system prompt simply never arriving.
 */
function systemContentOf(body: Record<string, unknown>): string {
  const out: string[] = [];
  if (typeof body.instructions === "string") out.push(body.instructions);
  if (Array.isArray(body.messages)) {
    for (const entry of body.messages) {
      if (!entry || typeof entry !== "object") continue;
      const msg = entry as { role?: unknown; content?: unknown };
      if (msg.role !== "system") continue;
      if (typeof msg.content === "string") {
        out.push(msg.content);
        continue;
      }
      if (Array.isArray(msg.content)) {
        for (const piece of msg.content) {
          const text = (piece as { text?: unknown } | null)?.text;
          if (typeof text === "string") out.push(text);
        }
      }
    }
  }
  return out.join("\n");
}

function logEntriesSince(since: number): LogEntry[] {
  return logger.getRecentEntries(since);
}

/** Flatten an entry to one searchable string (every field, as text). */
function renderEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

/** Poll a condition the server reaches on its own; fails loudly on timeout. */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Await the run's own settlement signal and return its final status. Bounded so
 * a run that never settles fails the case instead of hanging the suite — the
 * registry's `settled` promise IS the production settlement signal, so waiting
 * on it observes the real transition rather than polling a guess.
 */
async function awaitRunSettled(streamId: string, timeoutMs = 10000): Promise<string> {
  const record = chatRuns.get(streamId);
  if (!record) throw new Error(`no run record for ${streamId}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  (timer as unknown as { unref?: () => void }).unref?.();
  const winner = await Promise.race([record.settled.then(() => "settled" as const), bound]);
  if (timer) clearTimeout(timer);
  if (winner !== "settled") throw new Error(`run ${streamId} never settled`);
  return chatRuns.get(streamId)?.status ?? "missing";
}

// ── 0. The message shape the browser actually sends ──────────────────────────
describe("Direct request — browser transport contract", () => {
  it("accepts a user turn with no per-message metadata, exactly as the transport sends it", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({ title: "direct-hardening-browser" });

    try {
      // `AssistantChatTransport` posts `messages: options.messages` VERBATIM
      // (node_modules/@assistant-ui/ai-sdk .../AssistantChatTransport.js:58)
      // and web/src/runtime.ts forwards `messages` unchanged
      // (web/src/runtime.ts:326-336). A fresh user turn therefore arrives with
      // NO `metadata` field: the AI SDK only attaches `metadata` to messages
      // that came back from a `message-metadata` stream part, and an optimistic
      // user message never has one.
      //
      // Passing a `metadataSchema` to `safeValidateUIMessages` makes the absent
      // key fail validation (`expected record, received undefined`), so the
      // route must treat message metadata as optional to admit real traffic.
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });

      expect(res.status).toBe(200);
      await drain(res);
      expect(captured.length).toBe(1);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 1. The persisted conversation system prompt reaches the provider ──────────
describe("Direct request — conversation systemPrompt delivery", () => {
  it("sends the persisted conversation systemPrompt to the provider as system content", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({
      title: "direct-hardening-system-prompt",
      systemPrompt: `${SYSTEM_PROMPT_MARKER}: answer as a terse pirate.`,
    });

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      await drain(res);

      // The model leg actually ran against the controlled endpoint...
      expect(captured.length).toBe(1);
      // ...and the system prompt was carried in system position on the wire.
      const outbound = captured[0].body;
      expect(systemContentOf(outbound)).toContain(SYSTEM_PROMPT_MARKER);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 2. Malformed UIMessages are rejected at the boundary ─────────────────────
describe("Direct request — UIMessage validation", () => {
  it("rejects 400 a message with no id and no parts, and never calls the provider", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({ title: "direct-hardening-no-id" });

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [{ role: "user" }],
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string; issues?: unknown };
      expect(typeof body.error).toBe("string");
      expect(body.error?.length).toBeGreaterThan(0);
      // A malformed envelope must never reach the model leg.
      expect(captured.length).toBe(0);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("rejects 400 a message with an id but no parts, and never calls the provider", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({ title: "direct-hardening-no-parts" });

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [{ id: "msg-user-1", role: "user" }],
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
      expect(captured.length).toBe(0);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("rejects 400 a message whose text part carries no text", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({ title: "direct-hardening-bad-part" });

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [
          { id: "msg-user-1", role: "user", parts: [{ type: "text" }] },
        ],
      });

      expect(res.status).toBe(400);
      expect(captured.length).toBe(0);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 3. Client-supplied model policy / tool directives are refused ────────────
describe("Direct request — client-owned directives are refused", () => {
  it("rejects 400 a non-empty top-level `system` directive", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({ title: "direct-hardening-system" });

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        system: INJECTED_SYSTEM_MARKER,
        messages: [userMessage(USER_TEXT_MARKER)],
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
      // The server owns model policy: an injected system prompt is never
      // forwarded, not even on a best-effort basis.
      expect(captured.length).toBe(0);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("rejects 400 a non-empty top-level `tools` directive", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({ title: "direct-hardening-tools" });

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        tools: [{ type: "function", function: { name: "read_file" } }],
        messages: [userMessage(USER_TEXT_MARKER)],
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
      // The tool set is server-owned (approval gates + workspace sandbox), so a
      // client-supplied tool list must never reach the model.
      expect(captured.length).toBe(0);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("still accepts the legitimate `id` routing field and an empty `system`", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({ title: "direct-hardening-empty" });

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        system: "",
        messages: [userMessage(USER_TEXT_MARKER)],
      });

      // Guard against an over-broad fix: the refusal is for NON-EMPTY
      // directives only, and `id` is the conversation routing field the
      // assistant-ui runtime always sends.
      expect(res.status).toBe(200);
      await drain(res);
      expect(captured.length).toBe(1);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 4. A text delta followed by a failure is not a successful run ─────────────
describe("Direct run settlement — valid delta then a provider failure", () => {
  it("settles the run as failed (not completed), logs the failure, and never replays started output", async () => {
    await seedControlledProvider();
    behavior = "text-then-error";
    const conversationId = await createDirectConversation({ title: "direct-hardening-midfail" });
    const since = logger.lastSeq;

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      const streamId = streamIdOf(res);
      const body = await drain(res);

      // Precondition: the controlled endpoint WAS reached and it DID serve a
      // valid text delta before tearing the stream down. Loosely asserted here
      // so the policy assertion below is the one that reports a replay.
      expect(captured.length).toBeGreaterThanOrEqual(1);
      // ...and the run then terminated with a UI error, which is what makes
      // this a failed run rather than a successful one.
      expect(hasUiErrorPart(body)).toBe(true);

      // The run registry is inspectable, so assert the authoritative state: a
      // run whose UI stream ended in an error was never a successful chat run.
      const record = chatRuns.get(streamId);
      expect(record).toBeDefined();
      expect(record?.status).not.toBe("completed");
      expect(record?.status).toBe("failed");

      // Structured cross-check: the AI funnel reported the failure with a
      // category, and no success line claimed the run finished normally.
      const entries = logEntriesSince(since);
      const errors = entries.filter((e) => e.event === "ai.error");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => typeof e.category === "string" && e.category.length > 0)).toBe(
        true,
      );
      expect(entries.filter((e) => e.event === "ai.response").length).toBe(0);
      // The delta really did land before the failure (evidence the case is
      // "valid text, THEN an error" and not a request that never started).
      expect(entries.some((e) => e.event === "stream_first_chunk")).toBe(true);

      // ── Desired Direct policy: no replay of already-started output ──────
      // Once the provider has emitted a chunk, the generation is no longer
      // retryable: the run has already put bytes in front of the user, so
      // re-issuing the model request would bill the provider again and can
      // duplicate text that was already streamed. The Direct server owns that
      // decision, so a started stream must fail ONCE, not be retried into a
      // second (or third) request to the same conversation.
      expect(captured.length).toBe(1);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 5. Direct log hygiene ────────────────────────────────────────────────────
describe("Direct log hygiene", () => {
  it("records no raw prompt or system text in the Direct log capture", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({
      title: "direct-hardening-logs-text",
      systemPrompt: SYSTEM_PROMPT_MARKER,
    });
    const since = logger.lastSeq;

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      await drain(res);

      const rendered = logEntriesSince(since).map(renderEntry).join("\n");
      expect(rendered).not.toContain(SYSTEM_PROMPT_MARKER);
      expect(rendered).not.toContain(USER_TEXT_MARKER);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("records no provider endpoint URL in the Direct log capture", async () => {
    const endpoint = await seedControlledProvider();
    const conversationId = await createDirectConversation({
      title: "direct-hardening-logs-endpoint",
    });
    const since = logger.lastSeq;

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      await drain(res);

      // Endpoint URLs are deployment detail: a log capture (ring, file, the
      // in-app Logs panel) must not become a map of every provider address.
      const rendered = logEntriesSince(since).map(renderEntry).join("\n");
      expect(rendered).not.toContain(endpoint);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("records no raw provider error message in the Direct log capture", async () => {
    await seedControlledProvider();
    behavior = "text-then-error";
    const conversationId = await createDirectConversation({
      title: "direct-hardening-logs-error",
    });
    const since = logger.lastSeq;

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      await drain(res);

      // The failure is reported by category/type, never by echoing the
      // provider's own error text back into the log.
      const rendered = logEntriesSince(since).map(renderEntry).join("\n");
      expect(rendered).not.toContain(PROVIDER_ERROR_MARKER);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 6. Only a trustworthy terminal finish reason counts as success ───────────
// A generation the server cannot vouch for must be a FAILED run: the UI shows a
// retry affordance, the run registry agrees, and no `ai.response` line ever
// claims the answer completed. Anything outside the Direct success set —
// `other`, or a stream that ends with no terminal reason at all — is such a
// case, and neither may be reported as a successful chat run.
describe("Direct run settlement — non-success terminal finish reason", () => {
  it("settles failed and emits no ai.response when the provider ends with finish_reason 'other'", async () => {
    await seedControlledProvider();
    behavior = "finish-reason-other";
    const conversationId = await createDirectConversation({
      title: "direct-hardening-finish-other",
    });
    const since = logger.lastSeq;

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      const streamId = streamIdOf(res);
      await drain(res);

      // Precondition: the controlled endpoint really was driven to that
      // terminal reason (exactly one model request, no retry of started text).
      expect(captured.length).toBe(1);

      // Authoritative state: not a completed run.
      const record = chatRuns.get(streamId);
      expect(record).toBeDefined();
      expect(record?.status).not.toBe("completed");
      expect(record?.status).toBe("failed");

      // Structured cross-check: the failure was reported with a category and
      // no success line was emitted.
      const entries = logEntriesSince(since);
      expect(entries.filter((e) => e.event === "ai.response").length).toBe(0);
      const errors = entries.filter((e) => e.event === "ai.error");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => typeof e.category === "string" && e.category.length > 0)).toBe(
        true,
      );
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("settles COMPLETED and preserves 'length' — a capped reply is a success, not a failure", async () => {
    // The acceptance criterion "valid `length` stream → `length` is preserved".
    // The allowlist has always contained `length`, but nothing ever emitted it, so
    // this was unproven: a regression that coerced `length` to `stop` or `failed`
    // would have passed every other case in this file.
    await seedControlledProvider();
    behavior = "finish-reason-length";
    const conversationId = await createDirectConversation({
      title: "direct-hardening-finish-length",
    });
    const since = logger.lastSeq;

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      const streamId = streamIdOf(res);
      const body = await drain(res);

      // Precondition: the provider really terminated with `length`, and the run
      // was not retried (Direct output is not replay-safe after the first chunk).
      expect(captured.length).toBe(1);
      // The capped text reached the client — a `length` run is still a real reply.
      expect(body).toContain(LENGTH_TRUNCATED_TEXT);

      // Authoritative state: completed, the opposite of the `other` case above.
      const record = chatRuns.get(streamId);
      expect(record?.status).toBe("completed");

      // The reason is reported as itself, not collapsed to `stop`.
      const responses = logEntriesSince(since).filter((e) => e.event === "ai.response");
      expect(responses.length).toBe(1);
      expect(responses[0].finishReason).toBe("length");

      // And it survives into the durable row, so a resumed/reloaded client reads
      // the same reason rather than a synthesised success.
      const durable = chatStreamStore.describe(streamId);
      expect(durable.status).toBe("done");
      expect(durable.finishReason).toBe("length");
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("settles failed and emits no ai.response when the stream ends with no terminal finish reason", async () => {
    await seedControlledProvider();
    behavior = "no-finish-reason";
    const conversationId = await createDirectConversation({
      title: "direct-hardening-no-finish-reason",
    });
    const since = logger.lastSeq;

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      const streamId = streamIdOf(res);
      await drain(res);

      // Precondition: the endpoint served a valid text delta and then closed
      // the stream with no terminal reason at all, so "truncated" is the only
      // honest description of the generation.
      expect(captured.length).toBe(1);
      const record = chatRuns.get(streamId);
      expect(record?.status).toBe("failed");

      const entries = logEntriesSince(since);
      expect(entries.filter((e) => e.event === "ai.response").length).toBe(0);
      const errors = entries.filter((e) => e.event === "ai.error");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => typeof e.category === "string" && e.category.length > 0)).toBe(
        true,
      );
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 7. A client detach does not decide the run outcome ───────────────────────
// The browser connection and the AI run have independent lifetimes. So the
// producer's own outcome decides settlement — even when it is observed only
// after the client went away. A run that fails after a detach must NOT be left
// `running` (a leak the user can never see or stop), and a run that completes
// after a detach must not be downgraded to cancelled.
describe("Direct run settlement — client detach", () => {
  it("settles failed (never left running) when the producer fails after the client detached", async () => {
    await seedControlledProvider();
    armGate();
    behavior = "gated-then-error";
    const conversationId = await createDirectConversation({
      title: "direct-hardening-detach-fail",
    });
    const since = logger.lastSeq;

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      const streamId = streamIdOf(res);

      // The producer is genuinely mid-stream (it served a delta and is parked
      // on the gate) before the connection goes away.
      await waitFor(() => captured.length >= 1, "the provider request");
      await res.body!.cancel();
      await waitFor(
        () => chatRuns.get(streamId)?.detachedAt !== null,
        "the run's detached mark",
      );
      expect(chatRuns.get(streamId)?.status).toBe("running");

      // Now let the producer fail: the failure is observed only after detach.
      gate?.open();
      expect(await awaitRunSettled(streamId)).toBe("failed");
      expect(chatRuns.get(streamId)?.status).not.toBe("running");

      const entries = logEntriesSince(since);
      expect(entries.filter((e) => e.event === "ai.response").length).toBe(0);
      expect(entries.some((e) => e.event === "ai.error")).toBe(true);
    } finally {
      gate = null;
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("keeps a detached run completed when the producer finishes normally afterwards", async () => {
    await seedControlledProvider();
    armGate();
    behavior = "gated-then-complete";
    const conversationId = await createDirectConversation({
      title: "direct-hardening-detach-complete",
    });
    const since = logger.lastSeq;

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      const streamId = streamIdOf(res);

      await waitFor(() => captured.length >= 1, "the provider request");
      await res.body!.cancel();
      await waitFor(
        () => chatRuns.get(streamId)?.detachedAt !== null,
        "the run's detached mark",
      );
      expect(chatRuns.get(streamId)?.status).toBe("running");

      gate?.open();
      expect(await awaitRunSettled(streamId)).toBe("completed");

      // A disconnect is a transport observation, never a run outcome: the
      // success line is still emitted, with the completed outcome.
      const responses = logEntriesSince(since).filter((e) => e.event === "ai.response");
      expect(responses.length).toBe(1);
      expect(responses[0].outcome).toBe("completed");
      expect(responses[0].runStatus).toBe("completed");
    } finally {
      gate = null;
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 8. An unusable tool-approval secret stops the request at the boundary ─────
// The approval secret is the per-install HMAC key that makes a tool-approval id
// unforgeable. If it cannot be read, the request must NOT proceed: minting
// approvals under a broken key would produce ids nobody can verify, and calling
// the model first would bill a turn that can never be approved. The credential
// store fails closed by design (see approval-secret-integrity.test.ts), so the
// route's job is to answer 500 — before the run registry is touched and before
// the provider leg runs.
describe("Direct request — unusable tool-approval secret", () => {
  it("answers 500, never calls the provider, and creates no run when the approval secret row is corrupted", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({
      title: "direct-hardening-approval-secret",
    });
    // Materialize the row through the REAL singleton the route uses (and prove
    // it works), then snapshot it so afterEach leaves the install untouched.
    expect(credentialStore.getToolApprovalSecret().length).toBeGreaterThan(0);
    snapshotApprovalSecretRow();
    const runsBefore = totalRunCount();
    const since = logger.lastSeq;

    try {
      // The row survives but can no longer be decrypted (bit rot, a truncated
      // write, a value written under another key).
      db.run("UPDATE app_settings SET value = ? WHERE key = ?", [
        CORRUPTED_APPROVAL_SECRET,
        TOOL_APPROVAL_SECRET_SETTING_KEY,
      ]);

      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });

      expect(res.status).toBe(500);
      const raw = await res.text();
      const body = JSON.parse(raw) as { error?: string; requestId?: string };

      // Diagnosable to the user, sanitized at the boundary: the corrupt value
      // and the internal credential message never reach the client.
      expect(typeof body.error).toBe("string");
      expect(body.error?.length).toBeGreaterThan(0);
      expect(raw).not.toContain(CORRUPTED_APPROVAL_SECRET);
      expect(raw).not.toContain("data may be corrupted");
      expect(typeof body.requestId).toBe("string");

      // The model leg never ran: no turn is billed for a request that could
      // never have been approved.
      expect(captured.length).toBe(0);

      // No run was minted. The registry is server-owned state the Logs panel,
      // the cancel endpoint and the resume endpoint all read, so a run created
      // for a request that never executed would be a phantom "running" record
      // the user can see but never stop.
      expect(res.headers.get(RESUMABLE_STREAM_ID_HEADER)).toBeNull();
      expect(totalRunCount()).toBe(runsBefore);

      // The failure is diagnosable locally: the credential funnel recorded it
      // with classification fields (not the corrupt value), and the run was
      // never admitted to the AI funnel at all.
      const entries = logEntriesSince(since);
      const credentialErrors = entries.filter((e) => e.event === "credential.error");
      expect(credentialErrors.length).toBeGreaterThan(0);
      expect(typeof credentialErrors[0].category).toBe("string");
      expect(JSON.stringify(entries)).not.toContain(CORRUPTED_APPROVAL_SECRET);
      expect(entries.some((e) => e.event === "ai.error")).toBe(false);
      expect(entries.some((e) => e.event === "ai.request")).toBe(false);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("answers 500 with no run and no provider call when the approval secret row is deleted outright", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({
      title: "direct-hardening-approval-secret-deleted",
    });
    expect(credentialStore.getToolApprovalSecret().length).toBeGreaterThan(0);
    snapshotApprovalSecretRow();
    const runsBefore = totalRunCount();
    const since = logger.lastSeq;

    try {
      // The row disappears underneath a live process (a restore that lost it, a
      // hand-edited DB, a migration that dropped it).
      db.run("DELETE FROM app_settings WHERE key = ?", [TOOL_APPROVAL_SECRET_SETTING_KEY]);

      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
      expect(body.error?.length).toBeGreaterThan(0);

      // Fails closed rather than silently regenerating a secret: no provider
      // call, no run, and — critically — the row was NOT re-created behind the
      // operator's back (the delete is the evidence something went wrong).
      expect(captured.length).toBe(0);
      expect(res.headers.get(RESUMABLE_STREAM_ID_HEADER)).toBeNull();
      expect(totalRunCount()).toBe(runsBefore);
      expect(readApprovalSecretRow()).toBeUndefined();
      expect(logEntriesSince(since).some((e) => e.event === "credential.error")).toBe(true);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("restores the approval secret for a later request, so the boundary is recoverable", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation({
      title: "direct-hardening-approval-secret-recovery",
    });
    expect(credentialStore.getToolApprovalSecret().length).toBeGreaterThan(0);
    snapshotApprovalSecretRow();

    // Read the live row BEFORE disturbing it: that exact value is what a
    // restore puts back, and re-deriving it later would make this case pass
    // even if the store had minted a different secret.
    const persisted = readApprovalSecretRow();
    expect(persisted).toBeDefined();

    try {
      db.run("DELETE FROM app_settings WHERE key = ?", [TOOL_APPROVAL_SECRET_SETTING_KEY]);
      const rejected = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(rejected.status).toBe(500);
      expect(captured.length).toBe(0);

      // The row comes back with its original value: the SAME long-lived store
      // serves traffic again, so a transient fault is a 500, not an outage.
      writeApprovalSecretRow(persisted!);
      const accepted = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(accepted.status).toBe(200);
      await drain(accepted);
      expect(captured.length).toBe(1);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});
