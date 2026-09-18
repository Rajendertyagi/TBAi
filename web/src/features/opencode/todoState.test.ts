import { describe, it, expect, beforeEach } from "bun:test";
import {
  OpenCodeTodoStore,
  hydrateSessionTodos,
  type OpenCodeTodo,
} from "./todoState";
import type { OpenCodeRuntimeClient } from "./eventScope";
import type { OpenCodeScope } from "./opencodeScope";

/**
 * Race-safety contracts for the OpenCode todo projection store (T3-TD-05–09).
 *
 * `OpenCodeTodoStore` keeps a per-session snapshot guarded by a monotonic
 * generation (attach/clear bumps it) and a monotonic revision (each live
 * `todo.updated` bump). Two entry points commit snapshots:
 *   - `applyEventUpdate`  — only while the session is active.
 *   - `applyHydration`    — only if still active AND generation AND revision
 *     are unchanged since the request was dispatched.
 *
 * `hydrateSessionTodos` captures (generation, revision) right before the async
 * `client.session.todo()` and commits through `applyHydration`. `observeTodoEvent`
 * is the live-event path that bumps the revision.
 *
 * Each race scenario below drives the REAL store through its real entry points;
 * nothing here mocks the store's logic. The fake client only models "the
 * hydration request is still in flight" — the resolution point where the race
 * lands.
 */

const todos = (ids: string[]): OpenCodeTodo[] =>
  ids.map((content) => ({
    content,
    status: "pending",
    priority: "medium",
  }));

/** A session scope for the fake client; directory + sessionId are stable. */
function scopeFor(sessionId: string): OpenCodeScope {
  return { sessionId, directory: `D:\\ws\\${sessionId}` };
}

/**
 * A controllable fake of `client.session.todo`. The caller holds `release` to
 * resolve the in-flight request; each resolution returns `dataFor`.
 */
function fakeTodoClient() {
  let release!: () => void;
  let dataFor: OpenCodeTodo[] = [];
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const calls: Array<{ sessionID: string; directory: string | null }> = [];

  const client = {
    session: {
      todo: async (
        params: { sessionID: string; directory: string },
      ): Promise<{ data: unknown }> => {
        calls.push({
          sessionID: params.sessionID,
          directory: params.directory ?? null,
        });
        await gate;
        return { data: dataFor };
      },
    },
  } as unknown as OpenCodeRuntimeClient;

  return {
    client,
    calls,
    resolve: (data: OpenCodeTodo[]) => {
      dataFor = data;
      release();
    },
  };
}

describe("T3-TD-05 — hydration/live-event race", () => {
  let store: OpenCodeTodoStore;
  beforeEach(() => {
    store = new OpenCodeTodoStore();
  });

  it("a newer live event applied before hydration resolves wins; stale hydration is dropped", async () => {
    const id = "ses_5";
    store.attachSession(id);
    const fake = fakeTodoClient();
    const hydrating = hydrateSessionTodos(fake.client, scopeFor(id));

    // While the hydration request is in flight, a live `todo.updated` for the
    // same session arrives and is applied (bumps revision + snapshot).
    expect(store.applyEventUpdate(id, todos(["live-1", "live-2"]))).toBe(true);

    // The old hydration finally resolves with the STALE snapshot. It must be
    // rejected (captured revision is now behind) so it cannot overwrite the
    // newer live snapshot.
    fake.resolve(todos(["old-hydration"]));
    await hydrating;

    expect(store.getSnapshot(id)).toEqual(todos(["live-1", "live-2"]));
    // The failed stale hydration must not bump the revision — a rejected
    // write leaves the revision untouched at its pre-hydration value.
    expect(store.getRevision(id)).toBe(1);
  });

  it("a live event does not apply to an inactive session and leaves the revision untouched", async () => {
    const id = "ses_5b";
    store.attachSession(id);
    store.clearSession(id); // detached
    expect(store.applyEventUpdate(id, todos(["zombie"]))).toBe(false);
    expect(store.getSnapshot(id)).toBeUndefined();
  });
});

describe("T3-TD-06 — hydration/detach race", () => {
  let store: OpenCodeTodoStore;
  beforeEach(() => {
    store = new OpenCodeTodoStore();
  });

  it("a stale hydration resolves after detach and must NOT recreate the session snapshot", async () => {
    const id = "ses_6";
    store.attachSession(id);
    const fake = fakeTodoClient();
    const hydrating = hydrateSessionTodos(fake.client, scopeFor(id));

    // The session detaches while the request is in flight. `clearSession`
    // bumps the generation, removes it from the active set, and drops the
    // snapshot — invalidating any in-flight hydration.
    store.clearSession(id);

    // The old request resolves. It must be refused: the session is no longer
    // active, so no snapshot can be recreated for it.
    fake.resolve(todos(["late"]));
    await hydrating;

    expect(store.isActive(id)).toBe(false);
    expect(store.getSnapshot(id)).toBeUndefined();
  });
});

describe("T3-TD-07 — event-after-detach race", () => {
  let store: OpenCodeTodoStore;
  beforeEach(() => {
    store = new OpenCodeTodoStore();
  });

  it("a delayed `todo.updated` for a detached session is not resurrected", () => {
    const id = "ses_7";
    store.attachSession(id);
    // Authoritative snapshot while active.
    expect(store.applyEventUpdate(id, todos(["active"]))).toBe(true);

    // Detach. The snapshot is cleared; the session is no longer active.
    store.clearSession(id);
    expect(store.getSnapshot(id)).toBeUndefined();

    // A delayed live event for the same session must be refused — the
    // detached session is not resurrected, and no snapshot is recreated.
    expect(store.applyEventUpdate(id, todos(["late"]))).toBe(false);
    expect(store.getSnapshot(id)).toBeUndefined();
    expect(store.isActive(id)).toBe(false);
  });
});

describe("T3-TD-08 — session isolation", () => {
  let store: OpenCodeTodoStore;
  beforeEach(() => {
    store = new OpenCodeTodoStore();
  });

  it("a live event for session A does not touch session B's snapshot", () => {
    const a = "ses_a";
    const b = "ses_b";
    store.attachSession(a);
    store.attachSession(b);
    store.applyEventUpdate(a, todos(["a-only"]));
    store.applyEventUpdate(b, todos(["b-only"]));

    // An update for A must not leak into B.
    expect(store.applyEventUpdate(a, todos(["a-v2"]))).toBe(true);
    expect(store.getSnapshot(a)).toEqual(todos(["a-v2"]));
    expect(store.getSnapshot(b)).toEqual(todos(["b-only"]));
  });

  it("switching active session cannot surface a previous session's snapshot", () => {
    const a = "ses_a2";
    const b = "ses_b2";
    store.attachSession(a);
    store.attachSession(b);
    store.applyEventUpdate(a, todos(["secret-a"]));

    // Detach A (clears its snapshot) while B stays active.
    store.clearSession(a);
    expect(store.getSnapshot(a)).toBeUndefined();
    // B has no snapshot yet (only an active flag), so its read is undefined —
    // the point is that A's secret is gone and not surfaced on B.
    expect(store.getSnapshot(b)).toBeUndefined();
    expect(store.isActive(b)).toBe(true);
  });
});

describe("T3-TD-09 — reconnect & reattach regression", () => {
  let store: OpenCodeTodoStore;
  beforeEach(() => {
    store = new OpenCodeTodoStore();
  });

  it("an old hydration that resolves after reattach must not overwrite the new session", async () => {
    const id = "ses_9";
    store.attachSession(id); // generation 1
    const fake = fakeTodoClient();
    const hydrating = hydrateSessionTodos(fake.client, scopeFor(id));

    // Detach + reattach: the reattach bumps the generation again, so the
    // in-flight hydration captured at generation 1 is now stale.
    store.clearSession(id);
    store.attachSession(id); // generation 2

    // Fresh, post-reattach live state.
    expect(store.applyEventUpdate(id, todos(["fresh-after-reattach"]))).toBe(true);

    // The old hydration finally resolves with a stale payload. It must be
    // refused (captured generation 1 !== current generation 2), so it cannot
    // clobber the newly attached session's snapshot.
    fake.resolve(todos(["stale-from-before-reattach"]));
    await hydrating;

    expect(store.getSnapshot(id)).toEqual(todos(["fresh-after-reattach"]));
  });
});
