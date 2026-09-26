import { describe, it, expect } from "bun:test";
import { runTodo } from "./todos";
import { generateId } from "../lib/utils";
import { db } from "../db";

// DATA_DIR is isolated by tests/setup.ts (preload) to a per-run temp dir, so the
// `todos` table lives in the shared test database. Thread ids are namespaced to
// avoid colliding with other suites sharing that database — and the namespace
// has to be unique per MODULE INSTANCE, not a fixed literal. With a literal, a
// second copy of this same suite (a compiled `.js` twin, a duplicate runner)
// reuses the identical ids, its leftover rows survive in the shared DB, and the
// count assertions below fail with "expected length 1, received 2".
const RUN = generateId();

/**
 * A thread id for this run, with the parent conversation it needs.
 *
 * `todos.thread_id` carries `FOREIGN KEY (thread_id) REFERENCES
 * conversations(id) ON DELETE CASCADE` — deliberately, so abandoning a thread
 * leaves no orphan todos. That makes a bare synthetic id unusable here: the
 * insert fails with "FOREIGN KEY constraint failed" before any assertion runs.
 *
 * The parent row is inserted directly rather than through
 * `conversationService.create`, because this is a unit test of the todo service:
 * create() would also mint a workspace directory and a `folders` row per
 * thread, which is filesystem state no assertion here reads.
 */
const seeded = new Set<string>();
function seededThread(id: string): string {
  const threadId = `todo-test-${RUN}-${id}`;
  if (!seeded.has(threadId)) {
    const now = Date.now();
    db.run(
      "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [threadId, "todo test parent", now, now],
    );
    seeded.add(threadId);
  }
  return threadId;
}


describe("todo service", () => {
  it("rejects when no thread context is supplied", () => {
    expect(() => runTodo({ action: "list" })).toThrow();
  });

  it("adds an item and returns the current list", () => {
    const r = runTodo({ action: "add", text: "buy milk" }, { threadId: seededThread("t1") });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].text).toBe("buy milk");
    expect(r.items[0].done).toBe(false);
  });

  it("assigns increasing positions deterministically", () => {
    runTodo({ action: "add", text: "a" }, { threadId: seededThread("t2") });
    runTodo({ action: "add", text: "b" }, { threadId: seededThread("t2") });
    const r = runTodo({ action: "list" }, { threadId: seededThread("t2") });
    expect(r.items.map((i) => i.text)).toEqual(["a", "b"]);
    expect(r.items[0].position).toBeLessThan(r.items[1].position);
  });

  it("toggles the done state", () => {
    const added = runTodo({ action: "add", text: "task" }, { threadId: seededThread("t3") });
    const id = added.items[0].id;
    expect(runTodo({ action: "toggle", id }, { threadId: seededThread("t3") }).items[0].done).toBe(true);
    expect(runTodo({ action: "toggle", id }, { threadId: seededThread("t3") }).items[0].done).toBe(false);
  });

  it("updates text and done", () => {
    const added = runTodo({ action: "add", text: "old" }, { threadId: seededThread("t4") });
    const id = added.items[0].id;
    const updated = runTodo({ action: "update", id, text: "new", done: true }, { threadId: seededThread("t4") });
    expect(updated.items[0].text).toBe("new");
    expect(updated.items[0].done).toBe(true);
  });

  it("isolates items per thread", () => {
    runTodo({ action: "add", text: "shared?" }, { threadId: seededThread("t5") });
    expect(runTodo({ action: "list" }, { threadId: seededThread("t6") }).items).toHaveLength(0);
  });

  it("removes an item", () => {
    const added = runTodo({ action: "add", text: "temp" }, { threadId: seededThread("t7") });
    const id = added.items[0].id;
    expect(runTodo({ action: "remove", id }, { threadId: seededThread("t7") }).items).toHaveLength(0);
  });

  it("clears all items", () => {
    runTodo({ action: "add", text: "x" }, { threadId: seededThread("t8") });
    runTodo({ action: "add", text: "y" }, { threadId: seededThread("t8") });
    expect(runTodo({ action: "clear" }, { threadId: seededThread("t8") }).items).toHaveLength(0);
  });

  it("filters by active and done", () => {
    const added = runTodo({ action: "add", text: "one" }, { threadId: seededThread("t9") });
    const id = added.items[0].id;
    runTodo({ action: "toggle", id }, { threadId: seededThread("t9") });
    runTodo({ action: "add", text: "two" }, { threadId: seededThread("t9") });
    expect(
      runTodo({ action: "list", filter: "done" }, { threadId: seededThread("t9") }).items.map((i) => i.text),
    ).toEqual(["one"]);
    expect(
      runTodo({ action: "list", filter: "active" }, { threadId: seededThread("t9") }).items.map((i) => i.text),
    ).toEqual(["two"]);
  });
});
