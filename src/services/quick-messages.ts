import { db } from "../db";
import { generateId } from "../lib/utils";
import type { SQLQueryBindings } from "bun:sqlite";
import type { QuickMessage } from "../types";

interface QuickMessageRow {
  id: string;
  title: string;
  content: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

function mapRow(row: QuickMessageRow): QuickMessage {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    sortOrder: row.sort_order,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** Sole SQL owner for user-saved quick messages (title + content + order). */
export const quickMessageService = {
  async list(): Promise<QuickMessage[]> {
    const rows = db
      .query<QuickMessageRow, SQLQueryBindings[]>(
        "SELECT * FROM quick_messages ORDER BY sort_order ASC, created_at ASC",
      )
      .all();
    return rows.map(mapRow);
  },

  async get(id: string): Promise<QuickMessage | null> {
    const row = db
      .query<QuickMessageRow, SQLQueryBindings[]>("SELECT * FROM quick_messages WHERE id = ?")
      .get(id);
    return row ? mapRow(row) : null;
  },

  async create(input: { title?: string; content?: string }): Promise<QuickMessage> {
    const now = Date.now();
    const id = generateId();
    const max = db
      .query<{ max: number | null }, SQLQueryBindings[]>(
        "SELECT MAX(sort_order) AS max FROM quick_messages",
      )
      .get();
    const sortOrder = (max?.max ?? -1) + 1;
    db.run(
      "INSERT INTO quick_messages (id, title, content, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, input.title ?? "", input.content ?? "", sortOrder, now, now],
    );
    return (await this.get(id))!;
  },

  async update(
    id: string,
    data: { title?: string; content?: string },
  ): Promise<QuickMessage | null> {
    const updates: string[] = [];
    const values: SQLQueryBindings[] = [];
    if (data.title !== undefined) {
      updates.push("title = ?");
      values.push(data.title);
    }
    if (data.content !== undefined) {
      updates.push("content = ?");
      values.push(data.content);
    }
    if (updates.length === 0) return this.get(id);
    updates.push("updated_at = ?");
    values.push(Date.now(), id);
    db.run(`UPDATE quick_messages SET ${updates.join(", ")} WHERE id = ?`, values);
    return this.get(id);
  },

  async remove(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    db.run("DELETE FROM quick_messages WHERE id = ?", [id]);
    return true;
  },

  /** Persist a manual ordering (array of ids, first = top). Unknown ids
   *  ignored; duplicates collapse to first occurrence (deterministic). */
  async reorder(ids: string[]): Promise<void> {
    ids = [...new Set(ids)];
    if (ids.length === 0) return;
    const whenThen = ids.map(() => "WHEN ? THEN ?").join(" ");
    const caseValues: SQLQueryBindings[] = [];
    ids.forEach((id, index) => {
      caseValues.push(id, index);
    });
    const inList = ids.map(() => "?").join(", ");
    db.run(
      `UPDATE quick_messages SET sort_order = CASE id ${whenThen} END, updated_at = ? WHERE id IN (${inList})`,
      [...caseValues, Date.now(), ...ids],
    );
  },
};
