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
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { mcpManager } from "@/services/mcp/manager.ts";
import { logger } from "@/lib/logger.ts";
import { REPO_ROOT } from "../../helpers/repo-root";
import { startGatedDiscoveryServer } from "../../fixtures/gated-discovery-server";

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
 * Wait briefly for a `connect()` to settle, then stop waiting.
 *
 * Whether the SDK's `connect()` promise settles at all after a `close()` during
 * the handshake is not the manager's to decide, and it varies with how far the
 * handshake got. What IS the manager's to decide - and what the cases using
 * this assert - is the observable state afterwards, so those assertions never
 * depend on that promise settling.
 */
async function settleOrGiveUp(attempt: Promise<void>, budgetMs = 1000): Promise<void> {
  await Promise.race([
    attempt.then(
      () => undefined,
      () => undefined,
    ),
    Bun.sleep(budgetMs),
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

/**
 * Gap 1 — the PRE-REGISTRATION window.
 *
 * `connect()` reads its config, then `await prior.client.close()`, and only
 * after that does `connections.set(id, conn)`. The entry it registered during
 * its OWN run is `prior`, so that await is a window in which the id can be
 * invalidated — and `connections.set` used to run unconditionally at the end of
 * it, using the config snapshot read BEFORE the window.
 *
 * So a disconnect, a disable or a delete landing in that window was undone: the
 * attempt registered a fresh connection anyway.
 *
 * ## Why these cases need no sleep and no timing luck
 *
 * `connect()` reaches `await prior.client.close()` inside its own synchronous
 * prefix. The caller's next statement therefore runs while the attempt is
 * parked there, and an awaited call cannot resume until the caller yields. The
 * invalidating call is issued from that statement, so it is guaranteed to land
 * inside the window - not probabilistically.
 *
 * The discriminator is also deliberately non-parked: these configs use a command
 * that fails FAST, so a buggy attempt reaches a terminal `"error"` rather than
 * sitting in `"connecting"`. The gate this covers is about registration, not
 * about what happens after it, and a terminal wrong state is unambiguous.
 */
describe("MCP pre-registration window: an invalidated attempt cannot register", () => {
  /** A stdio config whose transport fails fast, so a wrong state is terminal. */
  function failingCommandConfig(name: string): string {
    const created = mcpManager.createConfig({
      name,
      transport: "stdio",
      command: "definitely-not-a-real-command-9f3a",
      enabled: true,
      autoConnect: false,
    });
    createdIds.push(created.id);
    return created.id;
  }

  /**
   * Put a live entry in the map so a later `connect()` has a `prior` to close,
   * then let that first attempt settle. The entry stays; its timer is cleared by
   * the next attempt's teardown.
   */
  async function seedPrior(id: string): Promise<void> {
    await settleOrGiveUp(mcpManager.connect(id));
    expect(statusOf(id), "the seeding attempt did not register").not.toBe("missing");
  }

  it("a replacement interrupted by disconnect does not register", async () => {
    const id = failingCommandConfig("pre-disconnect");
    await seedPrior(id);

    // Parked on `await prior.client.close()`.
    const replacement = mcpManager.connect(id);
    // Invalidates while it is parked, before it can register.
    await mcpManager.disconnect(id);
    await settleOrGiveUp(replacement);

    expect(statusOf(id)).toBe("disconnected");
  });

  it("a replacement interrupted by a disable does not register", async () => {
    const id = failingCommandConfig("pre-disable");
    await seedPrior(id);

    const replacement = mcpManager.connect(id);
    // `setEnabled(false)` is the user's "turn this server off"; a replacement
    // that started before it must not bring the connection back.
    mcpManager.setEnabled(id, false);
    await settleOrGiveUp(replacement);

    expect(statusOf(id)).toBe("disconnected");
  });

  it("a replacement interrupted by a delete does not register", async () => {
    const id = failingCommandConfig("pre-delete");
    await seedPrior(id);
    const cutoff = logger.lastSeq;

    const replacement = mcpManager.connect(id);
    mcpManager.deleteConfig(id);
    await settleOrGiveUp(replacement);

    // `deleteConfig` drops the row, so `getStatuses()` cannot show a leaked
    // entry - the config it would be reported under no longer exists. The
    // observable is therefore the absence of the work a leaked attempt performs:
    // a registration would reach a transport and record a connect failure.
    // Absence, so throttling of the log scope cannot make this pass wrongly.
    const ops = operationsSince(cutoff, "pre-delete");
    expect(
      ops.filter((o) => o.op === "connect" && o.outcome === "error"),
      `a deleted server came back: ${JSON.stringify(ops)}`,
    ).toHaveLength(0);
    expect(
      ops.filter((o) => o.op === "reconnect"),
      `a deleted server reconnected: ${JSON.stringify(ops)}`,
    ).toHaveLength(0);
  });

  // NOT COVERED HERE, DELIBERATELY: an older attempt that resumes from the
  // PRE-REGISTRATION window after a newer attempt has already registered.
  //
  // Reaching it needs the older attempt's `prior.client.close()` to settle after
  // a newer attempt's, and that ordering lives inside the SDK. A first attempt
  // was written against a stdio child whose close measures slower than a second
  // close on the same client, and it failed 3 runs out of 8 under load - a test
  // whose outcome depends on an unobservable SDK duration is worse than no test,
  // so it was removed rather than retuned.
  //
  // The invariant it would have pinned IS covered, deterministically, by the
  // SSE-probe superseded-attempt case above: there a genuinely older attempt
  // resumes after a newer one has registered and must not overwrite it. What is
  // not covered is that same ordering reached from before registration, which
  // would need a controllable close to exist.
});

/**
 * Gap 2 — capability discovery.
 *
 * After `client.connect()`, `connect()` marks the entry `"connected"` and then
 * awaits `discoverCapabilities(id)`, which awaits `listTools`, `listResources`
 * and `listPrompts`. Discovery's catch blocks reported through
 * `pushEvent(id, ...)`, and `pushEvent` resolves the CURRENT connection - so a
 * discovery that resumed after a disconnect or a replacement appended its error
 * to someone else's event history. `connect()` also logged `outcome: "ok"`
 * after the await with no ownership check, so it reported success for a
 * connection that was no longer live.
 *
 * Status cannot be the guard here: the entry is `"connected"` by the time
 * discovery runs, so an ownership test that requires `"connecting"` is false by
 * construction. Identity plus the lifecycle generation are the guards that work.
 *
 * The gate is the fixture's `tools/list` response, which the fixture writes an
 * `entered` marker for and withholds until the test releases it.
 */
describe("MCP capability discovery cannot outlive its connection", () => {
  let nextPort = 3241;

  interface Gated {
    url: string;
    entered: string;
    releaseFile: string;
    release: () => Promise<void>;
    stop: () => void;
  }

  async function startGated(
    name: string,
    options: { open?: boolean; failOnRelease?: boolean } = {},
  ): Promise<Gated> {
    const entered = path.join(REPO_ROOT, "tests/.artifacts", `${name}-entered`);
    const releasePath = path.join(REPO_ROOT, "tests/.artifacts", `${name}-release`);
    for (const stale of [entered, releasePath]) {
      try {
        rmSync(stale);
      } catch {
        /* first run: nothing to clear */
      }
    }
    // An "open" server has its gate already satisfied, so its discovery never
    // stalls. A replacement pointed at one settles normally, which keeps the
    // assertion focused on what the STALE attempt does afterwards.
    if (options.open) await Bun.write(releasePath, "open");
    const port = nextPort++;
    const { stop } = await startGatedDiscoveryServer(port, releasePath, entered, options);
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      entered,
      releaseFile: releasePath,
      release: async () => {
        await Bun.write(releasePath, "go");
      },
      stop: () => stop(),
    };
  }

  function httpConfig(name: string, url: string): string {
    const created = mcpManager.createConfig({
      name,
      transport: "http",
      url,
      enabled: true,
      autoConnect: false,
    });
    createdIds.push(created.id);
    return created.id;
  }

  it("discovery interrupted by a disconnect reports no success", async () => {
    const cutoff = logger.lastSeq;
    const gated = await startGated("disc-disconnect");
    try {
      const id = httpConfig("disc-disconnect", gated.url);

      const attempt = mcpManager.connect(id);
      // Discovery is genuinely under way: the server is holding the response.
      expect(await waitForMarker(gated.entered), "discovery never started").toBe(true);

      await mcpManager.disconnect(id);
      // Only now does discovery resume.
      await gated.release();
      await settleOrGiveUp(attempt);

      expect(statusOf(id)).toBe("disconnected");
      const ops = operationsSince(cutoff, "disc-disconnect");
      expect(
        ops.filter((o) => o.op === "connect" && o.outcome === "ok"),
        `a disconnected connection reported success: ${JSON.stringify(ops)}`,
      ).toHaveLength(0);
    } finally {
      gated.stop();
    }
  });

  it("a superseded discovery writes no event into a live connection", async () => {
    // WHAT THIS CASE DOES AND DOES NOT PROVE: it passes on the unfixed manager
    // as well, so it is NOT evidence for the fix. The reason is a property of
    // the SDK, measured rather than assumed: closing a client SETTLES its
    // pending request immediately, and every replacement path closes the old
    // client BEFORE registering the new entry. The failure therefore lands
    // before a replacement can exist, so `pushEvent(id, ...)` resolves the old
    // connection and no interleaving was found that reaches the replacement's
    // history. The guard in `discoverCapabilities` is defence in depth for that
    // ordering rather than a demonstrated defect.
    //
    // It is kept because the invariant is real and cheap to hold, and because it
    // would start discriminating the moment the SDK stopped settling pending
    // requests at close - which is exactly the change that would make the
    // original leak reachable.
    const gated = await startGated("disc-superseded", { open: true, failOnRelease: true });
    const live = await startGated("disc-live", { open: true });
    try {
      const id = httpConfig("disc-superseded", gated.url);

      // Connect normally: the gate is open, so discovery completes and the
      // connection is healthy.
      await mcpManager.connect(id);
      expect(statusOf(id), "the first connect should have succeeded").toBe("connected");

      // Re-arm the gate, clearing the marker the first connect left behind, then
      // drive a SECOND discovery over the same live connection with refresh().
      // Nothing is torn down, so this parks cleanly inside `listTools` with the
      // connection still registered - which is the window under test.
      rmSync(gated.releaseFile);
      rmSync(gated.entered);
      const refreshing = mcpManager.refresh(id);
      expect(await waitForMarker(gated.entered), "refresh discovery never started").toBe(true);

      // Invalidate underneath the parked discovery, then put a healthy
      // replacement in place. `updateConfig` with a `url` is connection-affecting
      // and reconnects on its own, so it is what performs the replacement here;
      // starting a second `connect()` alongside it would just be two attempts
      // racing for the id.
      await mcpManager.disconnect(id);
      mcpManager.updateConfig(id, { url: live.url });
      expect(await waitForStatus(id, "connected", 15000), "the replacement never connected").toBe(
        true,
      );

      const liveEvents = mcpManager.getStatuses().find((s) => s.id === id)?.events.length ?? 0;

      // Now fail the parked discovery. The server answers with a JSON-RPC error,
      // which is what puts discovery into the catch block that reports through
      // `pushEvent(id, ...)`. Dropping the connection instead would leave the
      // request pending, so the catch would never run and nothing would be proved.
      await gated.release();
      await settleOrGiveUp(refreshing, 8000);

      // The stale discovery reports nothing. It must not append to the
      // replacement's event history, and it must not reach into shared state at
      // all now that its connection is gone.
      const after = mcpManager.getStatuses().find((s) => s.id === id);
      expect(
        after?.events.length ?? 0,
        "the superseded discovery appended to the replacement's event history",
      ).toBe(liveEvents);
    } finally {
      gated.stop();
      live.stop();
    }
  });
});
