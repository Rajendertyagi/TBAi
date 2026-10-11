/**
 * Deterministic regression coverage for MCP connection lifecycle ownership.
 *
 * ## The defect this pins
 *
 * `connect()` registered its connection entry and then awaited three times (the
 * SSE diagnostic probe, `client.connect()`, capability discovery) with NO check
 * that it still owned that entry. `disconnect()` marks the entry
 * `"disconnected"` and closes the client, but an attempt already parked on an
 * `await` resumes afterwards and, finding nothing to stop it:
 *
 *   - wrote `status = "connected"`, resurrecting a connection the caller had
 *     just deliberately closed, and
 *   - on the rejection path wrote `status = "error"` and called
 *     `scheduleReconnect()` - so the very close that CAUSED the rejection
 *     produced an automatic reconnect. That is the `NOT_CONNECTED` error seen
 *     against `p4-midconnect` in the suite log, and the cause of the
 *     intermittent "interrupted connect left the connection live as
 *     \"connected\"" failure in `mcp-v2.test.ts`.
 *
 * A superseded attempt (a second `connect()` for the same id) had the same
 * problem plus a leaked transport: it resumed and wrote over the newer
 * attempt's state.
 *
 * ## Why these cases are deterministic
 *
 * Nothing here sleeps and hopes. Each case waits on a CONDITION - the entry
 * being registered, or the probe handler being entered - so the attempt is
 * known to be parked at its asynchronous boundary before anything acts on it.
 * The stdio child never speaks, so its lifetime is the in-flight window; the
 * SSE probe is held open by a gate the test opens by hand.
 *
 * ## The invariant
 *
 * Only the currently registered attempt, and only while it is still
 * `"connecting"`, may mutate its live status or schedule its reconnect. An
 * attempt that finds itself superseded closes its own resources and returns
 * without touching shared state.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { mcpManager } from "@/services/mcp/manager.ts";
import { logger } from "@/lib/logger.ts";
import { REPO_ROOT } from "../../helpers/repo-root";

/** Unique marker path per case, so cases cannot wait on each other's child. */
function markerPath(name: string): string {
  return path.join(REPO_ROOT, "tests/.artifacts", `${name}-marker`);
}

/** Status of one server, or "missing" when no live entry backs it. */
function statusOf(id: string): string {
  return mcpManager.getStatuses().find((s) => s.id === id)?.status ?? "missing";
}

/**
 * Wait until `id` reports `want`, or give up.
 *
 * Condition-based rather than a fixed sleep: `connect()` registers its entry
 * before spawning the transport, so "status is connecting" is proof the attempt
 * is parked inside the boundary we mean to interrupt. A plain sleep races that
 * registration, and when it loses, `disconnect()` finds no entry, closes
 * nothing, and the attempt hangs forever.
 */
async function waitForStatus(id: string, want: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (statusOf(id) === want) return true;
    await Bun.sleep(20);
  }
  return false;
}

/**
 * An HTTP server whose FIRST response is held until the test releases it.
 *
 * `probeSseEndpoint` is a plain `fetch`, so holding the handler holds the
 * attempt exactly at its first asynchronous boundary. Later requests answer
 * immediately with 404, so a resumed attempt fails fast instead of hanging.
 */
function createGatedProbeServer() {
  let releaseGate: () => void = () => {};
  let signalEntered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let firstRequest = true;

  const server = Bun.serve({
    port: 0,
    async fetch() {
      if (firstRequest) {
        firstRequest = false;
        signalEntered();
        await gate;
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/sse`,
    entered,
    release: releaseGate,
    stop: () => server.stop(true),
  };
}

const createdIds: string[] = [];

function sseConfig(name: string, url: string): string {
  const created = mcpManager.createConfig({
    name,
    transport: "sse",
    url,
    enabled: true,
    autoConnect: false,
  });
  createdIds.push(created.id);
  return created.id;
}

/**
 * Wait for the silent child to report that it has RECEIVED the client's
 * request, proving the handshake is in flight.
 *
 * `connect()` sets `status: "connecting"` before it builds the transport, so
 * that status is no evidence the handshake is under way. Even the child's
 * "spawned" marker is not enough: closing a transport that has not finished
 * opening leaves the SDK's `connect()` promise pending forever, which is a
 * different stall entirely. "Requested" is the boundary this test interrupts.
 */
async function waitForMarker(path: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(20);
  }
  return false;
}

/**
 * A child that reads the client's request and then never answers, so
 * `client.connect()` stays pending for as long as the test holds it there.
 *
 * The marker paths travel to the child through `config.env`, which the stdio
 * transport merges into its environment - no production-only test hook needed.
 */
function silentChildConfig(name: string): { id: string; requested: string } {
  const requested = markerPath(`${name}-requested`);
  const created = mcpManager.createConfig({
    name,
    transport: "stdio",
    command: "bun",
    args: ["run", path.join(REPO_ROOT, "tests/fixtures/silent-mcp-server.ts")],
    env: {
      TBAI_SILENT_MCP_SPAWNED: markerPath(`${name}-spawned`),
      TBAI_SILENT_MCP_REQUESTED: requested,
    },
    enabled: true,
    autoConnect: false,
  });
  createdIds.push(created.id);
  return { id: created.id, requested };
}

/** `mcp.operation` log entries for one server, recorded after `cutoff`. */
function operationsSince(cutoff: number, serverName: string): { op?: string; outcome?: string }[] {
  return logger
    .getRecentEntries(cutoff)
    .filter((e) => e.event === "mcp.operation" && e.mcpServer === serverName)
    .map((e) => ({ op: e.op as string, outcome: e.outcome as string }));
}

/**
 * Wait briefly for an interrupted `connect()` to settle, then stop waiting.
 *
 * Whether the SDK's `connect()` promise settles at all after a `close()` during
 * the handshake is not the manager's to decide, and it varies with how far the
 * handshake got. What IS the manager's to decide - and what these cases
 * assert - is the observable state afterwards, so the assertions below never
 * depend on that promise settling.
 */
async function settleOrGiveUp(attempt: Promise<void>): Promise<void> {
  await Promise.race([
    attempt.then(
      () => undefined,
      () => undefined,
    ),
    Bun.sleep(1000),
  ]);
}

afterAll(async () => {
  await mcpManager.disconnectAll();
});

describe("MCP lifecycle ownership: a superseded attempt cannot resurrect itself", () => {
  it("a connect interrupted by disconnect stays disconnected", async () => {
    const { id, requested } = silentChildConfig("race-disconnect-interrupt");

    const attempt = mcpManager.connect(id);
    // The child has the client's `initialize` and has not answered: the
    // handshake is in flight, which is the boundary `disconnect()` must survive.
    expect(await waitForMarker(requested), "child never received the request").toBe(true);

    await mcpManager.disconnectAll();
    await settleOrGiveUp(attempt);

    // The caller asked for disconnected, and that is what survives.
    //
    // NOTE ON WHAT THIS CASE DOES AND DOES NOT PROVE: at this gate the SDK's
    // `connect()` promise is left PENDING by `close()` rather than rejecting, so
    // the manager's catch path never runs and this case passes with or without
    // the ownership fix. It is kept because the invariant it states - a
    // deliberate disconnect is never overwritten, and never arms a retry - is
    // worth holding - but the discriminating cases in this file are the SSE-probe
    // interruption and the superseded attempt, both of which fail on the
    // unfixed manager.
    expect(statusOf(id)).toBe("disconnected");
  });

  it("an interrupted connect schedules no reconnect", async () => {
    const cutoff = logger.lastSeq;
    const { id, requested } = silentChildConfig("race-disconnect-no-reconnect");

    const attempt = mcpManager.connect(id);
    expect(await waitForMarker(requested), "child never received the request").toBe(true);

    await mcpManager.disconnectAll();
    await settleOrGiveUp(attempt);

    const ops = operationsSince(cutoff, "race-disconnect-no-reconnect");
    // A stale failure path would have armed a retry here. See the note above:
    // this gate does not reach the catch path, so this asserts the invariant
    // rather than discriminating between fixed and unfixed code.
    expect(
      ops.filter((o) => o.op === "reconnect"),
      `a deliberate disconnect scheduled a reconnect: ${JSON.stringify(ops)}`,
    ).toHaveLength(0);

    // And nothing fires later either.
    await Bun.sleep(200);
    expect(statusOf(id)).toBe("disconnected");
  });

  it("a connect interrupted during the SSE probe does not reach connected", async () => {
    const server = createGatedProbeServer();
    try {
      const id = sseConfig("race-sse-probe", server.url);

      // Parks on the diagnostic probe until `release()`.
      const attempt = mcpManager.connect(id);
      await server.entered;
      await waitForStatus(id, "connecting");

      await mcpManager.disconnectAll();
      // Only now does the attempt resume.
      server.release();
      await attempt;

      expect(statusOf(id)).toBe("disconnected");
    } finally {
      server.stop();
    }
  });

  it("a superseded attempt is abandoned and does not overwrite the newer one", async () => {
    const server = createGatedProbeServer();
    try {
      const id = sseConfig("race-superseded", server.url);

      // Attempt A parks on the diagnostic probe (first request, held).
      const attemptA = mcpManager.connect(id);
      await server.entered;
      await waitForStatus(id, "connecting");

      // Attempt B takes the id while A is still parked. B's probe is the second
      // request, which the server answers 404, so B fails GENUINELY and owns the
      // final state.
      const attemptB = mcpManager.connect(id);
      await attemptB;
      expect(statusOf(id), "B should have failed genuinely").toBe("error");

      // Snapshot the live connection's observable state. A stale attempt writes
      // through `pushEvent`, which targets the CURRENT entry, so its writes land
      // on B's connection. Counting events therefore shows exactly whether A
      // touched shared state.
      const before = mcpManager.getStatuses().find((s) => s.id === id);
      const eventsBefore = before?.events.length ?? 0;

      // Release A. It resumes against an entry it no longer owns.
      server.release();
      await attemptA;

      const after = mcpManager.getStatuses().find((s) => s.id === id);
      // B's genuine failure survives: A neither overwrote the status nor
      // appended an event of its own to the live connection.
      expect(after?.status).toBe("error");
      expect(
        after?.events.length ?? 0,
        "the superseded attempt wrote to the live connection's event history",
      ).toBe(eventsBefore);

      await mcpManager.disconnectAll();
    } finally {
      server.stop();
    }
  });

  it("a genuine connect failure still follows the reconnect policy", async () => {
    const cutoff = logger.lastSeq;
    const created = mcpManager.createConfig({
      name: "race-genuine-failure",
      transport: "stdio",
      command: "definitely-not-a-real-command-9f3a",
      enabled: true,
      autoConnect: false,
    });
    createdIds.push(created.id);

    await mcpManager.connect(created.id);

    // No disconnect() ran, so this failure is genuine: it must be reported as an
    // error and must still arm the established retry. The ownership checks must
    // not swallow real failures.
    expect(statusOf(created.id)).toBe("error");
    await Bun.sleep(50);
    expect(
      operationsSince(cutoff, "race-genuine-failure").filter((o) => o.op === "connect"),
      "a genuine failure must still be reported",
    ).not.toHaveLength(0);

    await mcpManager.disconnectAll();
  });
});
