/**
 * Memory persistence: the `memories` table.
 *
 * ## Why this was split out of `storage/index.ts`
 *
 * See `conversations.ts`. Memories are independent of conversations and
 * messages - a separate table, a separate CRUD surface, no shared helper.
 *
 * ## What is deliberately NOT here
 *
 * Whether a memory is ever SELECTED into a prompt is a context-assembly decision
 * made in `src/context/memory/`, behind `TBAI_MEMORY_ENABLED`. This module
 * only stores and reads rows.
 */

import { db } from "../../db";
import { generateId } from "../../lib/utils";
import type { SQLQueryBindings } from "bun:sqlite";
import type { Memory } from "../../types";

interface MemoryRow {
  id: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export const memoryService = {
  async list(): Promise<Memory[]> {
    const rows = db
      .query<MemoryRow, SQLQueryBindings[]>("SELECT * FROM memories ORDER BY updated_at DESC")
      .all();
    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  },

  async add(content: string): Promise<Memory> {
    const now = Date.now();
    const id = generateId();
    db.run("INSERT INTO memories (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)", [
      id,
      content,
      now,
      now,
    ]);
    return { id, content, createdAt: new Date(now), updatedAt: new Date(now) };
  },

  async delete(id: string): Promise<void> {
    db.run("DELETE FROM memories WHERE id = ?", [id]);
  },
};
