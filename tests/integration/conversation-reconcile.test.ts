/**
 * `POST /api/conversations/reconcile` — the request-driven existence endpoint
 * the tab mirror converges against.
 *
 * Two properties are load-bearing and easy to lose:
 *
 *  1. COMPLETENESS. The response must answer every requested id, in request
 *     order, because the client's whole safety argument is that absence from
 *     this answer is proof of nonexistence. The handler therefore walks the
 *     REQUEST array, never the rows SQLite returned.
 *
 *  2. COMPLETENESS IS NOT INFERRED FROM THE LIST. `GET /api/conversations` is
 *     scoped (`workspaceMode` / `folderId` / `status`) and capped (`limit`),
 *     so an id missing from it may be archived or filtered rather than deleted.
 *     The archived case below is the regression guard for that trap.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to a temp
 * directory. Rows are seeded with a dedicated id prefix and removed again so
 * this file cannot leak state into suites that share the process.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { conversationService } from "../../src/services/storage";
import conversationsApp from "../../src/routes/conversations";

const app = new Hono();
app.route("/", conversationsApp);

const PREFIX = "reconcile-test-";
const SEEDED: string[] = [];

async function appFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: () => Promise<any> }> {
  const res = await app.request(path, init);
  return { status: res.status, json: () => res.json() };
}

function post(ids: unknown) {
  return appFetch("/api/conversations/reconcile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

/** Insert a conversation row directly, avoiding the workspace side effects of the create route. */
function seed(id: string, status: "regular" | "archived" = "regular"): string {
  const now = Date.now();
  db.run(
    `INSERT OR REPLACE INTO conversations (id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, `seeded ${id}`, status, now, now],
  );
  SEEDED.push(id);
  return id;
}

beforeEach(() => {
  for (const id of SEEDED.splice(0)) {
    db.run("DELETE FROM conversations WHERE id = ?", [id]);
  }
});

afterAll(() => {
  for (const id of SEEDED.splice(0)) {
    db.run("DELETE FROM conversations WHERE id = ?", [id]);
  }
});

describe("reconcile — verdicts", () => {
  it("reports exists for a conversation that is present", async () => {
    const id = seed(`${PREFIX}present`);
    const { status, json } = await post([id]);
    expect(status).toBe(200);
    const body = await json();
    expect(body.results).toEqual([{ id, status: "exists" }]);
  });

  it("reports gone for an id with no row", async () => {
    const { status, json } = await post([`${PREFIX}never-existed`]);
    expect(status).toBe(200);
    expect((await json()).results).toEqual([
      { id: `${PREFIX}never-existed`, status: "gone" },
    ]);
  });

  it("reports gone only for the missing ids in a mixed set", async () => {
    const live = seed(`${PREFIX}mixed-live`);
    const missing = `${PREFIX}mixed-missing`;
    const { status, json } = await post([live, missing]);
    expect(status).toBe(200);
    const { results } = await json();
    expect(results).toEqual([
      { id: live, status: "exists" },
      { id: missing, status: "gone" },
    ]);
  });

  it("reports an ARCHIVED conversation as exists", async () => {
    // The trap: an archived row is legitimately absent from
    // `?status=regular&limit=500`, so a list-based prune would evict a live tab.
    const archived = seed(`${PREFIX}archived`, "archived");
    const { results } = await (await post([archived])).json();
    expect(results).toEqual([{ id: archived, status: "exists" }]);
  });
});

describe("reconcile — completeness and ordering", () => {
  it("answers every requested id, in request order, including duplicates", async () => {
    const a = seed(`${PREFIX}ord-a`);
    const missing = `${PREFIX}ord-missing`;
    const requested = [missing, a, missing];
    const { results } = await (await post(requested)).json();
    // Cardinality AND order both mirror the request, duplicates included.
    expect(results).toHaveLength(3);
    expect(results.map((r: { id: string }) => r.id)).toEqual(requested);
    expect(results.map((r: { status: string }) => r.status)).toEqual([
      "gone",
      "exists",
      "gone",
    ]);
  });

  it("exposes only id and status — no conversation data", async () => {
    const id = seed(`${PREFIX}disclosure`);
    const body = await (await post([id])).json();
    expect(Object.keys(body)).toEqual(["results"]);
    expect(Object.keys(body.results[0]).sort()).toEqual(["id", "status"]);
    // Nothing that could leak a title, provider, or model into a reconciliation
    // response — this endpoint answers existence and nothing else.
    expect(JSON.stringify(body)).not.toContain("seeded");
    expect(JSON.stringify(body)).not.toContain("providerId");
  });
});

describe("reconcile — request validation", () => {
  it("rejects an empty id array", async () => {
    expect((await post([])).status).toBe(400);
  });

  it("rejects a body with no ids field", async () => {
    const res = await appFetch("/api/conversations/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ other: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-array ids value", async () => {
    expect((await post("nope")).status).toBe(400);
    expect((await post({ a: 1 })).status).toBe(400);
  });

  it("rejects a non-JSON body instead of throwing", async () => {
    const res = await appFetch("/api/conversations/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty-string id", async () => {
    expect((await post([""])).status).toBe(400);
  });

  it("rejects an id longer than 200 characters", async () => {
    expect((await post(["a".repeat(201)])).status).toBe(400);
  });

  it("accepts an id of exactly 200 characters", async () => {
    expect((await post(["a".repeat(200)])).status).toBe(200);
  });

  it("rejects more than 500 ids (bounded request size)", async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `${PREFIX}bulk-${i}`);
    expect((await post(tooMany)).status).toBe(400);
  });

  it("accepts exactly 500 ids", async () => {
    const exact = Array.from({ length: 500 }, (_, i) => `${PREFIX}bulk-${i}`);
    const { status, json } = await post(exact);
    expect(status).toBe(200);
    const { results } = await json();
    expect(results).toHaveLength(500);
    expect(results.every((r: { status: string }) => r.status === "gone")).toBe(true);
  });
});

describe("conversationService.existsMany", () => {
  it("returns only the ids that exist", async () => {
    const a = seed(`${PREFIX}many-a`);
    const b = seed(`${PREFIX}many-b`);
    const found = await conversationService.existsMany([
      a,
      `${PREFIX}many-absent`,
      b,
    ]);
    expect(found.has(a)).toBe(true);
    expect(found.has(b)).toBe(true);
    expect(found.has(`${PREFIX}many-absent`)).toBe(false);
    expect(found.size).toBe(2);
  });

  it("returns an empty set for an empty request without querying", async () => {
    const found = await conversationService.existsMany([]);
    expect(found.size).toBe(0);
  });

  it("never returns an id it was not asked about", async () => {
    const a = seed(`${PREFIX}subset-a`);
    const b = seed(`${PREFIX}subset-b`);
    const found = await conversationService.existsMany([a]);
    expect(found.has(b)).toBe(false);
  });

  it("chunks correctly beyond one query batch", async () => {
    // >500 ids forces the internal chunking path; seeded rows are spread across
    // chunks so a chunk-boundary bug cannot hide.
    const total = 1200;
    const ids = Array.from({ length: total }, (_, i) => `${PREFIX}chunk-${i}`);
    const seededHere = [0, 499, 500, 501, 1199].map((i) => seed(ids[i]));
    const found = await conversationService.existsMany(ids);
    expect(found.size).toBe(5);
    for (const id of seededHere) expect(found.has(id)).toBe(true);
  });
});
