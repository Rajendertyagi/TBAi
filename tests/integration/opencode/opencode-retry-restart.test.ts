/**
 * Supplemental G6 evidence: retry timing is not restored after the OpenCode
 * process restarts.
 *
 * ## What this proves
 *
 * A real child is killed mid-retry and a second child is started against the
 * same isolated store. The suite then observes:
 *
 * 1. Before the kill: `session.active` is `{ type: "running" }`, a live
 *    `session.retry.scheduled` carries an absolute epoch-ms `at`, and the
 *    assistant message already stores that retry state durably.
 * 2. After the restart, for longer than the original deadline: no new
 *    `session.retry.scheduled`, no `session.execution.started`, no active
 *    entry, and no upstream model request. The durable `retry` state is still
 *    returned by history, unchanged.
 * 3. A NEW prompt is the only thing that establishes a new wait, and its
 *    deadline is a fresh deadline rather than the pre-kill value.
 *
 * Together with `tests/unit/web/opencode/v2RetryActivity.test.ts` ("does not
 * turn a replayed durable record into a live countdown"), this is the process
 * half of "no fabricated countdown": the server does not resume the wait, and
 * the client projects the durable record as transcript state only.
 *
 * ## What this does NOT prove
 *
 * It does NOT exercise the Tauri sidecar restart path, so G6 itself remains
 * Unverified. It says nothing about Tauri process ownership (G2) or about
 * crash-time database integrity beyond reopening the store (G3). The session
 * that was mid-retry is not expected to continue; no automatic resubmission is
 * observed or claimed.
 *
 * ## Process safety
 *
 * The ONLY process stopped is the child this harness spawned, on its own
 * ephemeral loopback port. No other OpenCode process is enumerated, signalled,
 * adopted, or inspected. `XDG_DATA_HOME` and `OPENCODE_DB` point inside this
 * test's temp tree, so the developer's live OpenCode store is never opened.
 * The kill is deliberate: it is the restart being tested.
 */

import { describe, expect, it } from "bun:test";
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
  OPENCODE_V2_COMPATIBLE_PACKAGE,
  STUB_CONTEXT_LIMIT,
  STUB_MODEL_ID,
  STUB_OUTPUT_LIMIT,
  STUB_PROVIDER_ID,
  STUB_UPSTREAM_MODEL_ID,
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
  console.warn(`[opencode retry restart] enabled but unavailable: ${reason}`);
}

/** Enough failures that the run is still waiting when the kill lands. */
const RETRY_FAILURES = 50;

/** Message placed in the provider's 429 body. */
const RETRY_ERROR_MESSAGE = "tbai-retry-restart-fixture";

/** Upper bound for creating the first turn. */
const TURN_TIMEOUT_MS = 120_000;

/** How long past the original deadline the restarted server is observed. */
const HOLD_PAST_DEADLINE_MS = 3_000;

/** The durable retry projection carried on the assistant message. */
interface DurableRetry {
  readonly attempt: number;
  readonly at: number;
  readonly error?: { readonly message?: string };
}

/** The subset of a session message row this suite reads. */
interface SessionMessageRow {
  readonly id?: string;
  readonly type?: string;
  readonly outcome?: string;
  readonly retry?: DurableRetry;
}

interface MidRetryState {
  isolation: RuntimeIsolation;
  stub: StubProvider;
  resetFailures: () => void;
  serverA: RuntimeOpenCodeServer;
  stopA: () => void;
  eventsA: RuntimeWireEvent[];
  sessionId: string;
  assistantMessageId: string;
  retryDeadline: number;
  retryAttempt: number;
  durableRetry: DurableRetry;
  messageIdsBeforeKill: string[];
  headers: () => Record<string, string>;
  dataHome: string;
  dbPath: string;
}

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

async function createStub(): Promise<{
  stub: StubProvider;
  resetFailures: () => void;
}> {
  let failuresRemaining = RETRY_FAILURES;
  const stub = await startStubProvider({
    model: STUB_MODEL_ID,
    error: { status: 429, message: RETRY_ERROR_MESSAGE, retryAfterSeconds: 1 },
    respond: (request) => {
      if (summariseStubRequest(request) === "summary") return "summary";
      // The title generator carries no tools; failing it proves nothing.
      if (!request.offersTools) return "text";
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        return "retryable-error";
      }
      return "text";
    },
  });
  return {
    stub,
    resetFailures: () => {
      failuresRemaining = RETRY_FAILURES;
    },
  };
}

async function driveToMidRetry(label: string): Promise<MidRetryState> {
  const { stub, resetFailures } = await createStub();
  const isolation = createRuntimeIsolation(`retry-restart-${label}-${Date.now()}`);
  // Disable auto-compaction: this suite proves retry timing/restart behavior.
  // Auto-compaction can trigger on the post-restart prompt and, if its request
  // is misclassified by the stub, fail the turn before a retry is scheduled.
  fs.writeFileSync(
    isolation.configFile,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: `${STUB_PROVIDER_ID}/${STUB_MODEL_ID}`,
        providers: {
          [STUB_PROVIDER_ID]: {
            name: "Stub",
            package: OPENCODE_V2_COMPATIBLE_PACKAGE,
            settings: { baseURL: stub.baseURL, apiKey: "tbai-stub-no-auth-required" },
            models: {
              [STUB_MODEL_ID]: {
                modelID: STUB_UPSTREAM_MODEL_ID,
                name: "Stub Tiny",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                limit: { context: STUB_CONTEXT_LIMIT, output: STUB_OUTPUT_LIMIT },
              },
            },
          },
        },
        compaction: { auto: false },
      },
      null,
      2,
    ),
    "utf8",
  );

  const dataHome = path.join(isolation.root, "xdg-data");
  fs.mkdirSync(dataHome, { recursive: true });
  const dbPath = path.join(isolation.root, "opencode-retry-restart.db");
  const serverA = await startRuntimeOpenCodeServer(
    undefined,
    { XDG_DATA_HOME: dataHome, OPENCODE_DB: dbPath },
    { isolation },
  );

  const eventsA: RuntimeWireEvent[] = [];
  const controller = new AbortController();
  const stopA = () => controller.abort();
  void subscribeRuntimeEvents(serverA, controller.signal, eventsA);
  await waitFor(
    () => eventsA.some((event) => event.type === "server.connected"),
    "event stream did not report server.connected",
    TURN_TIMEOUT_MS,
  );

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    "x-opencode-directory": isolation.homeDir,
  });

  const created = await serverA.json<{ data: { id: string } }>("/api/session", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({}),
  });
  const sessionId = created.data.id;

  await serverA.json(`/api/session/${sessionId}/model`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: { id: STUB_MODEL_ID, providerID: STUB_PROVIDER_ID } }),
  });
  await serverA.json(`/api/session/${sessionId}/prompt`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ text: "start a retry, then get restarted" }),
  });

  await waitFor(
    () =>
      eventsA.some(
        (event) =>
          event.type === "session.retry.scheduled" &&
          (event.data?.sessionID as string | undefined) === sessionId,
      ),
    "the first turn never scheduled a retry",
    TURN_TIMEOUT_MS,
  );

  const firstRetry = eventsA.find(
    (event) =>
      event.type === "session.retry.scheduled" &&
      (event.data?.sessionID as string | undefined) === sessionId,
  );
  const data = firstRetry?.data ?? {};
  const retryAttempt = data.attempt as number;
  const retryDeadline = data.at as number;
  const assistantMessageId = data.assistantMessageID as string;

  const projectionDeadline = Date.now() + 5_000;
  let assistant: SessionMessageRow | undefined;
  let messageIdsBeforeKill: string[] = [];
  while (Date.now() < projectionDeadline) {
    const messages = await serverA.json<{ data: SessionMessageRow[] }>(
      `/api/session/${sessionId}/message`,
      { headers: headers() },
    );
    assistant = messages.data.find((message) => message.id === assistantMessageId);
    messageIdsBeforeKill = messages.data.map((message) => message.id ?? "");
    if (assistant?.retry !== undefined) break;
    await Bun.sleep(100);
  }
  if (!assistant?.retry) throw new Error("durable retry was not recorded before kill");

  return {
    isolation,
    stub,
    resetFailures,
    serverA,
    stopA,
    eventsA,
    sessionId,
    assistantMessageId,
    retryDeadline,
    retryAttempt,
    durableRetry: assistant.retry,
    messageIdsBeforeKill,
    headers,
    dataHome,
    dbPath,
  };
}

async function cleanupMidRetry(state: MidRetryState): Promise<void> {
  state.stopA();
  await state.serverA.stop().catch(() => undefined);
  state.stub.stop();
  fs.rmSync(state.isolation.root, { recursive: true, force: true });
}

describeRuntime("real OpenCode: a restarted process does not restore a retry", () => {
  it("records a live retry and its durable message state before the restart", async () => {
    const state = await driveToMidRetry("record");
    try {
      expect(typeof state.sessionId).toBe("string");
      expect(typeof state.retryAttempt).toBe("number");
      expect(state.retryAttempt).toBeGreaterThan(1);
      expect(typeof state.retryDeadline).toBe("number");
      expect(Number.isFinite(state.retryDeadline)).toBe(true);
      const firstRetry = state.eventsA.find(
        (event) =>
          event.type === "session.retry.scheduled" &&
          (event.data?.sessionID as string | undefined) === state.sessionId,
      );
      expect(state.retryDeadline).toBeGreaterThan(firstRetry?.created as number);

      const active = await state.serverA.json<{ data: Record<string, unknown> }>(
        "/api/session/active",
      );
      expect(active.data[state.sessionId]).toEqual({ type: "running" });

      expect(state.durableRetry.attempt).toBe(state.retryAttempt);
      expect(state.durableRetry.at).toBe(state.retryDeadline);
    } finally {
      await cleanupMidRetry(state);
    }
  }, 180_000);

  it("does not resume the wait or restore a countdown after the restart", async () => {
    const state = await driveToMidRetry("no-resume");
    let serverB: RuntimeOpenCodeServer | undefined;
    let stopB: (() => void) | undefined;
    const eventsB: RuntimeWireEvent[] = [];
    try {
      state.stopA();
      await state.serverA.stop();
      const killedAt = Date.now();
      const requestsAtKill = state.stub.requests.length;
      expect(requestsAtKill).toBeGreaterThan(0);

      serverB = await startRuntimeOpenCodeServer(
        undefined,
        { XDG_DATA_HOME: state.dataHome, OPENCODE_DB: state.dbPath },
        { isolation: state.isolation },
      );
      const controller = new AbortController();
      stopB = () => controller.abort();
      void subscribeRuntimeEvents(serverB, controller.signal, eventsB);
      await waitFor(
        () => eventsB.some((event) => event.type === "server.connected"),
        "restarted event stream did not report server.connected",
        TURN_TIMEOUT_MS,
      );

      const holdUntil = Math.max(state.retryDeadline + HOLD_PAST_DEADLINE_MS, Date.now() + 2_000);
      while (Date.now() < holdUntil) await Bun.sleep(100);
      expect(Date.now()).toBeGreaterThan(state.retryDeadline);

      const sessionEventsAfterKill = eventsB.filter(
        (event) =>
          (event.created ?? 0) >= killedAt &&
          (event.data?.sessionID as string | undefined) === state.sessionId,
      );
      const resumed = sessionEventsAfterKill.filter(
        (event) =>
          event.type === "session.retry.scheduled" || event.type === "session.execution.started",
      );
      expect(resumed).toEqual([]);
      expect(state.stub.requests.length).toBe(requestsAtKill);

      const active = await serverB.json<{ data: Record<string, unknown> }>("/api/session/active");
      expect(active.data[state.sessionId]).toBeUndefined();

      const session = await serverB.json<{ data: { id?: string } }>(
        `/api/session/${state.sessionId}`,
        { headers: state.headers() },
      );
      expect(session.data.id).toBe(state.sessionId);

      const messages = await serverB.json<{ data: SessionMessageRow[] }>(
        `/api/session/${state.sessionId}/message`,
        { headers: state.headers() },
      );
      expect(messages.data.map((message) => message.id)).toEqual(state.messageIdsBeforeKill);
      const assistant = messages.data.find((message) => message.id === state.assistantMessageId);
      expect(assistant?.retry).toEqual(state.durableRetry);
      expect(
        messages.data.some((message) => message.type === "idle" && message.outcome === "succeeded"),
      ).toBe(false);
    } finally {
      stopB?.();
      await serverB?.stop().catch(() => undefined);
      state.stub.stop();
      fs.rmSync(state.isolation.root, { recursive: true, force: true });
    }
  }, 240_000);

  it("establishes a fresh deadline only after a new prompt", async () => {
    const state = await driveToMidRetry("fresh");
    let serverB: RuntimeOpenCodeServer | undefined;
    let stopB: (() => void) | undefined;
    const eventsB: RuntimeWireEvent[] = [];
    try {
      state.stopA();
      await state.serverA.stop();
      const killedAt = Date.now();
      const requestsAtKill = state.stub.requests.length;

      serverB = await startRuntimeOpenCodeServer(
        undefined,
        { XDG_DATA_HOME: state.dataHome, OPENCODE_DB: state.dbPath },
        { isolation: state.isolation },
      );
      const controller = new AbortController();
      stopB = () => controller.abort();
      void subscribeRuntimeEvents(serverB, controller.signal, eventsB);
      await waitFor(
        () => eventsB.some((event) => event.type === "server.connected"),
        "restarted event stream did not report server.connected",
        TURN_TIMEOUT_MS,
      );

      // Hold past the original deadline to prove no restored countdown, then
      // issue a new prompt which must establish a fresh live retry.
      const holdUntil = Math.max(state.retryDeadline + HOLD_PAST_DEADLINE_MS, Date.now() + 2_000);
      while (Date.now() < holdUntil) await Bun.sleep(100);
      expect(Date.now()).toBeGreaterThan(state.retryDeadline);

      // Replenish the stub's failure budget for the post-restart prompt: the
      // pre-kill mid-retry phase may have consumed failures while waiting.
      state.resetFailures();
      const mark = eventsB.length;
      await serverB.json(`/api/session/${state.sessionId}/prompt`, {
        method: "POST",
        headers: state.headers(),
        body: JSON.stringify({ text: "second prompt after the restart" }),
      });

      await waitFor(
        () =>
          eventsB
            .slice(mark)
            .some(
              (event) =>
                event.type === "session.retry.scheduled" &&
                (event.data?.sessionID as string | undefined) === state.sessionId,
            ),
        "the new prompt did not establish a new retry",
        TURN_TIMEOUT_MS,
      );

      const fresh = eventsB
        .slice(mark)
        .find(
          (event) =>
            event.type === "session.retry.scheduled" &&
            (event.data?.sessionID as string | undefined) === state.sessionId,
        );
      const data = fresh?.data ?? {};
      const freshDeadline = data.at as number;

      expect(fresh?.created as number).toBeGreaterThan(killedAt);
      expect(freshDeadline).toBeGreaterThan(fresh?.created as number);
      expect(freshDeadline).not.toBe(state.retryDeadline);
      expect(data.attempt as number).toBeGreaterThan(1);
      expect(state.stub.requests.length).toBeGreaterThan(requestsAtKill);
    } finally {
      stopB?.();
      await serverB?.stop().catch(() => undefined);
      state.stub.stop();
      fs.rmSync(state.isolation.root, { recursive: true, force: true });
    }
  }, 300_000);
});
