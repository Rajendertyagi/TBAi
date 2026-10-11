import { db } from "../db";
import type { SQLQueryBindings } from "bun:sqlite";
import { ToolError } from "./tools";
import type { TodoArgs } from "../lib/validation";

export type TodoItem = {
  id: string;
  text: string;
  done: boolean;
  position: number;
};

export type TodoListResult = {
  items: TodoItem[];
};

export type TodoContext = {
  threadId: string;
};

function now(): number {
  return Date.now();
}

function readItems(threadId: string, filter?: string): TodoListResult {
  const rows = db
    .query("SELECT id, text, done, position FROM todos WHERE thread_id = ? ORDER BY position ASC")
    .all(threadId) as { id: string; text: string; done: number; position: number }[];

  let items = rows.map((row) => ({
    id: row.id,
    text: row.text,
    done: row.done === 1,
    position: row.position,
  }));

  if (filter === "active") items = items.filter((item) => !item.done);
  else if (filter === "done") items = items.filter((item) => item.done);

  return { items };
}

/**
 * Execute a single todo action against the durable per-conversation notepad.
 *
 * The service owns all SQLite access; tool definitions carry no SQL. `threadId`
 * is supplied via context (never inferred) and missing context is rejected.
 * Every successful action returns the current list so the UI always reflects
 * backend state. Mutations run inside a transaction so position assignment and
 * the row write are atomic.
 */
export function runTodo(args: TodoArgs, ctx?: TodoContext): TodoListResult {
  const threadId = ctx?.threadId;
  if (!threadId) {
    throw new ToolError("todo requires an active conversation/thread context");
  }

  const execute = db.transaction((action: TodoArgs): TodoListResult => {
    switch (action.action) {
      case "add": {
        const position = (
          db
            .query("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM todos WHERE thread_id = ?")
            .get(threadId) as { next: number }
        ).next;
        const id = crypto.randomUUID();
        const timestamp = now();
        db.run(
          "INSERT INTO todos (id, thread_id, position, text, done, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
          [id, threadId, position, action.text, timestamp, timestamp],
        );
        return readItems(threadId);
      }
      case "list":
        return readItems(threadId, action.filter);
      case "update": {
        const assignments: string[] = [];
        const values: SQLQueryBindings[] = [];
        if (action.text !== undefined) {
          assignments.push("text = ?");
          values.push(action.text);
        }
        if (action.done !== undefined) {
          assignments.push("done = ?");
          values.push(action.done ? 1 : 0);
        }
        if (assignments.length > 0) {
          db.run(
            `UPDATE todos SET ${assignments.join(", ")}, updated_at = ? WHERE id = ? AND thread_id = ?`,
            [...values, now(), action.id, threadId],
          );
        }
        return readItems(threadId);
      }
      case "toggle": {
        db.run(
          "UPDATE todos SET done = CASE done WHEN 1 THEN 0 ELSE 1 END, updated_at = ? WHERE id = ? AND thread_id = ?",
          [now(), action.id, threadId],
        );
        return readItems(threadId);
      }
      case "remove": {
        db.run("DELETE FROM todos WHERE id = ? AND thread_id = ?", [action.id, threadId]);
        return readItems(threadId);
      }
      case "clear": {
        db.run("DELETE FROM todos WHERE thread_id = ?", [threadId]);
        return readItems(threadId);
      }
    }
  });

  return execute(args);
}
