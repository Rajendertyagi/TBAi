/**
 * `disabledTools` persistence through the MCP store (Phase 1 — per-tool
 * filtering, storage half).
 *
 * Uses the REAL database in the per-file sandbox that tests/setup.ts puts in
 * place (isolated DATA_DIR), with afterAll cleanup — the established pattern
 * for store tests in this repository, not a mocked DB.
 *
 * Contracts pinned here:
 *
 *   - insert with a non-empty `disabledTools` stores the JSON array in
 *     `disabled_tools`; an omitted or null value stores NULL.
 *   - update writes `disabled_tools` only when the field is PRESENT in the
 *     payload: a non-empty array stores JSON, an empty array stores "[]"
 *     (the empty array is truthy, so it is serialized, not nulled), and an
 *     explicit null stores NULL (the UI's "enable everything" action).
 *     Omitting the field on update preserves whatever is stored.
 *   - read maps a stored JSON value back onto `disabledTools`, a NULL/empty
 *     column back onto `undefined`, and UNPARSEABLE garbage back onto `[]`
 *     (corrupt data must degrade to "nothing disabled", never throw).
 */
import { describe, it, expect, afterAll } from "bun:test";
import { db } from "@/db";
import { deleteConfigRow, getConfig, insertConfig, updateConfigRow } from "@/services/mcp/store.ts";
import type { McpServerRow } from "@/services/mcp/store.ts";

const created: string[] = [];

function track(id: string): string {
  created.push(id);
  return id;
}

afterAll(() => {
  for (const id of created) {
    try {
      deleteConfigRow(id);
    } catch {
      /* row already gone */
    }
  }
});

function rawDisabledTools(id: string): string | null {
  return (
    db
      .query<{ disabled_tools: string | null }, [string]>(
        "SELECT disabled_tools FROM mcp_servers WHERE id = ?",
      )
      .get(id)?.disabled_tools ?? null
  );
}

describe("disabledTools — insert", () => {
  it("stores a non-empty array as JSON in the disabled_tools column", () => {
    const id = track(
      insertConfig({
        name: "ds-insert",
        transport: "http",
        url: "http://localhost:3000",
        disabledTools: ["echo", "fail"],
      }).id,
    );
    expect(JSON.parse(rawDisabledTools(id)!)).toEqual(["echo", "fail"]);
    expect(getConfig(id)?.disabledTools).toEqual(["echo", "fail"]);
  });

  it("stores NULL when disabledTools is omitted", () => {
    const id = track(
      insertConfig({ name: "ds-insert-none", transport: "http", url: "http://localhost:3000" }).id,
    );
    expect(rawDisabledTools(id)).toBeNull();
    expect(getConfig(id)?.disabledTools).toBeUndefined();
  });

  it("stores NULL when disabledTools is explicitly null", () => {
    const id = track(
      insertConfig({
        name: "ds-insert-null",
        transport: "http",
        url: "http://localhost:3000",
        disabledTools: null,
      }).id,
    );
    expect(rawDisabledTools(id)).toBeNull();
    expect(getConfig(id)?.disabledTools).toBeUndefined();
  });

  it('stores the empty array as JSON "[]" (an array is truthy, so it is serialized, not nulled)', () => {
    const id = track(
      insertConfig({
        name: "ds-insert-empty",
        transport: "http",
        url: "http://localhost:3000",
        disabledTools: [],
      }).id,
    );
    expect(rawDisabledTools(id)).toBe("[]");
    expect(getConfig(id)?.disabledTools).toEqual([]);
  });
});

describe("disabledTools — update", () => {
  function withServer(disabledTools?: string[] | null): string {
    return track(
      insertConfig({
        name: "ds-update-base",
        transport: "http",
        url: "http://localhost:3000",
        disabledTools,
      }).id,
    );
  }

  it("replaces the stored value when the field is present", () => {
    const id = withServer(["echo"]);
    updateConfigRow(id, { disabledTools: ["echo", "fail"] });
    expect(JSON.parse(rawDisabledTools(id)!)).toEqual(["echo", "fail"]);
    expect(getConfig(id)?.disabledTools).toEqual(["echo", "fail"]);
  });

  it("clears the column to NULL when the field is explicitly null", () => {
    const id = withServer(["echo"]);
    updateConfigRow(id, { disabledTools: null });
    expect(rawDisabledTools(id)).toBeNull();
    expect(getConfig(id)?.disabledTools).toBeUndefined();
  });

  it('stores "[]" for an empty array (not NULL)', () => {
    const id = withServer(["echo"]);
    updateConfigRow(id, { disabledTools: [] });
    expect(rawDisabledTools(id)).toBe("[]");
    expect(getConfig(id)?.disabledTools).toEqual([]);
  });

  it("leaves the stored value untouched when the field is omitted", () => {
    const id = withServer(["echo"]);
    updateConfigRow(id, { notes: "unrelated edit" });
    expect(rawDisabledTools(id)).toBe('["echo"]');
  });
});

describe("disabledTools — read (row → config mapping)", () => {
  it("parses a stored JSON array back into disabledTools", () => {
    const id = track(
      insertConfig({
        name: "ds-read",
        transport: "stdio",
        command: "npx",
        disabledTools: ["ask_user"],
      }).id,
    );
    expect(getConfig(id)?.disabledTools).toEqual(["ask_user"]);
  });

  it("maps a NULL column to undefined", () => {
    const id = track(
      insertConfig({ name: "ds-read-null", transport: "http", url: "http://localhost:3000" }).id,
    );
    expect(getConfig(id)?.disabledTools).toBeUndefined();
  });

  it("falls back to [] for unparseable garbage (corrupt data degrades, never throws)", () => {
    const id = track(
      insertConfig({
        name: "ds-read-corrupt",
        transport: "http",
        url: "http://localhost:3000",
        disabledTools: ["echo"],
      }).id,
    );
    // The store itself can only write valid JSON or NULL; the corrupt column
    // is a database-level incident, written directly to exercise the fallback.
    db.run("UPDATE mcp_servers SET disabled_tools = ? WHERE id = ?", ["{not-valid-json", id]);
    expect(getConfig(id)?.disabledTools).toEqual([]);
  });
});

/** Pin the row-shape contract the read path relies on (snake_case, TEXT). */
it("exposes the stored column through the McpServerRow shape", () => {
  const id = track(
    insertConfig({
      name: "ds-row-shape",
      transport: "http",
      url: "http://localhost:3000",
      disabledTools: ["echo"],
    }).id,
  );
  const row = db.query<McpServerRow, [string]>("SELECT * FROM mcp_servers WHERE id = ?").get(id);
  expect(row?.disabled_tools).toBe('["echo"]');
});
