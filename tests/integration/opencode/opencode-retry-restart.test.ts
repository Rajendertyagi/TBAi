/**
 * Supplemental G6 evidence: retry timing is not restored after the OpenCode
 * process restarts.
 *
 * ## What this proves
 *
 * A real 2.1.2 child is killed mid-retry and a second 2.1.2 child is started
 * against the same isolated store. The suite then observes:
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
  console.warn(`[opencode retry restart] enabled but unavailable: ${reason}`);
}

/** Enough failures that the run is still waiting when the kill lands. */
const RETRY_FAILURES = 8;

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

describeRuntime("real OpenCode: a restarted process does not restore a retry", () => {
  let isolation: RuntimeIsolation;
  let stub: StubProvider;
  let serverA: RuntimeOpenCodeServer | undefined;
  let serverB: RuntimeOpenCodeServer | undefined;
  let stopA: (() => void) | undefined;
  let stopB: (() => void) | undefined;
  let failuresRemaining = RETRY_FAILURES;

  let sessionId = "";
  let assistantMessageId = "";
  let retryDeadline = 0;
  let retryAttempt = 0;
  let durableRetry: DurableRetry | undefined;
  let messageIdsBeforeKill: string[] = [];
  let killedAt = 0;
  let requestsAtKill = 0;

  const eventsA: RuntimeWireEvent[] = [];
  const eventsB: RuntimeWireEvent[] = [];

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    "x-opencode-directory": isolation.homeDir,
  });

  /** Events on a server that belong to this session and happened after the kill. */
  const sessionEventsAfterKill = (events: readonly RuntimeWireEvent[]): RuntimeWireEvent[] =>
    events.filter(
      (event) =>
        (event.created ?? 0) >= killedAt &&
        (event.data?.sessionID as string | undefined) === sessionId,
    );

  beforeAll(async () => {
    stub = await startStubProvider({
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

    isolation = createRuntimeIsolation(`retry-restart-${Date.now()}`);
    fs.writeFileSync(
      isolation.configFile,
      JSON.stringify(buildStubOpenCodeConfig(stub.baseURL), null, 2),
      "utf8",
    );

    const dataHome = path.join(isolation.root, "xdg-data");
    fs.mkdirSync(dataHome, { recursive: true });
    serverA = await startRuntimeOpenCodeServer(
      undefined,
      {
        XDG_DATA_HOME: dataHome,
        OPENCODE_DB: path.join(isolation.root, "opencode-retry-restart.db"),
      },
      { isolation },
    );

    const controller = new AbortController();
    stopA = () => controller.abort();
    void subscribeRuntimeEvents(serverA, controller.signal, eventsA);
    await waitFor(
      () => eventsA.some((event) => event.type === "server.connected"),
      "event stream did not report server.connected",
      TURN_TIMEOUT_MS,
    );
  }, 180_000);

  afterAll(async () => {
    stopB?.();
    stopA?.();
    await serverB?.stop();
    await serverA?.stop();
    stub?.stop();
    fs.rmSync(isolation?.root ?? "", { recursive: true, force: true });
  });

  it("records a live retry and its durable message state before the restart", async () => {
    const a = serverA;
    if (!a) throw new Error("first server is not running");

    const created = await a.json<{ data: { id: string } }>("/api/session", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    sessionId = created.data.id;
    expect(typeof sessionId).toBe("string");

    await a.json(`/api/session/${sessionId}/model`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: { id: STUB_MODEL_ID, providerID: STUB_PROVIDER_ID } }),
    });
    await a.json(`/api/session/${sessionId}/prompt`, {
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
    retryAttempt = data.attempt as number;
    retryDeadline = data.at as number;
    assistantMessageId = data.assistantMessageID as string;

    // Absolute deadline on the same clock as the event, not a duration.
    expect(typeof retryAttempt).toBe("number");
    expect(retryAttempt).toBeGreaterThan(1);
    expect(typeof retryDeadline).toBe("number");
    expect(Number.isFinite(retryDeadline)).toBe(true);
    expect(retryDeadline).toBeGreaterThan(firstRetry?.created as number);

    const active = await a.json<{ data: Record<string, unknown> }>("/api/session/active");
    expect(active.data[sessionId]).toEqual({ type: "running" });

    // The retry state is durable on the assistant message BEFORE the kill.
    // Without this, "history still shows it" after restart would prove nothing.
    const projectionDeadline = Date.now() + 5_000;
    let assistant: SessionMessageRow | undefined;
    while (Date.now() < projectionDeadline) {
      const messages = await a.json<{ data: SessionMessageRow[] }>(
        `/api/session/${sessionId}/message`,
        { headers: headers() },
      );
      assistant = messages.data.find((message) => message.id === assistantMessageId);
      messageIdsBeforeKill = messages.data.map((message) => message.id ?? "");
      if (assistant?.retry !== undefined) break;
      await Bun.sleep(100);
    }

    expect(assistant?.retry?.attempt).toBe(retryAttempt);
    expect(assistant?.retry?.at).toBe(retryDeadline);
    durableRetry = assistant?.retry;

    console.log(
      `[retry-restart] before kill attempt=${retryAttempt} at=${retryDeadline} messages=${messageIdsBeforeKill.length}`,
    );
  }, 120_000);

  it("does not resume the wait or restore a countdown after the restart", async () => {
    const a = serverA;
    if (!a) throw new Error("first server is not running");
    if (!sessionId || !durableRetry) throw new Error("the retry was not recorded");

    stopA?.();
    // Stop ONLY the child this harness spawned. Nothing else is touched.
    await a.stop();
    serverA = undefined;
    killedAt = Date.now();
    requestsAtKill = stub.requests.length;
    expect(requestsAtKill).toBeGreaterThan(0);

    serverB = await startRuntimeOpenCodeServer(
      undefined,
      {
        XDG_DATA_HOME: path.join(isolation.root, "xdg-data"),
        OPENCODE_DB: path.join(isolation.root, "opencode-retry-restart.db"),
      },
      { isolation },
    );
    const controller = new AbortController();
    stopB = () => controller.abort();
    void subscribeRuntimeEvents(serverB, controller.signal, eventsB);
    await waitFor(
      () => eventsB.some((event) => event.type === "server.connected"),
      "restarted event stream did not report server.connected",
      TURN_TIMEOUT_MS,
    );

    // Hold past the original deadline. The deadline is the thing that would
    // have fired if a scheduler had been restored.
    const holdUntil = Math.max(retryDeadline + HOLD_PAST_DEADLINE_MS, Date.now() + 2_000);
    while (Date.now() < holdUntil) await Bun.sleep(100);
    expect(Date.now()).toBeGreaterThan(retryDeadline);

    const resumed = sessionEventsAfterKill(eventsB).filter(
      (event) =>
        event.type === "session.retry.scheduled" || event.type === "session.execution.started",
    );
    expect(resumed).toEqual([]);
    // No upstream request means no hidden resumption behind the event stream.
    expect(stub.requests.length).toBe(requestsAtKill);

    const active = await serverB.json<{ data: Record<string, unknown> }>("/api/session/active");
    expect(active.data[sessionId]).toBeUndefined();

    // The session and its history survive, and the durable retry is unchanged.
    const session = await serverB.json<{ data: { id?: string } }>(`/api/session/${sessionId}`, {
      headers: headers(),
    });
    expect(session.data.id).toBe(sessionId);

    const messages = await serverB.json<{ data: SessionMessageRow[] }>(
      `/api/session/${sessionId}/message`,
      { headers: headers() },
    );
    expect(messages.data.map((message) => message.id)).toEqual(messageIdsBeforeKill);
    const assistant = messages.data.find((message) => message.id === assistantMessageId);
    expect(assistant?.retry).toEqual(durableRetry);
    // The interrupted turn did not settle successfully while we were gone.
    expect(
      messages.data.some((message) => message.type === "idle" && message.outcome === "succeeded"),
    ).toBe(false);

    console.log(
      `[retry-restart] after restart: sessionEvents=${sessionEventsAfterKill(eventsB).length} requests=${stub.requests.length} active=absent durableRetry=preserved`,
    );
  }, 180_000);

  it("establishes a fresh deadline only after a new prompt", async () => {
    const b = serverB;
    if (!b) throw new Error("restarted server is not running");
    if (!sessionId || !durableRetry) throw new Error("the retry was not recorded");

    const mark = eventsB.length;
    await b.json(`/api/session/${sessionId}/prompt`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ text: "second prompt after the restart" }),
    });

    await waitFor(
      () =>
        eventsB
          .slice(mark)
          .some(
            (event) =>
              event.type === "session.retry.scheduled" &&
              (event.data?.sessionID as string | undefined) === sessionId,
          ),
      "the new prompt did not establish a new retry",
      TURN_TIMEOUT_MS,
    );

    const fresh = eventsB
      .slice(mark)
      .find(
        (event) =>
          event.type === "session.retry.scheduled" &&
          (event.data?.sessionID as string | undefined) === sessionId,
      );
    const data = fresh?.data ?? {};
    const freshDeadline = data.at as number;

    // A new live event, after the kill, with its own deadline. This is the
    // positive control: the hold window above was not merely a dead stream.
    expect(fresh?.created as number).toBeGreaterThan(killedAt);
    expect(freshDeadline).toBeGreaterThan(fresh?.created as number);
    expect(freshDeadline).not.toBe(retryDeadline);
    expect(data.attempt as number).toBeGreaterThan(1);
    expect(stub.requests.length).toBeGreaterThan(requestsAtKill);

    console.log(
      `[retry-restart] fresh wait after new prompt: attempt=${data.attempt} at=${freshDeadline} oldAt=${retryDeadline}`,
    );
  }, 120_000);
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
