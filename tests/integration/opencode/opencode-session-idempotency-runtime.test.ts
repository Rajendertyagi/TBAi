/**
 * RUNTIME proof of the upstream guarantees RT-001 relies on.
 *
 * The recovery design is only sound if OpenCode really treats a
 * caller-supplied session id as a stable correlation key: a repeat create must
 * return the SAME session (not a second identity, not a rebind to another
 * directory), concurrently or sequentially. This file asserts that against a
 * real `opencode serve` process instead of a stub, because a stub can only
 * confirm what we already assumed.
 *
 * It also pins the limit that shapes the reconciler: after a session is
 * removed, the id is free again and a create can mint a new session with it.
 * That is why a bare 404 never releases a risk-bearing create intent — a late
 * request can still commit — and why retention is bounded by an explicit
 * horizon rather than claimed as proof.
 *
 * Skipped unless `TBAI_OPENCODE_RUNTIME_TESTS=1`; the binary must be inside the
 * managed range. Isolates config AND data/cache/home, so the developer's own
 * OpenCode state is never touched.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  createRuntimeIsolation,
  runtimeTestsRequested,
  runtimeUnavailableReason,
  startRuntimeOpenCodeServer,
  type RuntimeOpenCodeServer,
} from "../../harness/opencodeRuntimeHarness.ts";

const reason = runtimeUnavailableReason();
const describeRuntime = runtimeTestsRequested() ? describe : describe.skip;

if (runtimeTestsRequested() && reason) {
  console.warn(`[opencode runtime] enabled but unavailable: ${reason}`);
}

const SESSION_ROUTE = "/api/session";
const SESSION_ID_PREFIX = "ses_rt001_";

type SessionBody = {
  id: string;
  location?: { directory?: string };
};

/** The V2 HTTP envelope: the session record rides under `data`. */
type SessionEnvelope = { data?: SessionBody };

function sessionPath(id: string): string {
  return `${SESSION_ROUTE}/${encodeURIComponent(id)}`;
}

describeRuntime("real OpenCode: caller-supplied session ids are idempotent", () => {
  let server: RuntimeOpenCodeServer;
  let workDir: string;
  let otherDir: string;
  let dataHome: string;
  let home: string;

  beforeAll(async () => {
    const isolation = createRuntimeIsolation("rt001-idempotency");
    workDir = path.join(isolation.root, "work");
    otherDir = path.join(isolation.root, "other");
    dataHome = path.join(isolation.root, "xdg-data");
    home = path.join(isolation.root, "home");
    for (const dir of [workDir, otherDir, dataHome, home]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // This suite needs no model catalogue, so unlike the other runtime tests it
    // CAN isolate data and home as well: the server's database is its own.
    server = await startRuntimeOpenCodeServer(
      undefined,
      { XDG_DATA_HOME: dataHome, HOME: home, USERPROFILE: home },
      { isolation },
    );
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  async function create(
    id: string,
    directory: string,
    title: string,
  ): Promise<{ status: number; body: SessionBody | null }> {
    const res = await fetch(`${server.baseUrl}${SESSION_ROUTE}`, {
      method: "POST",
      headers: { ...server.headers, "content-type": "application/json" },
      body: JSON.stringify({ id, location: { directory }, title }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text ? ((JSON.parse(text) as SessionEnvelope).data ?? null) : null,
    };
  }

  async function get(id: string): Promise<{ status: number; body: SessionBody | null }> {
    const res = await fetch(`${server.baseUrl}${sessionPath(id)}`, {
      headers: server.headers,
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text ? ((JSON.parse(text) as SessionEnvelope).data ?? null) : null,
    };
  }

  async function remove(id: string): Promise<number> {
    const res = await fetch(`${server.baseUrl}${sessionPath(id)}`, {
      method: "DELETE",
      headers: server.headers,
    });
    return res.status;
  }

  it("honours the supplied id and reports the submitted directory", async () => {
    const id = `${SESSION_ID_PREFIX}create1`;
    const created = await create(id, workDir, "first");
    expect(created.status).toBeGreaterThanOrEqual(200);
    expect(created.status).toBeLessThan(300);
    expect(created.body?.id).toBe(id);

    const read = await get(id);
    expect(read.status).toBe(200);
    expect(read.body?.id).toBe(id);
    expect(read.body?.location?.directory).toBe(workDir);
  });

  it("returns the SAME session for a sequential duplicate create", async () => {
    const id = `${SESSION_ID_PREFIX}sequential`;
    const first = await create(id, workDir, "first");
    const second = await create(id, workDir, "second");

    expect(first.body?.id).toBe(id);
    expect(second.body?.id).toBe(id);
    const read = await get(id);
    expect(read.body?.id).toBe(id);
    // The duplicate did not rebind the session to a new identity or directory.
    expect(read.body?.location?.directory).toBe(workDir);
  });

  it("converges concurrent creates for one id on a single session", async () => {
    const id = `${SESSION_ID_PREFIX}concurrent`;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        create(id, workDir, `concurrent-${index}`).catch((error) => ({
          status: -1,
          body: null,
          error,
        })),
      ),
    );

    // Every accepted request names the SAME caller-supplied id; none can have
    // minted a second identity for it.
    for (const result of results) {
      if (result.status < 0) continue;
      expect(result.body?.id).toBe(id);
    }
    expect(results.some((result) => result.status >= 200 && result.status < 300)).toBe(true);

    const read = await get(id);
    expect(read.status).toBe(200);
    expect(read.body?.id).toBe(id);
  });

  it("does not rebind an existing id to a different directory", async () => {
    const id = `${SESSION_ID_PREFIX}sbinding`;
    const first = await create(id, workDir, "original");
    expect(first.body?.location?.directory).toBe(workDir);

    const duplicate = await create(id, otherDir, "moved");
    expect(duplicate.status).toBeGreaterThanOrEqual(200);
    expect(duplicate.status).toBeLessThan(300);
    expect(duplicate.body?.id).toBe(id);

    const read = await get(id);
    expect(read.body?.location?.directory).toBe(workDir);
  });

  /**
   * The documented limitation: removal frees the id. A request that is still
   * outstanding when the reconciler removes the session can therefore recreate
   * it. This is exactly why the reconciler retains a risk-bearing intent until
   * the absence horizon instead of treating a 404 as terminal — and why it is
   * reported as bounded best effort rather than proof.
   */
  it("frees the id on removal, so a late create can recreate it", async () => {
    const id = `${SESSION_ID_PREFIX}removed`;
    await create(id, workDir, "before-remove");
    expect(await remove(id)).toBe(204);

    const gone = await get(id);
    expect(gone.status).toBe(404);

    const recreated = await create(id, workDir, "after-remove");
    expect(recreated.status).toBeGreaterThanOrEqual(200);
    expect(recreated.status).toBeLessThan(300);
    expect(recreated.body?.id).toBe(id);
    expect((await get(id)).status).toBe(200);
  });
});
