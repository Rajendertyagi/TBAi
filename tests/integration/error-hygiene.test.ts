/**
 * Raw error hygiene — the three sinks a provider/tool error must never reach.
 *
 * A marked failure is driven through the REAL surfaces and then looked for in
 * every place raw error text could escape:
 *   1. the structured log capture (the ring the Logs panel, the file sink and
 *      every dashboard read);
 *   2. the JSON error body a client receives — the global Hono error JSON for an
 *      unhandled throw, and the route's own sanitized JSON elsewhere;
 *   3. `console.error` / `console.warn`, which is where the structured logger
 *      writes and therefore what lands in a terminal or a service log.
 *
 * Every marker is a distinctive literal that redaction does NOT scrub (no
 * `sk-`/`Bearer`-shaped value, no sensitive key name), so "it leaked" is
 * unambiguous and a missing marker can never be explained away as redaction.
 * Each case also asserts the failure REALLY happened, so the marker had
 * something to leak into.
 *
 * Covered:
 *   - the real Direct route with a provider stream that fails mid-stream after
 *     a valid text delta (marked provider error);
 *   - the real Direct route with a native tool call that fails (marked tool
 *     error) — the tool loop then completes normally;
 *   - a real provider route (`POST /api/providers/test`) against a controlled
 *     endpoint that answers discovery with a marked 500 body;
 *   - the global Hono error JSON, driven through the PRODUCTION error handler
 *     registered by `src/routes/index.ts`;
 *   - the Direct route against a provider that answers with real HTTP status
 *     semantics (429, 503), pinning the `ai.error` taxonomy the failure must
 *     retain and the category-matched copy the user sees.
 *
 * The status-semantics cases are also the regression guard for the AI SDK's
 * `streamText.onError({ error })` event shape: the handler receives an EVENT,
 * and classifying the event instead of `event.error` would silently collapse
 * every classification field (`category`, `statusCode`, `retryable`,
 * `errorType`) to `unknown`/`undefined`/`false`/`object` while still looking
 * like a logged failure. They additionally pin that ONE producer failure
 * produces EXACTLY ONE canonical `ai.error` — the resumable layer beneath the
 * route must not add a second entry for the same failure.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { logger, type LogEntry } from "../../src/lib/logger";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import { chatRuns } from "../../src/services/chat-runs";
import { sanitizeStreamError } from "../../src/lib/redact";
import { RESUMABLE_STREAM_ID_HEADER } from "assistant-stream/resumable";

// The composition root: real middleware, real feature mounts, real global
// error handler. Imported the way logs-settings.test.ts does it — the module is
// only needed once a case actually drives traffic.
const app = (await import("../../src/routes/index")).default;

const JSON_HEADERS = { "Content-Type": "application/json" };

// ── Markers ──────────────────────────────────────────────────────────────────
/**
 * Deliberately un-redactable: no `sk-`/`AIza`/`xox`/`Bearer` value shape and no
 * sensitive field name, so the logger's defensive redaction cannot silently
 * absorb a leak and make the case pass for the wrong reason.
 */
const PROVIDER_ERROR_MARKER = "RAWERRORHYGIENEMARKER4c19b7";
const TOOL_ERROR_MARKER = "RAWTOOLHYGIENEMARKER8e2a1f.txt";
const GLOBAL_ERROR_MARKER = "RAWGLOBALHYGIENEMARKER5d7c3e";
const USER_TEXT_MARKER = "RAWERRORHYGIENE_USER_TEXT";
/** Markers carried by the HTTP status-semantics failures (429 / 503 bodies). */
const RATE_LIMIT_MARKER = "RAWHYGIENERATEMARKER6f1d2a";
const UNAVAILABLE_MARKER = "RAWHYGIENEUNAVAILABLEMARKERb4c8e0";

// ── Controlled OpenAI-compatible provider ────────────────────────────────────
const PROVIDER_ID = "prov-error-hygiene";
const MODEL_ID = "void-model";

type StatusFailureBehavior = "http-rate-limited" | "http-unavailable";

type StreamBehavior = "text-then-error" | "tool-call-then-complete" | StatusFailureBehavior;
let behavior: StreamBehavior = "text-then-error";

/**
 * The status-semantics legs the controlled endpoint serves instead of a stream.
 *
 * `category` is what the AI funnel must classify the failure as once the
 * status is known, and it is asserted verbatim so a widening (or a collapse) of
 * the taxonomy surfaces here. `retryable` is asserted too: both statuses are
 * retryable, and a mis-shaped error reports `false`.
 *
 * The `message` doubles as the raw-error marker and is deliberately worded so
 * the ONLY thing that can classify these failures is the HTTP status itself —
 * no other rule in the taxonomy matches it, so "the status was lost" cannot be
 * mistaken for "another rule happened to agree".
 */
const STATUS_FAILURES: Record<
  StatusFailureBehavior,
  { status: number; message: string; category: string; retryable: boolean }
> = {
  "http-rate-limited": {
    status: 429,
    message: `slow down: too many requests (${RATE_LIMIT_MARKER})`,
    category: "rate_limit",
    retryable: true,
  },
  "http-unavailable": {
    status: 503,
    message: `upstream temporarily unavailable (${UNAVAILABLE_MARKER})`,
    category: "provider",
    retryable: true,
  },
};

let captured: string[] = [];
let controlled: ReturnType<typeof Bun.serve> | null = null;

function chatCompletionChunk(delta: unknown, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-error-hygiene",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function toolCallChunk(
  toolName: string,
  args: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-error-hygiene",
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
              id: "call-error-hygiene-1",
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
 * One controlled endpoint serving every leg:
 *   - `POST /chat/completions` — the model stream (a mid-stream failure, a tool
 *     call followed by a normal completion, or a real HTTP status failure);
 *   - `GET /models` — model discovery, answered with a marked 500 body so the
 *     provider route's raw error text is the marker itself.
 */
function controlledResponse(pathname: string, requestNumber: number): Response {
  if (pathname.endsWith("/models")) {
    return new Response(`upstream exploded: ${PROVIDER_ERROR_MARKER}`, { status: 500 });
  }
  // A status-semantics failure: the model leg never starts, so the SDK throws
  // the provider's API error (a real `Error` carrying `statusCode`) instead of
  // a mid-stream transport fault.
  const statusFailure = STATUS_FAILURES[behavior as StatusFailureBehavior];
  if (statusFailure) {
    return new Response(
      JSON.stringify({ error: { message: statusFailure.message, type: "server_error" } }),
      { status: statusFailure.status, headers: { "Content-Type": "application/json" } },
    );
  }
  const encoder = new TextEncoder();
  let stage = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 0) {
        stage = 1;
        // A tool call makes the AI SDK issue a follow-up model request, so only
        // the first request of the case answers with the call.
        if (behavior === "tool-call-then-complete" && requestNumber === 1) {
          controller.enqueue(
            encoder.encode(
              toolCallChunk("read_file", { path: TOOL_ERROR_MARKER }, "tool_calls"),
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(chatCompletionChunk({ role: "assistant", content: "partial answer" })),
        );
        return;
      }
      if (stage !== 1) return;
      stage = 2;
      if (behavior === "text-then-error") {
        controller.error(new Error(PROVIDER_ERROR_MARKER));
        return;
      }
      controller.enqueue(encoder.encode(chatCompletionChunk({}, "stop")));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
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
      // Drain the body so the provider request is fully observed.
      await req.text().catch(() => "");
      const url = new URL(req.url);
      captured.push(url.pathname);
      return controlledResponse(url.pathname, captured.length);
    },
  });
  controlled.unref();
  return `http://127.0.0.1:${controlled.port}`;
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

/** Seed an `ollama`-typed provider (OpenAI-compatible wire protocol, no key). */
async function seedControlledProvider(): Promise<string> {
  const endpoint = startControlledProvider();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'error-hygiene', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 0, ?, ?)`,
    [PROVIDER_ID, endpoint, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
  return endpoint;
}

afterAll(async () => {
  stopControlledProvider();
  db.run("DELETE FROM provider_configs WHERE id = ?", [PROVIDER_ID]);
  await registry.loadFromDb(db);
});

// ── Console capture ──────────────────────────────────────────────────────────
// The structured logger writes warn/error to console.error, so the console IS
// one of the sinks under test. Capture it for the duration of each case; the
// test reporter only writes between cases, so nothing is swallowed.
type ConsoleSink = { error: string[]; warn: string[]; log: string[] };
let sink: ConsoleSink | null = null;
const realConsole = {
  error: console.error,
  warn: console.warn,
  log: console.log,
};

function beginConsoleCapture(): ConsoleSink {
  const lines: ConsoleSink = { error: [], warn: [], log: [] };
  console.error = (...args: unknown[]) => {
    lines.error.push(args.map((a) => String(a)).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    lines.warn.push(args.map((a) => String(a)).join(" "));
  };
  console.log = (...args: unknown[]) => {
    lines.log.push(args.map((a) => String(a)).join(" "));
  };
  return lines;
}

function endConsoleCapture(): void {
  console.error = realConsole.error;
  console.warn = realConsole.warn;
  console.log = realConsole.log;
}

/** console.error + console.warn joined — the two sinks the contract names. */
function consoleDiagnostics(lines: ConsoleSink): string {
  return [...lines.error, ...lines.warn].join("\n");
}

/** Every captured console line, including info/debug. */
function consoleEverything(lines: ConsoleSink): string {
  return [...lines.error, ...lines.warn, ...lines.log].join("\n");
}

// ── Per-test isolation ───────────────────────────────────────────────────────
beforeEach(() => {
  captured = [];
  behavior = "text-then-error";
  sink = beginConsoleCapture();
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});
afterEach(() => {
  endConsoleCapture();
  sink = null;
  stopControlledProvider();
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function logEntriesSince(since: number): LogEntry[] {
  return logger.getRecentEntries(since);
}

function renderLogs(since: number): string {
  return JSON.stringify(logEntriesSince(since));
}

function userMessage(text: string): Record<string, unknown> {
  return { id: "msg-user-hygiene", role: "user", parts: [{ type: "text", text }] };
}

async function createDirectConversation(title: string): Promise<string> {
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

async function postChat(body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/chat", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
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

function streamIdOf(res: Response): string {
  const id = res.headers.get(RESUMABLE_STREAM_ID_HEADER);
  if (!id) throw new Error("response carried no resumable stream id");
  return id;
}

/**
 * The user-facing text the Direct route produces for the failing tool: the
 * shared sanitizer's copy for a "not found" failure. Asserted against the
 * stream instead of hard-coded copy so the case pins the BOUNDARY (the raw
 * tool message is never what the user sees) without duplicating the copy table.
 */
function sanitizedToolFailureText(): string {
  return sanitizeStreamError(new Error(`File not found: ${TOOL_ERROR_MARKER}`));
}

/**
 * The provider error the controlled endpoint induces for `status`, in the shape
 * the AI SDK throws it: a real `Error` whose `name` is the API-call error class
 * and which carries the HTTP `statusCode`. The user-facing copy is asserted
 * against the SHARED sanitizer applied to this reference, so a case pins
 * "the user sees the copy for THIS failure's category" without re-typing the
 * copy table (and without a helper that merely mirrors the route's own call).
 */
function providerStatusError(status: number, message: string): Error {
  return Object.assign(new Error(message), {
    name: "AI_APICallError",
    statusCode: status,
  });
}

/** The copy a client is entitled to see for a provider failure with `status`. */
function sanitizedStatusCopy(status: number, message: string): string {
  return sanitizeStreamError(providerStatusError(status, message));
}

/** The fallback copy for an unclassifiable failure, used to prove copy specificity. */
function genericFailureCopy(): string {
  return sanitizeStreamError(new Error("unclassified failure"));
}

interface StatusFailureRun {
  behavior: StatusFailureBehavior;
  streamId: string;
  /** Log sequence the run started at, so a case can inspect exactly its window. */
  since: number;
  /** The full client body (the sink the UI and any network log read). */
  body: string;
  /** The single error part the UI stream delivered. */
  errorText: string;
  aiErrors: LogEntry[];
  /** Every error-level line the run produced (one canonical entry is the contract). */
  errorLevel: LogEntry[];
}

/**
 * Drive one HTTP status-semantics failure through the real Direct route and
 * return what the sinks observed. The positive controls live here so each case
 * cannot pass without the provider leg really having failed.
 */
async function runStatusFailure(leg: StatusFailureBehavior): Promise<StatusFailureRun> {
  await seedControlledProvider();
  behavior = leg;
  const conversationId = await createDirectConversation(`error-hygiene-${leg}`);
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
    const body = await res.text();

    // Positive control: the model leg really was driven against the controlled
    // endpoint, exactly once (Direct sets maxRetries 0 — no replay), and it
    // really failed with exactly one error part.
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("/chat/completions");
    const errorParts = uiStreamParts(body).filter((p) => p.type === "error");
    expect(errorParts.length).toBe(1);
    expect(chatRuns.get(streamId)?.status).toBe("failed");

    const entries = logEntriesSince(since);
    return {
      behavior: leg,
      streamId,
      since,
      body,
      errorText: String(errorParts[0].errorText),
      aiErrors: entries.filter((e) => e.event === "ai.error"),
      errorLevel: entries.filter((e) => e.level === "error"),
    };
  } finally {
    await conversationService.delete(conversationId);
  }
}

// ── 1. A marked provider error on the real Direct route ──────────────────────
describe("raw error hygiene — Direct provider failure", () => {
  it("keeps a marked mid-stream provider error out of the logs, the client body, and the console", async () => {
    const endpoint = await seedControlledProvider();
    const conversationId = await createDirectConversation("error-hygiene-provider");
    const since = logger.lastSeq;
    const lines = sink!;

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      const streamId = streamIdOf(res);
      const body = await res.text();

      // Positive control: the marked failure really happened, over the real
      // model leg. Without this the marker assertions below could pass simply
      // because no error was ever raised.
      expect(captured.length).toBeGreaterThanOrEqual(1);
      expect(body).not.toContain(endpoint);
      expect(
        uiStreamParts(body).some((p) => p.type === "error" && typeof p.errorText === "string"),
      ).toBe(true);
      expect(chatRuns.get(streamId)?.status).toBe("failed");
      const failures = logEntriesSince(since).filter((e) => e.event === "ai.error");
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.some((e) => typeof e.category === "string" && e.category.length > 0)).toBe(
        true,
      );

      // Sink 1 — the structured log capture (ring / file / Logs panel).
      const rendered = renderLogs(since);
      expect(rendered).not.toContain(PROVIDER_ERROR_MARKER);
      // Sink 2 — the JSON the client receives (the UI error part is sanitized).
      expect(body).not.toContain(PROVIDER_ERROR_MARKER);
      // Sink 3 — console.error / console.warn, and the rest of the console too.
      expect(consoleDiagnostics(lines)).not.toContain(PROVIDER_ERROR_MARKER);
      expect(consoleEverything(lines)).not.toContain(PROVIDER_ERROR_MARKER);
      // The failure line itself is real evidence, not a silent drop.
      expect(consoleDiagnostics(lines)).toContain("ai.error");
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 2. A marked tool error on the real Direct route ──────────────────────────
// The tool call carries the marked path as an ARGUMENT, so the client body
// legitimately echoes it back (that is the tool input, not error text). What
// must not happen is the marked TOOL FAILURE text crossing into the logs or
// the console, and the error the user sees being the raw tool message.
describe("raw error hygiene — Direct tool failure", () => {
  it("keeps a marked native tool failure out of the logs and the console, and sanitizes the user-facing text", async () => {
    await seedControlledProvider();
    behavior = "tool-call-then-complete";
    const conversationId = await createDirectConversation("error-hygiene-tool");
    const since = logger.lastSeq;
    const lines = sink!;

    try {
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      const streamId = streamIdOf(res);
      const body = await res.text();

      // Positive control: the model really called the tool, the tool really
      // failed, and the failure was reported through the tool funnel.
      expect(captured.length).toBeGreaterThanOrEqual(1);
      const toolErrors = uiStreamParts(body).filter((p) => p.type === "tool-output-error");
      expect(toolErrors.length).toBe(1);
      const toolError = toolErrors[0].errorText;
      expect(toolError).toBe(sanitizedToolFailureText());
      expect(String(toolError)).not.toContain(TOOL_ERROR_MARKER);
      expect(chatRuns.get(streamId)).toBeDefined();
      const funnel = logEntriesSince(since).filter((e) => e.event === "tool.error");
      expect(funnel.length).toBeGreaterThan(0);
      expect(funnel[0].tool).toBe("read_file");
      expect(typeof funnel[0].category).toBe("string");

      // Sink 1 — the structured log capture. The tool ARGUMENT may be recorded
      // by the diagnostic switch, but this run is at the default policy, where
      // neither the arguments nor the failure text are logged.
      expect(renderLogs(since)).not.toContain(TOOL_ERROR_MARKER);
      // Sink 3 — console.error / console.warn.
      expect(consoleDiagnostics(lines)).not.toContain(TOOL_ERROR_MARKER);
      expect(consoleEverything(lines)).not.toContain(TOOL_ERROR_MARKER);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 3. A marked provider error on a real non-streaming route ─────────────────
// `POST /api/providers/test` runs the real discovery client against the
// controlled endpoint, so the provider's own marked error body becomes the
// thrown error's message. The route's JSON and its log line must both stay on
// the sanitized side of the boundary.
describe("raw error hygiene — provider connection check", () => {
  it("keeps a marked provider error body out of the response JSON, the logs, and the console", async () => {
    const endpoint = await seedControlledProvider();
    const since = logger.lastSeq;
    const lines = sink!;

    // No conversation row is involved, so nothing beyond the endpoint (torn
    // down in afterEach/afterAll) needs cleanup here.
    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "error-hygiene-probe",
        type: "custom",
        endpoint,
        model: MODEL_ID,
        apiKey: "probe-key",
      }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { ok: boolean; error?: string };

    // Positive control: discovery really failed against the controlled
    // endpoint, and the failure was reported through the AI funnel.
    expect(captured.some((p) => p.endsWith("/models"))).toBe(true);
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error?.length).toBeGreaterThan(0);
    const funnel = logEntriesSince(since).filter((e) => e.event === "ai.error");
    expect(funnel.length).toBeGreaterThan(0);
    expect(funnel[0].category).toBeDefined();

    // Sink 1 / 2 / 3.
    expect(renderLogs(since)).not.toContain(PROVIDER_ERROR_MARKER);
    expect(raw).not.toContain(PROVIDER_ERROR_MARKER);
    expect(consoleDiagnostics(lines)).not.toContain(PROVIDER_ERROR_MARKER);
    expect(consoleEverything(lines)).not.toContain(PROVIDER_ERROR_MARKER);
  }, 30000);
});

// ── 4. The global Hono error JSON ────────────────────────────────────────────
// `src/routes/index.ts` is the composition root: it registers the ONE global
// error handler every unhandled throw reaches, and it is the boundary that
// turns a raw exception into an HTTP body. The production handler is taken off
// the composed app (`onError` stores it on the instance) and driven with a
// marked error, so the real handler — not a copy of it — is what answers.
describe("raw error hygiene — global Hono error JSON", () => {
  it("answers a thrown marked error with sanitized copy and logs only classification fields", async () => {
    const productionHandler = (
      app as unknown as {
        errorHandler: (err: Error, c: unknown) => Response | Promise<Response>;
      }
    ).errorHandler;
    expect(typeof productionHandler).toBe("function");

    // A probe app carries the production handler; the marker arrives through an
    // ordinary unhandled throw, exactly as a faulty route would produce it.
    const probe = new Hono();
    probe.onError(productionHandler);
    const thrown = new Error(GLOBAL_ERROR_MARKER);
    probe.post("/__error-hygiene-probe", () => {
      throw thrown;
    });

    const since = logger.lastSeq;
    const lines = sink!;
    const res = await probe.request("/__error-hygiene-probe", { method: "POST" });
    expect(res.status).toBe(500);
    const raw = await res.text();
    const body = JSON.parse(raw) as { error?: string; requestId?: string };

    // Positive control: the global handler really ran and logged the throw.
    expect(typeof body.error).toBe("string");
    expect(body.error?.length).toBeGreaterThan(0);
    expect(body.error).not.toBe(thrown.message);
    const entries = logEntriesSince(since).filter((e) => e.event === "http.error");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].level).toBe("error");
    expect(typeof entries[0].category).toBe("string");

    // Sink 1 / 2 / 3.
    expect(renderLogs(since)).not.toContain(GLOBAL_ERROR_MARKER);
    expect(raw).not.toContain(GLOBAL_ERROR_MARKER);
    expect(consoleDiagnostics(lines)).not.toContain(GLOBAL_ERROR_MARKER);
    expect(consoleEverything(lines)).not.toContain(GLOBAL_ERROR_MARKER);
    expect(consoleDiagnostics(lines)).toContain("http.error");
  }, 30000);
});

// ── 5. HTTP status semantics survive into `ai.error` and into the response ───
// A provider failure is not just "an error happened": the HTTP status carries
// the diagnosis, and it is what the retry policy, the sanitized copy and the
// operator-facing line are all derived from. So the classification fields must
// survive the whole trip out of the provider.
//
// The concrete regression these cases catch is the AI SDK's
// `streamText.onError({ error })` EVENT shape: the callback receives an event
// object, and handing THAT to the classifier instead of `event.error` still logs
// an `ai.error` line (so a presence-only assertion passes) while every field
// degrades — `category: "unknown"`, no `statusCode`, `retryable: false`,
// `errorType: "object"`. Hence the exact-value assertions below, and hence the
// explicit "this is not a `{ error }` wrapper" assertions.
describe("raw error hygiene — Direct provider HTTP status semantics", () => {
  it("classifies a 429 as a retryable rate_limit in the one canonical ai.error, and answers with the rate-limit copy", async () => {
    const leg: StatusFailureBehavior = "http-rate-limited";
    const expected = STATUS_FAILURES[leg];
    const run = await runStatusFailure(leg);
    const lines = sink!;

    // Exactly ONE canonical `ai.error` for one producer failure: the route's AI
    // funnel owns it. A second entry would mean a lower layer (the resumable
    // stream context beneath the route) classified and logged the same failure
    // again, and the same failure must never be reported as two incidents.
    expect(run.aiErrors).toHaveLength(1);
    expect(run.errorLevel).toHaveLength(1);
    expect(run.errorLevel[0].event).toBe("ai.error");
    const entry = run.aiErrors[0];
    // The single entry is the Direct route's own (correlation + diagnostics),
    // not a lower layer's view of the same failure.
    expect(entry.streamId).toBe(run.streamId);
    expect(entry.conversationId).toBeTypeOf("string");
    expect(entry.provider).toBe("ollama");
    expect(entry.model).toBe(MODEL_ID);
    expect(typeof entry.chunkCount).toBe("number");

    // The diagnosis survives: category, HTTP status, retryability and the
    // error's own type, all verbatim.
    expect(entry.category).toBe(expected.category);
    expect(entry.statusCode).toBe(expected.status);
    expect(entry.retryable).toBe(expected.retryable);
    // A real thrown error's class name — not the name of the EVENT object.
    expect(entry.errorType).toMatch(/Error$/);

    // The classification is the ERROR's, not the event's: a handler that logged
    // the `{ error }` wrapper still emits an `ai.error` line, but with the
    // wrapper's own type and no HTTP status — the exact silent-degradation this
    // case exists to catch.
    expect(entry.errorType).not.toBe("object");
    expect(entry.statusCode).toBe(expected.status);
    // The raw error object was not smuggled through as a field either.
    expect(Object.keys(entry)).not.toContain("error");
    expect(entry.error).toBeUndefined();

    // The response copy is the copy for THIS category — the rate-limit copy, not
    // the generic fallback a lost classification would have produced.
    expect(run.errorText).toBe(sanitizedStatusCopy(expected.status, expected.message));
    expect(run.errorText).not.toBe(genericFailureCopy());

    // Sinks: the raw upstream text reaches neither the logs, nor the client
    // body, nor the console.
    expect(renderLogs(run.since)).not.toContain(RATE_LIMIT_MARKER);
    expect(run.body).not.toContain(RATE_LIMIT_MARKER);
    expect(consoleDiagnostics(lines)).not.toContain(RATE_LIMIT_MARKER);
    expect(consoleEverything(lines)).not.toContain(RATE_LIMIT_MARKER);
  }, 30000);

  it("classifies a 503 as a retryable provider failure in the one canonical ai.error, and answers with the matching copy", async () => {
    const leg: StatusFailureBehavior = "http-unavailable";
    const expected = STATUS_FAILURES[leg];
    const run = await runStatusFailure(leg);
    const lines = sink!;

    expect(run.aiErrors).toHaveLength(1);
    expect(run.errorLevel).toHaveLength(1);
    const entry = run.aiErrors[0];
    expect(run.errorLevel[0].event).toBe("ai.error");
    expect(entry.streamId).toBe(run.streamId);

    // A 5xx from a known provider is a provider failure and is retryable — not
    // the `unknown`/non-retryable shape a lost status collapses to.
    expect(entry.category).toBe(expected.category);
    expect(entry.statusCode).toBe(expected.status);
    expect(entry.retryable).toBe(expected.retryable);
    expect(entry.errorType).toMatch(/Error$/);
    // The wrapper's own type and the wrapper's missing status are the two
    // tells; the raw error object is not smuggled through as a field either.
    expect(entry.errorType).not.toBe("object");
    expect(Object.keys(entry)).not.toContain("error");
    expect(entry.error).toBeUndefined();

    // The copy follows the 503 category: it is the copy the shared sanitizer
    // produces for a 503, and specifically NOT another status's copy (the 429
    // one here), so a hard-coded or status-blind string would fail.
    expect(run.errorText).toBe(sanitizedStatusCopy(expected.status, expected.message));
    expect(run.errorText).not.toBe(
      sanitizedStatusCopy(
        STATUS_FAILURES["http-rate-limited"].status,
        STATUS_FAILURES["http-rate-limited"].message,
      ),
    );

    const marker = UNAVAILABLE_MARKER;
    expect(renderLogs(run.since)).not.toContain(marker);
    expect(run.body).not.toContain(marker);
    expect(consoleDiagnostics(lines)).not.toContain(marker);
    expect(consoleEverything(lines)).not.toContain(marker);
  }, 30000);
});
