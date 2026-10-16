import { describe, expect, it, beforeEach } from "bun:test";
import {
  NEW_DRAFT_TAB_ID,
  chatKey,
  freshDraftTab,
  loadPersisted,
  loadRaw,
} from "@web/features/chat/state/chatTabs.ts";

const STORAGE_KEY = "tbai:openTabs";

const storageBacking = new Map<string, string>();

class MemoryStorage implements Storage {
  getItem(key: string): string | null {
    return storageBacking.has(key) ? storageBacking.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    storageBacking.set(key, value);
  }
  removeItem(key: string): void {
    storageBacking.delete(key);
  }
  clear(): void {
    storageBacking.clear();
  }
  key(index: number): string | null {
    return Array.from(storageBacking.keys())[index] ?? null;
  }
  get length(): number {
    return storageBacking.size;
  }
}

const memoryStorage = new MemoryStorage();

if (!(globalThis as { window?: unknown }).window) {
  const win = {
    localStorage: memoryStorage,
  } as unknown;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: win,
  });
}

describe("loadPersisted and loadRaw persistence invariants", () => {
  beforeEach(() => {
    storageBacking.clear();
  });

  it("empty storage falls back to exactly one fresh draft tab", () => {
    window.localStorage.removeItem(STORAGE_KEY);
    const raw = loadRaw();
    expect(raw.tabs).toEqual([]);
    expect(raw.activeKey).toBeUndefined();

    const state = loadPersisted();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toEqual(freshDraftTab());
    expect(state.activeKey).toBe(chatKey(NEW_DRAFT_TAB_ID));
  });

  it("malformed JSON falls back to a fresh draft tab without throwing", () => {
    window.localStorage.setItem(STORAGE_KEY, "{ not valid json");
    const state = loadPersisted();
    expect(state.tabs).toEqual([freshDraftTab()]);
    expect(state.activeKey).toBe(chatKey(NEW_DRAFT_TAB_ID));
  });

  it("throwing storage falls back to a fresh draft tab", () => {
    const originalGetItem = window.localStorage.getItem;
    try {
      window.localStorage.getItem = () => {
        throw new Error("QuotaExceeded or SecurityError");
      };
      const state = loadPersisted();
      expect(state.tabs).toEqual([freshDraftTab()]);
      expect(state.activeKey).toBe(chatKey(NEW_DRAFT_TAB_ID));
    } finally {
      window.localStorage.getItem = originalGetItem;
    }
  });

  it("a snapshot whose entries are all unrepairable/poisoned heals to the fresh draft", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { key: "chat:", kind: "chat", ref: "" },
          { key: "agent:", kind: "chat", ref: ":" },
          { key: "unknown-prefix", kind: "chat", ref: "unknown" },
        ],
        activeKey: "chat:",
      }),
    );
    const state = loadPersisted();
    expect(state.tabs).toEqual([freshDraftTab()]);
    expect(state.activeKey).toBe(chatKey(NEW_DRAFT_TAB_ID));
  });

  it("preserves valid tabs while healing poisoned entries and dropping invalid ones", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { key: "chat:thread-1", kind: "chat", ref: "thread-1" },
          { key: "agent:conv-2", kind: "chat", ref: ":conv-2" }, // Poisoned shape from old builds
          { key: "agent:", kind: "agent", ref: "" }, // Unrepairable
        ],
        activeKey: "agent:conv-2",
      }),
    );
    const state = loadPersisted();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0]).toEqual({ key: "chat:thread-1", kind: "chat", ref: "thread-1" });
    expect(state.tabs[1]).toEqual({ key: "agent:conv-2", kind: "agent", ref: "conv-2" });
    expect(state.activeKey).toBe("agent:conv-2");
  });

  it("replaces a stale activeKey with the first available tab key", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [{ key: "chat:thread-1", kind: "chat", ref: "thread-1" }],
        activeKey: "chat:stale-id",
      }),
    );
    const state = loadPersisted();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeKey).toBe("chat:thread-1");
  });

  it("deduplicates tabs by key", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { key: "chat:thread-1", kind: "chat", ref: "thread-1" },
          { key: "chat:thread-1", kind: "chat", ref: "thread-1" },
        ],
        activeKey: "chat:thread-1",
      }),
    );
    const state = loadPersisted();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeKey).toBe("chat:thread-1");
  });

  describe("legacy { openIds, activeId } migration", () => {
    it("migrates clean legacy format successfully", () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          openIds: ["c1", "c2"],
          activeId: "c2",
        }),
      );
      const state = loadPersisted();
      expect(state.tabs).toEqual([
        { key: "chat:c1", kind: "chat", ref: "c1" },
        { key: "chat:c2", kind: "chat", ref: "c2" },
      ]);
      expect(state.activeKey).toBe("chat:c2");
    });

    it("cleans empty strings, whitespace, and duplicate IDs from legacy data", () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          openIds: ["c1", "", "   ", "c1", "c2"],
          activeId: "c1",
        }),
      );
      const state = loadPersisted();
      expect(state.tabs).toEqual([
        { key: "chat:c1", kind: "chat", ref: "c1" },
        { key: "chat:c2", kind: "chat", ref: "c2" },
      ]);
      expect(state.activeKey).toBe("chat:c1");
    });

    it("falls back to first tab if activeId is not in openIds", () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          openIds: ["c1", "c2"],
          activeId: "c-missing",
        }),
      );
      const state = loadPersisted();
      expect(state.activeKey).toBe("chat:c1");
    });

    it("falls back to fresh draft if openIds is empty or only whitespace", () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          openIds: ["", "  "],
          activeId: "",
        }),
      );
      const state = loadPersisted();
      expect(state.tabs).toEqual([freshDraftTab()]);
      expect(state.activeKey).toBe(chatKey(NEW_DRAFT_TAB_ID));
    });
  });
});
