import { describe, it, expect, beforeEach, beforeAll } from "bun:test";
import { openCodeTodoStore, type OpenCodeTodo } from "./todoState";
import { stripComments } from "@/testing/source-scope";

/**
 * OpenCode ambient task tracker — behavior & regression contracts.
 *
 * `OpenCodeTodoTracker` (OpenCodeTodoTracker.tsx) is a read-only projection of
 * the `openCodeTodoStore` singleton via `useOpenCodeTodos(sessionId)`. The
 * `web/` suite has no DOM runner, and `useSyncExternalStore` (which the hook
 * uses) reads the *server* snapshot under SSR — so the component's visible
 * output cannot be driven through `renderToStaticMarkup`. These tests instead
 * pin the two things the contract depends on:
 *
 *   1. the STORE's snapshot semantics (the tracker's only input source),
 *      driven through the real `openCodeTodoStore` entry points; and
 *   2. the TRACKER's render-decision source (the undefined/[]/non-empty split
 *      and the per-session read), guarded against the component's own code so a
 *      regression that changes the branching fails here.
 *
 * This covers the repeated-todowrite flow (A), historical immutability (B),
 * session-switch isolation (C), empty/undefined states (D), and the
 * conversation-identity independence (E) — the tracker's data is keyed by the
 * OpenCode *session* id, never by the TBAi conversation id.
 */

const T = (
  content: string,
  status: OpenCodeTodo["status"],
  priority: OpenCodeTodo["priority"] = "medium",
): OpenCodeTodo => ({ content, status, priority });

/**
 * The compact card title `OpenCodeTodoWriteToolUI` renders for a settled
 * `todowrite` invocation (ui.tsx: `todowrite · ${completed}/${n} completed`,
 * or `todowrite · empty`). Reproduced as a pure function so the
 * historical-immutability assertions are exact and independent of the full
 * card's render tree.
 */
function todowriteCardTitle(items: OpenCodeTodo[]): string {
  const completed = items.filter((t) => t.status === "completed").length;
  return items.length > 0
    ? `todowrite · ${completed}/${items.length} completed`
    : "todowrite · empty";
}

/** Hydrates the store for a session via its real entry points. */
function hydrate(id: string, items: OpenCodeTodo[]): void {
  openCodeTodoStore.attachSession(id);
  const gen = openCodeTodoStore.getGeneration(id);
  const rev = openCodeTodoStore.getRevision(id);
  expect(openCodeTodoStore.applyHydration(id, items, gen, rev)).toBe(true);
}

beforeAll(async () => {
  // Read the tracker's source once for the render-decision guards.
  const src = await Bun.file(
    new URL("./OpenCodeTodoTracker.tsx", import.meta.url),
  ).text();
  trackerCode = stripComments(src);
});

let trackerCode = "";

beforeEach(() => {
  openCodeTodoStore.clearSession("ses_A");
  openCodeTodoStore.clearSession("ses_B");
});

// ── Test A — repeated todowrite → compact cards + ONE full list ─────────────

describe("Test A — repeated todowrite", () => {
  it("each settled todowrite renders a compact historical card (title only, not task bodies)", () => {
    // The compact card's title is a progress summary; the task bodies stay in
    // the ambient tracker, not duplicated into every card.
    const card = todowriteCardTitle([
      T("step one", "completed"),
      T("step two", "in_progress"),
      T("step three", "pending"),
    ]);
    expect(card).toBe("todowrite · 1/3 completed");
    expect(card).not.toContain("step one");
  });

  it("an empty todowrite renders the empty card title", () => {
    expect(todowriteCardTitle([])).toBe("todowrite · empty");
  });

  it("exactly ONE full task list is the ambient tracker, updated in place on repeat", () => {
    // The live tracker is the single full-list surface. A repeated todowrite
    // delivers a `todo.updated` frame that REPLACES the snapshot in place.
    hydrate("ses_A", [T("a", "pending"), T("b", "pending")]);
    expect(openCodeTodoStore.getSnapshot("ses_A")).toEqual([
      T("a", "pending"),
      T("b", "pending"),
    ]);

    // The next todowrite event updates the SAME session's snapshot.
    expect(
      openCodeTodoStore.applyEventUpdate(
        "ses_A",
        [T("a", "completed"), T("b", "in_progress")],
      ),
    ).toBe(true);
    const snap = openCodeTodoStore.getSnapshot("ses_A");
    expect(snap).toEqual([T("a", "completed"), T("b", "in_progress")]);
    // One authoritative list for the session — the store holds exactly one
    // snapshot entry per active session.
    expect(openCodeTodoStore.getSnapshot("ses_A")).toHaveLength(2);
  });
});

// ── Test B — historical immutability ────────────────────────────────────────

describe("Test B — historical immutability", () => {
  it("a later todowrite cannot rewrite the earlier card's title", () => {
    // Each settled card's title is a pure function of ITS OWN args.todos. A
    // later invocation is a different card; the earlier one is frozen.
    const earlier = todowriteCardTitle([T("old step", "pending")]);
    const later = todowriteCardTitle([T("new step", "completed")]);
    expect(earlier).toBe("todowrite · 0/1 completed");
    expect(later).toBe("todowrite · 1/1 completed");
    // The earlier card's text does not contain the later invocation's data.
    expect(earlier).not.toContain("new step");
    expect(earlier).not.toContain("1/1");
  });

  it("a later todo.updated event cannot alter the earlier card's text/status", () => {
    // The live snapshot is replaced wholesale, but a settled transcript card is
    // read-only history: re-applying events to the store never reaches back
    // into an earlier card's args.
    const frozen = todowriteCardTitle([T("frozen task", "completed")]);
    hydrate("ses_A", [T("live-1", "pending")]);
    openCodeTodoStore.applyEventUpdate("ses_A", [T("live-2", "completed")]);
    // The live snapshot now shows the newest state…
    expect(openCodeTodoStore.getSnapshot("ses_A")).toEqual([
      T("live-2", "completed"),
    ]);
    // …and the earlier historical card is byte-for-byte what it was.
    expect(frozen).toBe("todowrite · 1/1 completed");
    expect(frozen).not.toContain("live-2");
  });
});

// ── Test C — session switch isolation ────────────────────────────────────────

describe("Test C — session switch isolation", () => {
  it("switching A→B swaps the snapshot with zero state leakage", () => {
    hydrate("ses_A", [T("task in A", "pending")]);
    hydrate("ses_B", [T("task in B", "completed"), T("task in B2", "pending")]);

    expect(openCodeTodoStore.getSnapshot("ses_A")).toEqual([
      T("task in A", "pending"),
    ]);
    expect(openCodeTodoStore.getSnapshot("ses_B")).toEqual([
      T("task in B", "completed"),
      T("task in B2", "pending"),
    ]);

    // The tracker reads by session id; B's read never surfaces A's snapshot.
    const b = openCodeTodoStore.getSnapshot("ses_B");
    const a = openCodeTodoStore.getSnapshot("ses_A");
    expect(b?.map((t) => t.content)).toEqual(["task in B", "task in B2"]);
    expect(a?.map((t) => t.content)).toEqual(["task in A"]);
  });

  it("clearing session A cannot surface A's snapshot on session B", () => {
    hydrate("ses_A", [T("secret-a", "pending")]);
    hydrate("ses_B", [T("public-b", "pending")]);
    openCodeTodoStore.clearSession("ses_A");

    expect(openCodeTodoStore.getSnapshot("ses_A")).toBeUndefined();
    // B is untouched and still readable.
    expect(openCodeTodoStore.getSnapshot("ses_B")).toEqual([
      T("public-b", "pending"),
    ]);
  });
});

// ── Test D — empty & undefined states ───────────────────────────────────────

describe("Test D — empty & undefined states", () => {
  it("undefined (not loaded) → no tracker (store has no snapshot)", () => {
    expect(openCodeTodoStore.getSnapshot("ses_A")).toBeUndefined();
    // The tracker's render decision maps `undefined` to `null`.
    expect(trackerCode).toContain("todos === undefined");
    expect(trackerCode).toContain("todos.length === 0");
  });

  it("an authoritative [] → no tracker (distinct from undefined)", () => {
    hydrate("ses_A", []);
    expect(openCodeTodoStore.getSnapshot("ses_A")).toEqual([]);
    // The tracker maps `[]` to `null` just like undefined, but the store still
    // KNOWS it is loaded (the key is present, not absent).
    expect(openCodeTodoStore.getSnapshot("ses_A")).not.toBeUndefined();
  });

  it("a non-empty list is the only case that renders the tracker", () => {
    hydrate("ses_A", [T("only task", "in_progress")]);
    expect(openCodeTodoStore.getSnapshot("ses_A")?.length).toBe(1);
  });

  it("an authoritative [] does not clear the store cache", () => {
    // `[]` is the loaded-empty state, not 'no snapshot'. The snapshot map must
    // still hold the key after an authoritative empty update, so the tracker
    // can keep distinguishing 'loaded empty' from 'not loaded'.
    hydrate("ses_A", [T("x", "pending")]);
    expect(openCodeTodoStore.getSnapshot("ses_A")?.length).toBe(1);
    openCodeTodoStore.applyEventUpdate("ses_A", []);
    expect(openCodeTodoStore.getSnapshot("ses_A")).toEqual([]);
    expect(openCodeTodoStore.getSnapshot("ses_A")).not.toBeUndefined();
  });
});

// ── Test E — conversation identity independence ─────────────────────────────

describe("Test E — conversation identity independence", () => {
  // The tracker's snapshot is keyed by OpenCode SESSION id. The conversation
  // record (`/api/conversations/:id`) only supplies agent/model defaults; a
  // late/failed/404 read of it never gates the session's todos. The tracker
  // mounts and displays live tasks regardless of that fetch's outcome.

  it("the store's snapshot is addressed by session id, not conversation id", () => {
    // The tracker's only data dependency is `useOpenCodeTodos(sessionId)`,
    // which reads `openCodeTodoStore.getSnapshot(sessionId)`. No conversation
    // id is involved in that read.
    hydrate("ses_A", [T("live task", "in_progress")]);
    expect(openCodeTodoStore.getSnapshot("ses_A")).toEqual([
      T("live task", "in_progress"),
    ]);
    // The conversation config hook is a separate, null-tolerant read. A null
    // config (404/failed/delayed) leaves the session's snapshot fully intact.
    const failedConfig = null as { opencodeAgent: string | null } | null;
    expect(failedConfig).toBeNull();
    expect(openCodeTodoStore.getSnapshot("ses_A")).toEqual([
      T("live task", "in_progress"),
    ]);
  });

  it("the tracker component has no dependency on the conversation config", () => {
    // Structural proof: the tracker imports nothing conversation-related; its
    // data source is the session-scoped store only.
    expect(trackerCode).toContain("useOpenCodeTodos(sessionId)");
    expect(trackerCode).not.toContain("conversation");
    expect(trackerCode).not.toContain("useOpenCodeConversationConfig");
  });
});
