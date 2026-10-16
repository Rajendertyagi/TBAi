import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ProviderRegistry } from "@/config/providers.ts";
import type { ProviderConfig } from "@/types";

/**
 * Active-provider lifecycle for `ProviderRegistry.loadFromDb()`.
 *
 * The defect these cover: `loadFromDb` cleared the provider map but never
 * reset `activeProviderId`, so an id belonging to a deleted provider survived
 * every later reload. The `!this.activeProviderId` fallback could then never
 * fire again, and `getActive()` returned `undefined` while usable providers
 * sat in the map — which the chat route reports as "No provider configured".
 *
 * Each test owns its database. The REGISTRY is the module singleton, so its
 * state deliberately carries between tests here: that carry-over is the defect
 * surface. The first test therefore runs while the registry is still pristine,
 * because that is the only state in which the no-active-row fallback is
 * observable at all.
 */

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE provider_configs (" +
      "id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, " +
      "endpoint TEXT, model TEXT NOT NULL, models TEXT, thinking TEXT, " +
      "api_protocol TEXT, is_active INTEGER DEFAULT 0, " +
      "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  );
  return db;
}

function seed(
  db: Database,
  rows: Array<
    Partial<ProviderConfig> & { id: string; type: ProviderConfig["type"]; model: string }
  >,
) {
  const now = Date.now();
  for (const r of rows) {
    db.run(
      "INSERT INTO provider_configs (id, name, type, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        r.id,
        r.name ?? r.id,
        r.type,
        r.endpoint ?? null,
        r.model,
        JSON.stringify(r.models ?? []),
        r.thinking ?? "off",
        r.apiProtocol ?? null,
        r.isActive ? 1 : 0,
        now,
        now,
      ],
    );
  }
}

/** The invariant every reload must satisfy, stated observably. */
function expectActiveIsConsistent(registry: ProviderRegistry): void {
  const active = registry.getActive();
  if (!active) return; // "no active provider" is a legitimate state on an empty table
  expect(registry.list().map((p) => p.id)).toContain(active.id);
}

describe("ProviderRegistry — active-provider lifecycle", () => {
  it("selects the first provider when no row is marked active (pristine registry)", async () => {
    const db = freshDb();
    const registry = ProviderRegistry.getInstance();
    seed(db, [
      { id: "first", type: "openai", model: "m" },
      { id: "second", type: "openai", model: "m" },
    ]);
    await registry.loadFromDb(db);
    expect(registry.getActive()?.id).toBe("first");
    expectActiveIsConsistent(registry);
  });

  it("returns undefined for an empty provider table", async () => {
    const db = freshDb();
    const registry = ProviderRegistry.getInstance();
    await registry.loadFromDb(db);
    expect(registry.list()).toEqual([]);
    expect(registry.getActive()).toBeUndefined();
  });

  it("selects the row explicitly marked active", async () => {
    const db = freshDb();
    const registry = ProviderRegistry.getInstance();
    seed(db, [{ id: "only", type: "openai", model: "m", isActive: true }]);
    await registry.loadFromDb(db);
    expect(registry.getActive()?.id).toBe("only");
    expectActiveIsConsistent(registry);
  });

  it("keeps the active row selected while inactive rows coexist", async () => {
    const db = freshDb();
    const registry = ProviderRegistry.getInstance();
    seed(db, [
      { id: "inactive-1", type: "openai", model: "m" },
      { id: "chosen", type: "openai", model: "m", isActive: true },
      { id: "inactive-2", type: "openai", model: "m" },
    ]);
    await registry.loadFromDb(db);
    expect(registry.getActive()?.id).toBe("chosen");
    expectActiveIsConsistent(registry);
  });

  // ---- regression: the stale-id defect ----

  it("re-selects an existing provider after the active one has disappeared", async () => {
    const registry = ProviderRegistry.getInstance();

    const first = freshDb();
    seed(first, [
      { id: "doomed", type: "openai", model: "m", isActive: true },
      { id: "survivor", type: "openai", model: "m" },
    ]);
    await registry.loadFromDb(first);
    expect(registry.getActive()?.id).toBe("doomed");

    // The delete route removes the row and reloads.
    const after = freshDb();
    seed(after, [{ id: "survivor", type: "openai", model: "m" }]);
    await registry.loadFromDb(after);

    expect(registry.getActive()).toBeDefined();
    expect(registry.getActive()?.id).toBe("survivor");
    expectActiveIsConsistent(registry);
  });

  it("falls back to an existing provider when a used registry reloads with no active row", async () => {
    const registry = ProviderRegistry.getInstance();

    // Leave the registry non-pristine: it has already served an active id.
    const warm = freshDb();
    seed(warm, [{ id: "previous-active", type: "openai", model: "m", isActive: true }]);
    await registry.loadFromDb(warm);
    expect(registry.getActive()?.id).toBe("previous-active");

    const db = freshDb();
    seed(db, [
      { id: "alpha", type: "openai", model: "m" },
      { id: "beta", type: "openai", model: "m" },
    ]);
    await registry.loadFromDb(db);

    expect(registry.getActive()).toBeDefined();
    expect(registry.getActive()?.id).toBe("alpha");
    expectActiveIsConsistent(registry);
  });
});
