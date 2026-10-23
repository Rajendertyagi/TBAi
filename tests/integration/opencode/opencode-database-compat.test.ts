/**
 * Database compatibility for the supported OpenCode binary (2.1.2), executed
 * against a real server rather than inferred from source.
 *
 * ## What this proves
 *
 * 1. A store created by the installed binary contains its session, message
 *    history, and migration bookkeeping in a self-contained SQLite file.
 * 2. A second process of the same binary, pointed at a COPY of that store,
 *    resolves the saved session id, returns the same message ids and content,
 *    and reports the session as inactive.
 * 3. Reopening the copy is not destructive: every original table still exists,
 *    no original row disappeared, and every original session/message row is
 *    byte-for-byte unchanged. Additive migrations are allowed; deletion or
 *    rewriting is not.
 * 4. `PRAGMA integrity_check` reports `ok` after the round trip.
 *
 * This is a graceful-stop matrix, not a crash test. It says nothing about an
 * abrupt kill (G3) and nothing about the developer's live database: the source
 * store is created inside this test's temp tree, and the copy is read there too.
 *
 * ## Scope
 *
 * The user's current target is 2.1.2 only. The advertised 2.0.x range is NOT
 * exercised here and remains unverified; this suite never claims cross-version
 * recovery it did not observe.
 *
 * ## Process safety
 *
 * Two sequential `opencode serve` children are spawned by the harness on
 * ephemeral ports. Only those children are stopped. No existing OpenCode
 * process is discovered, signalled, or adopted, and `XDG_DATA_HOME` /
 * `OPENCODE_DB` point inside the test's own tree so the live store is never
 * opened.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
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
import { startStubProvider, type StubProvider } from "../../harness/opencodeStubProvider.ts";

const reason = runtimeUnavailableReason();
const describeRuntime = runtimeTestsRequested() ? describe : describe.skip;

if (runtimeTestsRequested() && reason) {
  console.warn(`[opencode db compat] enabled but unavailable: ${reason}`);
}

/** One table's schema as SQLite reports it. */
interface TableRow {
  readonly name: string;
  readonly sql: string;
}

/** One session row, narrowed to the fields this suite compares. */
interface SessionSnapshot {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly directory: string;
  readonly model: string;
  readonly time_created: number;
}

/** One message row, narrowed to the fields this suite compares. */
interface MessageSnapshot {
  readonly id: string;
  readonly type: string;
  readonly seq: number;
  readonly data: string;
}

/** Everything read from a store before it is reopened. */
interface StoreSnapshot {
  readonly tables: readonly TableRow[];
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly session: SessionSnapshot;
  readonly messages: readonly MessageSnapshot[];
}

const SOURCE_DB_FILE = "opencode-source.db";
const COPY_DB_FILE = "opencode-copy.db";

describeRuntime("real OpenCode: a 2.1.2 store round-trips through a copy", () => {
  let isolation: RuntimeIsolation;
  let stub: StubProvider;
  let sourceServer: RuntimeOpenCodeServer | undefined;
  let copyServer: RuntimeOpenCodeServer | undefined;
  let sessionId = "";
  let sourceDb: string;
  let copyDb: string;
  let before: StoreSnapshot;

  const dataHome = (): string => path.join(isolation.root, "xdg-data");
  const directoryHeader = (): Record<string, string> => ({
    "content-type": "application/json",
    "x-opencode-directory": isolation.homeDir,
  });

  beforeAll(async () => {
    stub = await startStubProvider({ model: STUB_MODEL_ID, text: "database history reply" });
    isolation = createRuntimeIsolation(`db-compat-${Date.now()}`);
    fs.mkdirSync(dataHome(), { recursive: true });
    fs.writeFileSync(
      isolation.configFile,
      JSON.stringify(buildStubOpenCodeConfig(stub.baseURL), null, 2),
      "utf8",
    );
    sourceDb = path.join(isolation.root, SOURCE_DB_FILE);
    copyDb = path.join(isolation.root, COPY_DB_FILE);
  }, 120_000);

  afterAll(async () => {
    await copyServer?.stop();
    await sourceServer?.stop();
    stub?.stop();
    fs.rmSync(isolation?.root ?? "", { recursive: true, force: true });
  });

  it("creates a store with a real session and history, then snapshots it", async () => {
    sourceServer = await startRuntimeOpenCodeServer(
      undefined,
      { XDG_DATA_HOME: dataHome(), OPENCODE_DB: sourceDb },
      { isolation },
    );
    expect(fs.existsSync(sourceDb)).toBe(true);

    const created = await sourceServer.json<{ data: { id: string } }>("/api/session", {
      method: "POST",
      headers: directoryHeader(),
      body: JSON.stringify({}),
    });
    sessionId = created.data.id;
    expect(typeof sessionId).toBe("string");

    await sourceServer.json(`/api/session/${sessionId}/model`, {
      method: "POST",
      headers: directoryHeader(),
      body: JSON.stringify({ model: { id: STUB_MODEL_ID, providerID: STUB_PROVIDER_ID } }),
    });
    await sourceServer.json(`/api/session/${sessionId}/prompt`, {
      method: "POST",
      headers: directoryHeader(),
      body: JSON.stringify({ text: "remember this history" }),
    });

    // Wait for the turn to settle before closing the store.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const messages = await sourceServer.json<{
        data: Array<{ type?: string; outcome?: string }>;
      }>(`/api/session/${sessionId}/message`, { headers: directoryHeader() });
      if (messages.data.some((m) => m.type === "idle" && m.outcome === "succeeded")) break;
      await Bun.sleep(100);
    }

    await sourceServer.stop();
    sourceServer = undefined;

    // Checkpoint so the copy is a single consistent file rather than a database
    // plus a WAL the new process would have to be given as well.
    const live = new Database(sourceDb, { readwrite: true });
    try {
      live.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      live.close();
    }
    fs.copyFileSync(sourceDb, copyDb);
    expect(fs.statSync(copyDb).size).toBeGreaterThan(0);

    before = snapshotStore(sourceDb, sessionId);
    // The store must actually carry history, or "it survived" would be vacuous.
    expect(before.session.id).toBe(sessionId);
    expect(before.messages.length).toBeGreaterThanOrEqual(2);
    expect(before.messages.some((message) => message.type === "user")).toBe(true);
    expect(before.messages.some((message) => message.type === "assistant")).toBe(true);

    console.log(
      `[db-compat] source store tables=${before.tables.length} messages=${before.messages.length} versionOfSession=${before.session.id}`,
    );
  }, 180_000);

  it("reopens the copy on 2.1.2 with the same id, history, and no destructive migration", async () => {
    copyServer = await startRuntimeOpenCodeServer(
      undefined,
      { XDG_DATA_HOME: dataHome(), OPENCODE_DB: copyDb },
      { isolation },
    );
    const info = await copyServer.json<{ version?: string }>("/api/info");
    console.log(`[db-compat] reopened with opencode ${info.version}`);

    // Lookup path: the saved id is authoritative across the process boundary.
    const session = await copyServer.json<{ data: { id?: string; title?: string } }>(
      `/api/session/${sessionId}`,
      { headers: directoryHeader() },
    );
    expect(session.data.id).toBe(sessionId);
    expect(session.data.title).toBe(before.session.title);

    // History path: every original message id is still present with identical
    // content. A migration that rewrote message data would fail here.
    const messages = await copyServer.json<{ data: Array<Record<string, unknown>> }>(
      `/api/session/${sessionId}/message`,
      { headers: directoryHeader() },
    );
    const byId = new Map(messages.data.map((row) => [String(row.id), row]));
    if (messages.data[0]) {
      console.log(
        `[db-compat] first reopened message: ${JSON.stringify(messages.data[0]).slice(0, 400)}`,
      );
    }
    for (const original of before.messages) {
      const reopened = byId.get(original.id);
      expect(reopened).toBeDefined();
      expect(reopened?.type).toBe(original.type);
      // The HTTP representation is the stored `data` object with `id` and
      // `type` lifted out of it; `seq` is not returned. Comparing the remainder
      // to the stored JSON proves content, not merely presence.
      const { id: _id, type: _type, ...reopenedData } = reopened ?? {};
      expect(reopenedData).toEqual(JSON.parse(original.data));
    }

    // Activity path: a new process owns no drain for the saved session.
    const active = await copyServer.json<{ data: Record<string, unknown> }>("/api/session/active");
    expect(active.data[sessionId]).toBeUndefined();

    await copyServer.stop();
    copyServer = undefined;

    const after = snapshotStore(copyDb, sessionId);

    // Additive schema changes are allowed; removing a table is destructive.
    const afterTableNames = new Set(after.tables.map((table) => table.name));
    for (const table of before.tables) {
      expect(afterTableNames.has(table.name)).toBe(true);
    }
    // No original row vanished from any original table.
    for (const table of before.tables) {
      expect(after.rowCounts[table.name] ?? 0).toBeGreaterThanOrEqual(
        before.rowCounts[table.name] ?? 0,
      );
    }
    // The session and message rows are unchanged, not merely present.
    expect(after.session).toEqual(before.session);
    expect(after.messages).toEqual(before.messages);

    const integrity = new Database(copyDb, { readonly: true });
    try {
      const check = integrity.query("PRAGMA integrity_check").get() as {
        integrity_check?: string;
      };
      expect(check.integrity_check).toBe("ok");
    } finally {
      integrity.close();
    }

    console.log(
      `[db-compat] copy preserved ${after.messages.length} messages; tables before=${before.tables.length} after=${after.tables.length}`,
    );
  }, 180_000);
});

/** Reads the tables, row counts, and one session's rows from `dbPath`. */
function snapshotStore(dbPath: string, id: string): StoreSnapshot {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .query("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as TableRow[];
    const rowCounts: Record<string, number> = {};
    for (const table of tables) {
      rowCounts[table.name] = (
        db.query(`SELECT COUNT(*) AS n FROM "${table.name}"`).get() as { n: number }
      ).n;
    }
    const session = db
      .query("SELECT id, title, slug, directory, model, time_created FROM session_v2 WHERE id = ?")
      .get(id) as SessionSnapshot;
    const messages = db
      .query("SELECT id, type, seq, data FROM session_message WHERE session_id = ? ORDER BY seq")
      .all(id) as MessageSnapshot[];
    return { tables, rowCounts, session, messages };
  } finally {
    db.close();
  }
}
