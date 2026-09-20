import { describe, it, expect } from "bun:test";
import { runTodo } from "./todos";
import { generateId } from "../lib/utils";

// DATA_DIR is isolated by tests/setup.ts (preload) to a per-run temp dir, so the
// `todos` table lives in the shared test database. Thread ids are namespaced to
// avoid colliding with other suites sharing that database — and the namespace
// has to be unique per MODULE INSTANCE, not a fixed literal. With a literal, a
// second copy of this same suite (a compiled `.js` twin, a duplicate runner)
// reuses the identical ids, its leftover rows survive in the shared DB, and the
// count assertions below fail with "expected length 1, received 2".
const RUN = generateId();
const T = (id: string) => `todo-test-${RUN}-${id}`;

describe("todo service", () => {
  it("rejects when no thread context is supplied", () => {
    expect(() => runTodo({ action: "list" })).toThrow();
  });

  it("adds an item and returns the current list", () => {
    const r = runTodo({ action: "add", text: "buy milk" }, { threadId: T("t1") });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].text).toBe("buy milk");
    expect(r.items[0].done).toBe(false);
  });

  it("assigns increasing positions deterministically", () => {
    runTodo({ action: "add", text: "a" }, { threadId: T("t2") });
    runTodo({ action: "add", text: "b" }, { threadId: T("t2") });
    const r = runTodo({ action: "list" }, { threadId: T("t2") });
    expect(r.items.map((i) => i.text)).toEqual(["a", "b"]);
    expect(r.items[0].position).toBeLessThan(r.items[1].position);
  });

  it("toggles the done state", () => {
    const added = runTodo({ action: "add", text: "task" }, { threadId: T("t3") });
    const id = added.items[0].id;
    expect(runTodo({ action: "toggle", id }, { threadId: T("t3") }).items[0].done).toBe(true);
    expect(runTodo({ action: "toggle", id }, { threadId: T("t3") }).items[0].done).toBe(false);
  });

  it("updates text and done", () => {
    const added = runTodo({ action: "add", text: "old" }, { threadId: T("t4") });
    const id = added.items[0].id;
    const updated = runTodo({ action: "update", id, text: "new", done: true }, { threadId: T("t4") });
    expect(updated.items[0].text).toBe("new");
    expect(updated.items[0].done).toBe(true);
  });

  it("isolates items per thread", () => {
    runTodo({ action: "add", text: "shared?" }, { threadId: T("t5") });
    expect(runTodo({ action: "list" }, { threadId: T("t6") }).items).toHaveLength(0);
  });

  it("removes an item", () => {
    const added = runTodo({ action: "add", text: "temp" }, { threadId: T("t7") });
    const id = added.items[0].id;
    expect(runTodo({ action: "remove", id }, { threadId: T("t7") }).items).toHaveLength(0);
  });

  it("clears all items", () => {
    runTodo({ action: "add", text: "x" }, { threadId: T("t8") });
    runTodo({ action: "add", text: "y" }, { threadId: T("t8") });
    expect(runTodo({ action: "clear" }, { threadId: T("t8") }).items).toHaveLength(0);
  });

  it("filters by active and done", () => {
    const added = runTodo({ action: "add", text: "one" }, { threadId: T("t9") });
    const id = added.items[0].id;
    runTodo({ action: "toggle", id }, { threadId: T("t9") });
    runTodo({ action: "add", text: "two" }, { threadId: T("t9") });
    expect(
      runTodo({ action: "list", filter: "done" }, { threadId: T("t9") }).items.map((i) => i.text),
    ).toEqual(["one"]);
    expect(
      runTodo({ action: "list", filter: "active" }, { threadId: T("t9") }).items.map((i) => i.text),
    ).toEqual(["two"]);
  });
});
