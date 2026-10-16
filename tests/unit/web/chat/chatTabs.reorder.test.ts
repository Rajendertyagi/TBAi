/**
 * CHARACTERISATION — `useChatTabsStore.reorder`, the tab-strip's only order authority.
 *
 * ## Why this file exists
 *
 * `reorder` had ZERO coverage before this file. It is the single seam between the
 * drag layer (`components/TabStrip.tsx`, which uses `@dnd-kit/react` 0.5.0)
 * and persisted application state, so it is the one contract that must survive a
 * change of drag library. Nothing else in the store is reachable by a drag: opening,
 * closing and deleting all go through other actions.
 *
 * These tests therefore describe what the action DOES today, not what it should do.
 * Where a rule looks arbitrary the comment says so rather than justifying it, and
 * the assertion pins the behaviour exactly as shipped — including the parts a
 * migration would be tempted to "improve".
 *
 * ## The layers are deliberately different
 *
 * `chatTabs.persist` writes through `window.localStorage`, so the unit tier needs a
 * storage shim. The shim below records writes as well as storing them, which is what
 * lets the no-op cases assert something stronger than "the order is unchanged": they
 * prove no redundant `localStorage` write happened either.
 *
 * Real-browser persistence (a genuine reload) is covered by the E2E spec; this file
 * covers the write contract only.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  agentKey,
  chatKey,
  healTab,
  useChatTabsStore,
  type Tab,
} from "@web/features/chat/state/chatTabs.ts";

/** The one storage key the tab mirror owns (`chatTabs.ts`). */
const STORAGE_KEY = "tbai:openTabs";

interface StorageHarness {
  read: (key: string) => string | null;
  /** Every key ever written, in order — lets a no-op prove it wrote nothing. */
  writes: string[];
  restore: () => void;
}

/**
 * Minimal `window.localStorage` stand-in.
 *
 * `chatTabs.ts` reaches storage as `window.localStorage`, NOT as a bare
 * `localStorage`, so a `globalThis.localStorage` shim alone (the shape
 * `pendingFirstMessage.test.ts` uses for its sessionStorage sibling) would leave the
 * real code path untouched by its own try/catch and silently persist nothing.
 */
function installMemoryStorage(): StorageHarness {
  const holder = globalThis as unknown as { window?: unknown };
  const previousWindow = holder.window;
  const backing = new Map<string, string>();
  const writes: string[] = [];

  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? (backing.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      backing.set(k, String(v));
      writes.push(k);
    },
    removeItem: (k: string) => {
      backing.delete(k);
    },
  };

  holder.window = { ...(previousWindow as object | undefined), localStorage };

  return {
    read: (k) => localStorage.getItem(k),
    writes,
    restore: () => {
      if (previousWindow === undefined) delete holder.window;
      else holder.window = previousWindow;
    },
  };
}

let storage: StorageHarness | null = null;

const store = () => useChatTabsStore.getState();

/** Tab keys in strip order — the thing a drag actually changes. */
function order(): string[] {
  return store().tabs.map((t) => t.key);
}

function reset(): void {
  useChatTabsStore.setState({ tabs: [], activeKey: undefined });
}

/** Open three chat tabs in a known order: A, B, C. */
function seedThree(): void {
  reset();
  store().openChat("A");
  store().openChat("B");
  store().openChat("C");
  // Each open activates its tab, so C is active. Explicit anyway, so the
  // precondition is stated rather than implied by the seed helper.
  store().setActive(chatKey("B"));
}

/** The persisted mirror, healed through the loader's own repair function. */
function persistedOrder(): string[] {
  const raw = storage?.read(STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { tabs?: unknown };
  const tabs = (parsed.tabs ?? []) as unknown[];
  return tabs
    .map((entry) => healTab(entry))
    .filter((t): t is Tab => t !== null)
    .map((t) => t.key);
}

beforeEach(() => {
  storage = installMemoryStorage();
  reset();
});

afterEach(() => {
  storage?.restore();
  storage = null;
});

describe("reorder moves a tab and nothing else", () => {
  it("moves the tab at `from` to `to`, keeping every other tab's relative order", () => {
    seedThree();
    expect(order()).toEqual([chatKey("A"), chatKey("B"), chatKey("C")]);

    store().reorder(0, 2);

    expect(order()).toEqual([chatKey("B"), chatKey("C"), chatKey("A")]);
  });

  it("moves backwards as well as forwards", () => {
    seedThree();
    store().reorder(2, 0);
    expect(order()).toEqual([chatKey("C"), chatKey("A"), chatKey("B")]);
  });

  it("moves into an adjacent slot without disturbing its neighbour", () => {
    seedThree();
    store().reorder(1, 2);
    expect(order()).toEqual([chatKey("A"), chatKey("C"), chatKey("B")]);
  });

  it("preserves length and the exact multiset of keys (nothing lost, nothing duplicated)", () => {
    seedThree();
    const before = order().slice().sort();
    store().reorder(0, 2);
    const after = order();
    expect(after).toHaveLength(before.length);
    expect(after.slice().sort()).toEqual(before);
    // And each entry is still a complete, well-formed tab — not a key that lost
    // its kind/ref on the way through the move.
    for (const tab of store().tabs) {
      expect(tab).toEqual(healTab(tab));
    }
  });

  it("reorders across engine kinds without converting either one", () => {
    reset();
    store().openChat("chat1");
    store().openAgent("code1");
    store().openChat("chat2");
    expect(order()).toEqual([chatKey("chat1"), agentKey("code1"), chatKey("chat2")]);

    store().reorder(2, 0);

    expect(order()).toEqual([chatKey("chat2"), chatKey("chat1"), agentKey("code1")]);
    // The move must not have rewritten an entry into the other kind — a Code tab
    // that silently became a Direct tab would route to the wrong surface.
    expect(store().tabs.find((t) => t.key === agentKey("code1"))?.kind).toBe("agent");
    expect(store().tabs.find((t) => t.key === chatKey("chat1"))?.kind).toBe("chat");
  });
});

describe("reorder persists the new order", () => {
  it("writes the reordered tab list to the tab mirror", () => {
    seedThree();
    store().reorder(0, 2);
    expect(persistedOrder()).toEqual([chatKey("B"), chatKey("C"), chatKey("A")]);
  });

  it("persists the active key alongside the order, so a reload restores both", () => {
    seedThree();
    expect(store().activeKey).toBe(chatKey("B"));
    store().reorder(0, 2);

    const raw = JSON.parse(storage?.read(STORAGE_KEY) ?? "{}") as {
      tabs?: { key: string }[];
      activeKey?: string;
    };
    expect(raw.activeKey).toBe(chatKey("B"));
    expect(raw.tabs?.map((t) => t.key)).toEqual([chatKey("B"), chatKey("C"), chatKey("A")]);
  });

  it("persists full tab records, not bare keys (a reload can heal them)", () => {
    seedThree();
    store().reorder(2, 0);
    const raw = JSON.parse(storage?.read(STORAGE_KEY) ?? "{}") as { tabs?: Tab[] };
    // `healTab` rebuilds kind/ref from the key, so healing proves the key survived;
    // asserting the stored shape proves nothing else had to be reconstructed.
    // `reorder(2, 0)` put C FIRST.
    expect(raw.tabs?.at(0)).toEqual({ key: chatKey("C"), kind: "chat", ref: "C" });
    expect(persistedOrder()).toEqual([chatKey("C"), chatKey("A"), chatKey("B")]);
  });
});

describe("reorder leaves the active tab alone", () => {
  it("does not change activeKey when the moved tab is not the active one", () => {
    seedThree();
    expect(store().activeKey).toBe(chatKey("B"));
    store().reorder(0, 2);
    expect(store().activeKey).toBe(chatKey("B"));
  });

  it("does not change activeKey when the moved tab IS the active one", () => {
    seedThree();
    store().reorder(1, 2);
    expect(order()[2]).toBe(chatKey("B"));
    expect(store().activeKey).toBe(chatKey("B"));
  });

  it("leaves activeKey pointing at a tab that still exists", () => {
    seedThree();
    store().reorder(0, 2);
    expect(store().tabs.some((t) => t.key === store().activeKey)).toBe(true);
  });
});

describe("reorder is a no-op for a self-move and for out-of-range indices", () => {
  // Each case asserts THREE things, because "the order did not change" alone would
  // also pass if the action had moved a tab and then put it back.
  const assertNoOp = (label: string, from: number, to: number) => {
    const before = order();
    const beforeState = store();
    const writesBefore = storage?.writes.length ?? 0;

    store().reorder(from, to);

    expect(order(), label).toEqual(before);
    // Identity, not equality: the guard returns the SAME state object so Zustand
    // never notifies subscribers.
    expect(store().tabs, label).toBe(beforeState.tabs);
    expect(storage?.writes.length ?? 0, `${label} — no redundant localStorage write`).toBe(
      writesBefore,
    );
  };

  it("from === to", () => assertNoOp("self-move", 1, 1));
  it("negative from", () => assertNoOp("negative from", -1, 2));
  it("negative to", () => assertNoOp("negative to", 2, -1));
  it("both negative", () => assertNoOp("both negative", -1, -1));
  it("from beyond the last index", () => assertNoOp("from overflow", 3, 0));
  it("to beyond the last index", () => assertNoOp("to overflow", 0, 3));
  it("far beyond the last index", () => assertNoOp("far overflow", 0, 99));

  it("does nothing at all on an empty strip", () => {
    reset();
    expect(store().tabs).toHaveLength(0);
    store().reorder(0, 1);
    expect(store().tabs).toHaveLength(0);
  });

  it("does not resurrect the draft tab's invariant or touch activeKey on a no-op", () => {
    seedThree();
    const activeBefore = store().activeKey;
    store().reorder(1, 1);
    expect(store().activeKey).toBe(activeBefore);
    expect(order()).toEqual([chatKey("A"), chatKey("B"), chatKey("C")]);
  });
});

describe("reorder composes with the rest of the store", () => {
  it("a reordered tab can still be closed, and the neighbour rule applies", () => {
    seedThree();
    store().reorder(0, 2); // B C A
    store().setActive(chatKey("B"));
    store().close(chatKey("B"));
    expect(order()).toEqual([chatKey("C"), chatKey("A")]);
  });

  it("the never-zero-tabs rule still holds when the last tab is 'moved'", () => {
    reset();
    store().openChat("only");
    store().reorder(0, 0);
    expect(store().tabs).toHaveLength(1);
    expect(order()).toEqual([chatKey("only")]);
  });

  it("applying the same (from,to) pair twice is NOT idempotent — it is positional", () => {
    // CHARACTERISATION, not an endorsement. `reorder` takes INDICES, so the same
    // pair means "the tab currently at `from` goes to `to`" — a different tab the
    // second time round. [A,B,C] -> move A to the end -> [B,C,A] -> move B to the
    // end -> [C,A,B].
    //
    // This is pinned deliberately. It means the drag layer MUST report a drop
    // exactly once: the store offers no identity-based guard that would absorb a
    // duplicate event. A drag implementation that replays `onDragEnd` — the new
    // library's own troubleshooting notes describe a state-update/drop-animation
    // double-apply — corrupts the order silently, with every other assertion in
    // this file still green.
    seedThree();
    store().reorder(0, 2);
    const afterFirst = order();
    expect(afterFirst).toEqual([chatKey("B"), chatKey("C"), chatKey("A")]);

    store().reorder(0, 2);

    expect(order()).not.toEqual(afterFirst);
    expect(order()).toEqual([chatKey("C"), chatKey("A"), chatKey("B")]);
    // Still a permutation of the same three tabs — a double-apply corrupts the
    // ORDER, it never invents or drops a tab.
    expect(order().slice().sort()).toEqual([chatKey("A"), chatKey("B"), chatKey("C")].sort());
  });

  it("reordering does not change which conversation the tab projects to", () => {
    seedThree();
    store().reorder(0, 2);
    // `urlForTab` is a pure function of the tab, so order cannot affect routing.
    const byKey = new Map(store().tabs.map((t) => [t.key, t]));
    expect(byKey.get(chatKey("A"))?.ref).toBe("A");
    expect(byKey.get(chatKey("A"))?.kind).toBe("chat");
  });
});
