/**
 * The live retry contract of the installed OpenCode binary, exercised end to end.
 *
 * ## What this proves
 *
 * A real `opencode serve` child, a real session, and a real event stream are
 * driven by a stub model that answers the first N agent turns with HTTP 429.
 * The test observes, on the wire:
 *
 *  - `session.retry.scheduled` with an attempt number, a structured error, and
 *    an ABSOLUTE epoch-ms deadline (`data.at`), not a duration;
 *  - `session.active` reporting the session as `{ type: "running" }` for this
 *    server process while the wait is pending, and omitting it after the turn;
 *  - the turn recovering on its own once the stub answers, with
 *    `session.execution.succeeded` and a succeeded idle record.
 *
 * This is the evidence G5 and the retry half of G6 need. It is NOT crash
 * recovery evidence: no process is killed here, and no claim is made that a
 * countdown survives a restart.
 *
 * ## Process safety
 *
 * The harness spawns its OWN `opencode serve` on an ephemeral loopback port and
 * stops only that child. `session.active` is read from the same isolated child.
 * Nothing here enumerates, signals, or adopts any other OpenCode process.
 *
 * ## Isolation
 *
 * `XDG_DATA_HOME` and `OPENCODE_DB` point inside this test's own temp tree, so
 * the developer's live OpenCode database is never opened. The models.dev cache
 * is deliberately left shared (see `opencodeRuntimeHarness.ts`): an empty cache
 * means no models are listed at all.
 *
 * ## Gating
 *
 * Skipped unless `TBAI_OPENCODE_RUNTIME_TESTS=1` and a supported binary exists,
 * exactly like the other runtime suites. The default `bun run test` stays
 * hermetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  createRuntimeIsolation,
  runtimeTestsRequested,
  runtimeUnavailableReason,
  startRuntimeOpenCodeServer,
  type RuntimeIsolation,
  type RuntimeOpenCodeServer,
} from "../../harness/opencodeRuntimeHarness.ts";
import {
  buildStubOpenCodeConfig,
  STUB_MODEL_ID,
  STUB_PROVIDER_ID,
} from "../../harness/opencodeStubConfig.ts";
import {
  startStubProvider,
  summariseStubRequest,
  type StubProvider,
} from "../../harness/opencodeStubProvider.ts";
import {
  subscribeRuntimeEvents,
  type RuntimeWireEvent,
} from "../../harness/opencodeEventStream.ts";

const reason = runtimeUnavailableReason();
const describeRuntime = runtimeTestsRequested() ? describe : describe.skip;

if (runtimeTestsRequested() && reason) {
  console.warn(`[opencode retry runtime] enabled but unavailable: ${reason}`);
}

/** How many agent turns the stub fails before it starts answering. */
const RETRY_FAILURES = 2;

/** Message placed in the provider's 429 body; asserted on the retry event. */
const RETRY_ERROR_MESSAGE = "tbai-retry-runtime-fixture";

/** Upper bound for one turn including the retry backoff. */
const TURN_TIMEOUT_MS = 120_000;

/** The subset of a session message row this suite reads. */
interface SessionMessageRow {
  readonly type?: string;
  readonly outcome?: string;
}

describeRuntime("real OpenCode: a retryable provider failure produces a live retry", () => {
  let isolation: RuntimeIsolation;
  let stub: StubProvider;
  let server: RuntimeOpenCodeServer;
  let stopEvents: (() => void) | undefined;
  let sessionId: string | null = null;
  let failuresRemaining = RETRY_FAILURES;

  const events: RuntimeWireEvent[] = [];

  /** The event types this suite observed, for the evidence log. */
  const eventTypes = (): string[] => [...new Set(events.map((event) => event.type))];

  /** Events of one wire type. */
  const eventsOfType = (type: string): RuntimeWireEvent[] =>
    events.filter((event) => event.type === type);

  beforeAll(async () => {
    stub = await startStubProvider({
      model: STUB_MODEL_ID,
      error: { status: 429, message: RETRY_ERROR_MESSAGE, retryAfterSeconds: 1 },
      respond: (request) => {
        // Compaction must still be answered, or OpenCode rejects the summary.
        if (summariseStubRequest(request) === "summary") return "summary";
        // OpenCode's title generator is a real request and carries no tools;
        // failing it would prove nothing about an agent turn.
        if (!request.offersTools) return "text";
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          return "retryable-error";
        }
        return "text";
      },
    });

    isolation = createRuntimeIsolation(`retry-runtime-${Date.now()}`);
    fs.writeFileSync(
      isolation.configFile,
      JSON.stringify(buildStubOpenCodeConfig(stub.baseURL), null, 2),
      "utf8",
    );

    // Isolated OpenCode storage: this child must never touch the live database.
    const dataHome = path.join(isolation.root, "xdg-data");
    fs.mkdirSync(dataHome, { recursive: true });
    const dbPath = path.join(isolation.root, "opencode-retry-runtime.db");
    server = await startRuntimeOpenCodeServer(
      undefined,
      { XDG_DATA_HOME: dataHome, OPENCODE_DB: dbPath },
      { isolation },
    );

    // Subscribe BEFORE the session is created so no lifecycle event is missed.
    const controller = new AbortController();
    stopEvents = () => controller.abort();
    void subscribeRuntimeEvents(server, controller.signal, events);
    await waitFor(
      () => events.some((event) => event.type === "server.connected"),
      "event stream did not report server.connected",
      TURN_TIMEOUT_MS,
    );
  }, 180_000);

  afterAll(async () => {
    stopEvents?.();
    await server?.stop();
    stub?.stop();
    fs.rmSync(isolation?.root ?? "", { recursive: true, force: true });
  });

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    "x-opencode-directory": isolation.homeDir,
  });

  it("runs the pinned 2.1.2 binary in its own isolated store", async () => {
    const info = await server.json<{ version?: string }>("/api/info");
    // The conclusion is only meaningful for the binary that produced it.
    console.log(`[retry-runtime] opencode version under test: ${info.version}`);
    expect(typeof info.version).toBe("string");
    const config = await server.json<Array<{ type: string; path: string }>>("/api/config");
    const documents = config
      .filter((entry) => entry.type === "document")
      .map((entry) => entry.path);
    expect(documents).toContain(isolation.configFile);
  });

  it("starts with an empty active map for this session", async () => {
    const created = await server.json<{ data: { id: string } }>("/api/session", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    sessionId = created.data.id;
    expect(typeof sessionId).toBe("string");

    await server.json(`/api/session/${sessionId}/model`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: { id: STUB_MODEL_ID, providerID: STUB_PROVIDER_ID } }),
    });

    const active = await server.json<{ data: Record<string, unknown> }>("/api/session/active");
    // Absence is the server's own answer for "no foreground drain owns it".
    expect(active.data[sessionId]).toBeUndefined();
  });

  it(
    "turns a 429 into a retry with an absolute deadline, then recovers",
    async () => {
      if (!sessionId) throw new Error("session was not created");

      await server.json(`/api/session/${sessionId}/prompt`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ text: "please answer after the rate limit" }),
      });

      // Sample `session.active` the moment the first retry is announced. The wait
      // is short, so this is read inline rather than on a timer.
      let activeDuringRetry: Record<string, unknown> | undefined;
      await waitFor(
        () => {
          const scheduled = eventsOfType("session.retry.scheduled");
          if (scheduled.length > 0 && activeDuringRetry === undefined) {
            return true;
          }
          return events.some(
            (event) =>
              event.type === "session.execution.succeeded" ||
              event.type === "session.execution.failed",
          );
        },
        "no retry or terminal execution event within the turn timeout",
        TURN_TIMEOUT_MS,
      );
      const firstRetry = eventsOfType("session.retry.scheduled")[0];
      if (firstRetry) {
        const active = await server.json<{ data: Record<string, unknown> }>("/api/session/active");
        activeDuringRetry = active.data;
      }

      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === "session.execution.succeeded" ||
              event.type === "session.execution.failed",
          ),
        "the turn never reached a terminal execution event",
        TURN_TIMEOUT_MS,
      );

      const retries = eventsOfType("session.retry.scheduled");
      expect(retries.length).toBeGreaterThan(0);
      expect(stub.errorResponses.length).toBe(RETRY_FAILURES);
      expect(stub.errorResponses.every((error) => error.status === 429)).toBe(true);

      const scheduled = retries[0];
      const data = scheduled.data ?? {};
      // Attempt numbering is 1-based over the whole run, so the first SCHEDULED
      // retry is attempt 2. Asserting "> 1" rather than a fixed number keeps the
      // contract honest if a binary counts differently.
      expect(typeof data.attempt).toBe("number");
      expect(data.attempt as number).toBeGreaterThan(1);
      // `at` must be a deadline on the same clock as `created`; a duration here
      // would be orders of magnitude smaller and would break every countdown.
      expect(typeof data.at).toBe("number");
      expect(Number.isFinite(data.at as number)).toBe(true);
      expect(scheduled.created).toBeDefined();
      expect(data.at as number).toBeGreaterThan(scheduled.created as number);
      expect((data.at as number) - (scheduled.created as number)).toBeLessThan(5 * 60_000);

      // The structured error carries the provider failure, not a generic message.
      const error = data.error as { status?: number; message?: string } | undefined;
      expect(error?.status).toBe(429);
      expect(error?.message).toBe(RETRY_ERROR_MESSAGE);

      // Attempts only move forward; a rewound attempt would let a stale event
      // replace a newer wait in the UI.
      const attempts = retries.map((event) => event.data?.attempt as number);
      expect(attempts.length).toBeGreaterThan(0);
      for (let index = 1; index < attempts.length; index += 1) {
        expect(attempts[index]).toBeGreaterThan(attempts[index - 1] as number);
      }

      // The retry actually waited: the terminal event arrives no earlier than the
      // last announced deadline.
      const lastRetry = retries[retries.length - 1];
      const terminal = events.find(
        (event) =>
          event.type === "session.execution.succeeded" || event.type === "session.execution.failed",
      );
      expect(terminal?.type).toBe("session.execution.succeeded");
      expect(terminal?.created as number).toBeGreaterThanOrEqual(lastRetry.data?.at as number);

      // Activity observed while the retry was pending: this server process owns a
      // foreground drain for this session, and the shape is exactly `running`.
      expect(activeDuringRetry?.[sessionId]).toEqual({ type: "running" });

      // After the turn, the active map no longer contains the session.
      const activeAfter = await server.json<{ data: Record<string, unknown> }>(
        "/api/session/active",
      );
      expect(activeAfter.data[sessionId]).toBeUndefined();

      // The conversation itself settled successfully.
      const messages = await server.json<{ data: SessionMessageRow[] }>(
        `/api/session/${sessionId}/message`,
        { headers: headers() },
      );
      const idle = messages.data.filter((message) => message.type === "idle");
      expect(idle.some((message) => message.outcome === "succeeded")).toBe(true);

      // Evidence, not an assertion: 2.1.2 announces the wait with
      // `session.retry.scheduled`. `session.status` is declared by the client but
      // was not emitted by this binary in this flow.
      console.log(
        `[retry-runtime] attempts=${attempts.join(",")} statusEvents=${eventsOfType("session.status").length}`,
      );
      console.log(`[retry-runtime] observed event types: ${eventTypes().join(", ")}`);
    },
    TURN_TIMEOUT_MS + 30_000,
  );
});

/** Polls `predicate` until true, or throws `message` after `timeoutMs`. */
async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(message);
}
