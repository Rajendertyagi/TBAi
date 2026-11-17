/**
 * P0 reconstruction gate for managed OpenCode restart recovery.
 *
 * ## What this proves
 *
 * That the facts the recovery service needs are reconstructible from durable
 * OpenCode state alone, after the managed child is hard-killed and restarted
 * against the same database. No TBAi-side persistent state is assumed. This is
 * the gate from §8 of `docs/2026-11-16-opencode-durable-recovery-plan.md`: if
 * these assertions pass, the design needs no new table or migration.
 *
 * Both restart scenarios reduce to the same durable signature from OpenCode's
 * point of view: a new child reading the same `opencode.db`. A hard `child.kill()`
 * (SIGKILL on Windows) leaves no graceful-shutdown event, which is the strictest
 * case. The native restart sweep is service-mode only, so plain `serve` leaves
 * the interrupted state untouched for TBAi to reconstruct.
 *
 * ## Finding captured by this test (P0-a)
 *
 * Plain `opencode serve` does NOT enable `events.persist` (only the workerd
 * deployment does). Consequently `session.log` replays no durable events after a
 * restart — it returns only a `log.synced` marker. The public projected-message
 * schema exposes no sequence number either. Detection therefore relies on the
 * durable `time.busy`/`time.idle` fields and typed `session.inbox.list()` items,
 * and ordering relies on the inbox's durable `enqueued_seq` (read here directly
 * from the DB as a diagnostic; it is NOT exposed by the public inbox schema).
 * This is a material deviation from the plan's `session.log`-based design and is
 * asserted explicitly so the reviewer sees it rather than a silent failure.
 *
 * ## Gating
 *
 * Skipped unless `TBAI_OPENCODE_RUNTIME_TESTS=1` and a supported binary exists.
 * Uses a scratch XDG tree and a stub provider; never the developer's real DB.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import { Database } from "bun:sqlite";
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

const reason = runtimeUnavailableReason();
const describeRuntime = runtimeTestsRequested() ? describe : describe.skip;

if (runtimeTestsRequested() && reason) {
  console.warn(`[opencode P0 reconstruction] enabled but unavailable: ${reason}`);
}

// ---------------------------------------------------------------------------
// Minimal wire shapes (only the fields the assertions read).
// ---------------------------------------------------------------------------

interface SessionInfoWire {
  readonly id: string;
  readonly time: { created: number; updated: number; busy?: number; idle?: number };
  readonly outcome?: "succeeded" | "failed" | "interrupted";
}

interface InboxItemWire {
  readonly id: string;
  readonly type: "user" | "synthetic" | "compaction" | "move";
  readonly payload: { metadata?: Record<string, unknown>; text?: string };
  readonly time: { created: number };
}

interface MessageWire {
  readonly id: string;
  readonly type: string;
}

const RECOVERY_NOTICE = "opencode-restart";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  predicate: (value: T) => boolean,
  label: string,
  attempts = 120,
  intervalMs = 500,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value !== undefined && predicate(value)) return value;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Reads the durable session log (SSE, follow=false) to completion. */
async function readSessionLog(
  server: RuntimeOpenCodeServer,
  sessionId: string,
  directory: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${server.baseUrl}/api/experimental/session/${sessionId}/log?after=0`, {
    headers: { ...server.headers, "x-opencode-directory": directory },
  });
  if (!res.ok) {
    throw new Error(
      `session.log ${sessionId} -> ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const text = await res.text();
  const events: Array<Record<string, unknown>> = [];
  for (const frame of text.split("\n\n")) {
    const line = frame.split("\n").find((part) => part.startsWith("data: "));
    if (!line) continue;
    const payload = line.slice("data: ".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      // A non-JSON SSE frame is not a durable event; ignore it.
    }
  }
  return events;
}

describeRuntime("P0: durable reconstruction after a hard managed-OpenCode restart", () => {
  let isolation: RuntimeIsolation;
  let stub: StubProvider;
  let serverA: RuntimeOpenCodeServer;
  let serverB: RuntimeOpenCodeServer;
  let directory: string;

  /** Controls the stub's upstream latency so one turn can be interrupted mid-flight. */
  let upstreamDelayMs = 0;

  const ids = {
    completed: "",
    interrupted: "",
    pendingUser: "",
    pendingSynthetic: "",
    superseded: "",
  };
  const recoveryIds = {
    pendingSynthetic: "msg_recovery_pending_p0",
    supersededA: "msg_recovery_superseded_p0",
    supersededUser: "msg_user_superseded_p0",
    pendingUser: "msg_user_pending_p0",
  };

  const api = <T>(server: RuntimeOpenCodeServer, pathname: string): Promise<T> =>
    server.json<T>(pathname, { headers: { "x-opencode-directory": directory } });

  const post = <T>(server: RuntimeOpenCodeServer, pathname: string, body: unknown): Promise<T> =>
    server.json<T>(pathname, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": directory },
      body: JSON.stringify(body),
    });

  async function createSession(server: RuntimeOpenCodeServer): Promise<string> {
    const created = await post<{ data: { id: string } }>(server, "/api/session", {});
    expect(typeof created?.data?.id).toBe("string");
    return created.data.id;
  }

  async function selectStubModel(server: RuntimeOpenCodeServer, sessionId: string): Promise<void> {
    await post(server, `/api/session/${sessionId}/model`, {
      model: { id: STUB_MODEL_ID, providerID: STUB_PROVIDER_ID },
    });
  }

  async function getSessionOrNull(
    server: RuntimeOpenCodeServer,
    sessionId: string,
  ): Promise<SessionInfoWire | null> {
    try {
      const res = await api<{ data: SessionInfoWire }>(server, `/api/session/${sessionId}`);
      return res.data;
    } catch (error) {
      if (String(error).includes("-> 404:")) return null;
      throw error;
    }
  }

  async function inbox(server: RuntimeOpenCodeServer, sessionId: string): Promise<InboxItemWire[]> {
    const res = await api<{ data: InboxItemWire[] }>(server, `/api/session/${sessionId}/inbox`);
    return res.data ?? [];
  }

  async function messages(
    server: RuntimeOpenCodeServer,
    sessionId: string,
  ): Promise<MessageWire[]> {
    const res = await api<{ data: MessageWire[] }>(server, `/api/session/${sessionId}/message`);
    return res.data ?? [];
  }

  beforeAll(async () => {
    stub = await startStubProvider({
      model: STUB_MODEL_ID,
      respond: async (request) => {
        if (upstreamDelayMs > 0) await Bun.sleep(upstreamDelayMs);
        return summariseStubRequest(request);
      },
    });
    isolation = createRuntimeIsolation("restart-reconstruction-p0");
    fs.writeFileSync(
      isolation.configFile,
      JSON.stringify(buildStubOpenCodeConfig(stub.baseURL), null, 2),
      "utf8",
    );
    serverA = await startRuntimeOpenCodeServer(undefined, {}, { isolation });
    directory = isolation.homeDir;
  }, 180_000);

  afterAll(async () => {
    await serverB?.stop();
    await serverA?.stop();
    stub?.stop();
    fs.rmSync(isolation?.root ?? "", { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Phase 1: establish durable states against serverA.
  // -------------------------------------------------------------------------

  it("phase 1: create a completed turn, pending inputs, and an interrupted turn", async () => {
    // (a) A completed session: stub answers, turn reaches a terminal state.
    ids.completed = await createSession(serverA);
    await selectStubModel(serverA, ids.completed);
    await post(serverA, `/api/session/${ids.completed}/prompt`, { text: "finish this turn" });
    await waitFor(
      () => getSessionOrNull(serverA, ids.completed),
      (info) => info?.time.idle !== undefined || info?.outcome === "succeeded",
      "completed session to settle",
    );

    // (b) A pending original user prompt: admitted with resume=false, never delivered.
    ids.pendingUser = await createSession(serverA);
    await post(serverA, `/api/session/${ids.pendingUser}/prompt`, {
      id: recoveryIds.pendingUser,
      text: "pending user prompt",
      resume: false,
    });

    // (c) A pending recovery synthetic: admitted with resume=false, marker persisted.
    ids.pendingSynthetic = await createSession(serverA);
    await post(serverA, `/api/session/${ids.pendingSynthetic}/synthetic`, {
      id: recoveryIds.pendingSynthetic,
      text: "The server restarted while you were working. Continue from where you left off.",
      metadata: { notice: RECOVERY_NOTICE },
      delivery: "steer",
      resume: false,
    });

    // (d) A superseded synthetic: recovery synthetic A, then a newer user message.
    ids.superseded = await createSession(serverA);
    await post(serverA, `/api/session/${ids.superseded}/synthetic`, {
      id: recoveryIds.supersededA,
      text: "older recovery synthetic",
      metadata: { notice: RECOVERY_NOTICE },
      delivery: "steer",
      resume: false,
    });
    await post(serverA, `/api/session/${ids.superseded}/prompt`, {
      id: recoveryIds.supersededUser,
      text: "newer user message",
      resume: false,
    });

    // (e) An interrupted turn: delay the stub, start execution, then hard-kill.
    // Execution start is detected via the durable time.busy field (session.log
    // has no durable events in plain serve — see P0-a).
    upstreamDelayMs = 15_000;
    ids.interrupted = await createSession(serverA);
    await selectStubModel(serverA, ids.interrupted);
    await post(serverA, `/api/session/${ids.interrupted}/prompt`, { text: "long running work" });
    await waitFor(
      () => getSessionOrNull(serverA, ids.interrupted),
      (info) => info?.time.busy !== undefined && info?.time.idle === undefined,
      "interrupted session to be busy",
    );
  }, 180_000);

  it("phase 2: hard-kill the child and restart against the same durable DB", async () => {
    await serverA.stop();
    upstreamDelayMs = 0;
    serverB = await startRuntimeOpenCodeServer(undefined, {}, { isolation });
    const resumed = await getSessionOrNull(serverB, ids.interrupted);
    expect(resumed).not.toBeNull();
  }, 180_000);

  // -------------------------------------------------------------------------
  // P0 assertions against the restarted child.
  // -------------------------------------------------------------------------

  it("P0-a: unfinished vs completed sessions are distinguishable from durable state", async () => {
    const completed = await getSessionOrNull(serverB, ids.completed);
    expect(completed).not.toBeNull();
    expect(completed?.time.idle).toBeGreaterThan(0);

    const interrupted = await getSessionOrNull(serverB, ids.interrupted);
    expect(interrupted).not.toBeNull();
    // First-ever execution was interrupted: busy is set, idle is absent.
    expect(interrupted?.time.busy).toBeGreaterThan(0);
    expect(interrupted?.time.idle).toBeUndefined();

    // Finding: plain serve does not persist events, so session.log replays no
    // durable lifecycle events after a restart — only the synced marker.
    const events = await readSessionLog(serverB, ids.interrupted, directory);
    const durableEvents = events.filter((event) => event.type !== "log.synced");
    expect(durableEvents).toHaveLength(0);
    expect(events.some((event) => event.type === "log.synced")).toBe(true);
  }, 120_000);

  it("P0-b: a pending user prompt is re-submitted with its original ID, no duplicate", async () => {
    const before = await inbox(serverB, ids.pendingUser);
    const original = before.find((item) => item.id === recoveryIds.pendingUser);
    expect(original?.type).toBe("user");

    // Re-submit with the SAME id and resume=false so the item stays pending and
    // the no-duplicate property is directly observable in the inbox.
    await post(serverB, `/api/session/${ids.pendingUser}/prompt`, {
      id: recoveryIds.pendingUser,
      text: "pending user prompt",
      resume: false,
    });

    const after = await inbox(serverB, ids.pendingUser);
    const matches = after.filter((item) => item.id === recoveryIds.pendingUser);
    expect(matches).toHaveLength(1);
    expect(after.filter((item) => item.type === "user")).toHaveLength(1);
  }, 120_000);

  it("P0-c: a recovery synthetic ID is found in durable history and reused on re-post", async () => {
    const before = await inbox(serverB, ids.pendingSynthetic);
    const marker = before.find(
      (item) => item.type === "synthetic" && item.payload.metadata?.notice === RECOVERY_NOTICE,
    );
    expect(marker).toBeDefined();
    expect(marker?.id).toBe(recoveryIds.pendingSynthetic);

    // Re-post the same ID; reconcile returns the existing admission (HTTP 200).
    await post(serverB, `/api/session/${ids.pendingSynthetic}/synthetic`, {
      id: recoveryIds.pendingSynthetic,
      text: "The server restarted while you were working. Continue from where you left off.",
      metadata: { notice: RECOVERY_NOTICE },
      delivery: "steer",
      resume: false,
    });

    const after = await inbox(serverB, ids.pendingSynthetic);
    expect(after.filter((item) => item.id === recoveryIds.pendingSynthetic)).toHaveLength(1);
    const syntheticMessages = (await messages(serverB, ids.pendingSynthetic)).filter(
      (message) => message.id === recoveryIds.pendingSynthetic,
    );
    expect(syntheticMessages.length).toBeLessThanOrEqual(1);
  }, 120_000);

  it("P0-d: a superseded pending synthetic is cancelled using durable enqueue ordering", async () => {
    // Diagnostic: the inbox's durable enqueued_seq exists in the DB but is NOT
    // exposed by the public inbox schema. Read it directly to prove the ordering
    // data survives the restart; the production service cannot use this column
    // through the public API — a second material finding for the plan.
    const db = new Database(isolation.opencodeDbPath, { readonly: true });
    const rows = db
      .query("SELECT id, enqueued_seq FROM session_inbox WHERE session_id = ?")
      .all(ids.superseded) as Array<{ id: string; enqueued_seq: number }>;
    db.close();
    const seqById = new Map(rows.map((row) => [row.id, row.enqueued_seq]));
    expect(seqById.has(recoveryIds.supersededA)).toBe(true);
    expect(seqById.has(recoveryIds.supersededUser)).toBe(true);
    expect(seqById.get(recoveryIds.supersededUser)!).toBeGreaterThan(
      seqById.get(recoveryIds.supersededA)!,
    );

    // The newer user message supersedes the older recovery synthetic: cancel it.
    await serverB.json(`/api/session/${ids.superseded}/inbox/${recoveryIds.supersededA}`, {
      method: "DELETE",
      headers: { "x-opencode-directory": directory },
    });

    const after = await inbox(serverB, ids.superseded);
    expect(after.some((item) => item.id === recoveryIds.supersededA)).toBe(false);
    expect(after.some((item) => item.id === recoveryIds.supersededUser)).toBe(true);
  }, 120_000);

  it("P0-e: sessions that 404 on the managed child are skipped safely", async () => {
    const missing = await getSessionOrNull(serverB, "ses_does_not_exist_p0");
    expect(missing).toBeNull();
  }, 120_000);
});
