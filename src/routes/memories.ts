import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { db } from "../db";
import { generateId } from "../lib/utils";
import { evaluateMemorySafety } from "../context/memory/safety";
import type { MemorySafetyReason } from "../context/memory/safety";
import {
  memoryCreateSchema,
  memoryIdSchema,
  memoryUpdateSchema,
} from "../lib/validation";
import { storageError } from "./shared";

/** Longest stored memory accepted by the provider read. Mirrors the storage bound. */
const MAX_STORED_MEMORY_CHARS = 20_000;

/**
 * The derived safety verdict for one memory.
 *
 * **Recomputed on every read, never stored.** A persisted verdict could disagree
 * with the content it describes — and would need invalidating on every edit to
 * stay honest. Deriving it here makes that state unrepresentable and makes an
 * edit take effect immediately, which is exactly what the user expects after
 * correcting a memory.
 *
 * The UI reads this from the list endpoint, so the browser never re-implements
 * the screen and cannot disagree with the server about what reaches the model.
 */
function safetyFor(content: string): { safetyFlag: true; safetyReason: MemorySafetyReason } | null {
  const verdict = evaluateMemorySafety(content);
  return verdict.unsafe && verdict.reason ? { safetyFlag: true, safetyReason: verdict.reason } : null;
}

/**
 * Build the memory routes over a database handle.
 *
 * Defaults to the application singleton, so mounting behaviour is unchanged. It is
 * a parameter because `src/db` is a module-level singleton that other code paths
 * legitimately close (the server shutdown calls `db.close()`), and a test that
 * shares that registry can find the handle already closed. Injecting a handle lets
 * a test own its own database instead of racing the application's lifecycle.
 */
export function createMemoriesRoutes(database: Database = db) {
  const app = new Hono();

  /**
   * List memories, each annotated with its derived safety status.
   *
   * Ordering is `updated_at DESC, id ASC`. The id tiebreaker is new and deliberate:
   * the previous `ORDER BY updated_at DESC` alone had no tiebreaker, so rows sharing
   * a timestamp fell back to SQLite's row order, which is not a contract.
   */
  app.get("/api/memories", async (c) => {
    try {
      const rows = database
        .query<{ id: string; content: string; created_at: number; updated_at: number }, []>(
          "SELECT id, content, created_at, updated_at FROM memories ORDER BY updated_at DESC, id ASC",
        )
        .all();
      return c.json(
        rows.map((row) => {
          const content = String(row.content).slice(0, MAX_STORED_MEMORY_CHARS);
          return {
            id: row.id,
            content,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
            ...(safetyFor(content) ?? {}),
          };
        }),
      );
    } catch (e) {
      return storageError(c, e);
    }
  });

  app.post("/api/memories", async (c) => {
    const parsed = memoryCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid memory", issues: parsed.error.issues }, 400);
    }
    try {
      const now = Date.now();
      const id = generateId();
      database.run("INSERT INTO memories (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)", [
        id,
        parsed.data.content,
        now,
        now,
      ]);
      return c.json(
        {
          id,
          content: parsed.data.content,
          createdAt: new Date(now),
          updatedAt: new Date(now),
          ...(safetyFor(parsed.data.content) ?? {}),
        },
        201,
      );
    } catch (e) {
      return storageError(c, e);
    }
  });

  /**
   * Edit a memory (Phase 5, D4).
   *
   * `updatedAt` is bumped here, which is what makes it meaningful for the first
   * time: before this endpoint existed, no update path existed at all, so
   * `updated_at` always equalled `created_at` and ordering by it was really
   * ordering by creation.
   *
   * The derived safety status is recomputed for the response, so a memory the user
   * just corrected reports its new state immediately rather than a stale one.
   */
  app.patch("/api/memories/:id", async (c) => {
    const id = memoryIdSchema.safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "Invalid memory id" }, 400);
    }
    const parsed = memoryUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid memory", issues: parsed.error.issues }, 400);
    }
    try {
      const now = Date.now();
      const result = database.run("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?", [
        parsed.data.content,
        now,
        id.data,
      ]);
      if (result.changes === 0) {
        return c.json({ error: "Memory not found" }, 404);
      }
      return c.json({
        id: id.data,
        content: parsed.data.content,
        updatedAt: new Date(now),
        ...(safetyFor(parsed.data.content) ?? {}),
      });
    } catch (e) {
      return storageError(c, e);
    }
  });

  app.delete("/api/memories/:id", async (c) => {
    const id = memoryIdSchema.safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "Invalid memory id" }, 400);
    }
    try {
      await database.run("DELETE FROM memories WHERE id = ?", [id.data]);
      return c.json({ success: true });
    } catch (e) {
      return storageError(c, e);
    }
  });

  return app;
}

export default createMemoriesRoutes();