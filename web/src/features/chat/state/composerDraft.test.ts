import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  readComposerDraft,
  writeComposerDraft,
  clearComposerDraft,
} from "./composerDraft";
import {
  useAvailabilityStore,
  resetAvailabilityForTests,
} from "../../availability/availabilityStore";
import { registerAvailabilityRecovery } from "../../availability/recovery";
import { useSettingsStore } from "../../../stores";

function installMemoryStorage(): () => void {
  const holder = globalThis as unknown as { localStorage?: unknown };
  const prev = holder.localStorage;
  const store = new Map<string, string>();
  holder.localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return () => {
    if (prev === undefined) delete holder.localStorage;
    else holder.localStorage = prev;
  };
}

const realFetch = globalThis.fetch;
let restoreStorage: (() => void) | null = null;

beforeEach(() => {
  restoreStorage = installMemoryStorage();
  resetAvailabilityForTests();
});

afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
  globalThis.fetch = realFetch;
  resetAvailabilityForTests();
});

describe("composerDraft helpers (Phase 3.7)", () => {
  it("[P3-13a] round-trips non-empty text with an updatedAt stamp", () => {
    writeComposerDraft("thread-a", "hello world");
    const read = readComposerDraft("thread-a");
    expect(read?.text).toBe("hello world");
    expect(typeof read?.updatedAt).toBe("number");
  });

  it("[P3-13b] drafts are keyed per thread and never cross-contaminate", () => {
    writeComposerDraft("thread-a", "draft A");
    writeComposerDraft("thread-b", "draft B");
    expect(readComposerDraft("thread-a")?.text).toBe("draft A");
    expect(readComposerDraft("thread-b")?.text).toBe("draft B");
    clearComposerDraft("thread-a");
    expect(readComposerDraft("thread-a")).toBeNull();
    expect(readComposerDraft("thread-b")?.text).toBe("draft B");
  });

  it("[P3-13c] writing empty text removes the key (send or manual clear)", () => {
    writeComposerDraft("thread-a", "something");
    expect(readComposerDraft("thread-a")?.text).toBe("something");
    writeComposerDraft("thread-a", "");
    expect(readComposerDraft("thread-a")).toBeNull();
  });

  it("[P3-13d] corrupt / non-string / empty payloads read as null, never throw", () => {
    const holder = globalThis as unknown as {
      localStorage: {
        setItem: (k: string, v: string) => void;
      };
    };
    holder.localStorage.setItem("tbai:composer-draft:bad", "not-json{{{");
    expect(readComposerDraft("bad")).toBeNull();
    holder.localStorage.setItem(
      "tbai:composer-draft:wrong-type",
      JSON.stringify({ text: 42 }),
    );
    expect(readComposerDraft("wrong-type")).toBeNull();
    holder.localStorage.setItem(
      "tbai:composer-draft:empty-text",
      JSON.stringify({ text: "" }),
    );
    expect(readComposerDraft("empty-text")).toBeNull();
  });

  it("[P3-13e] nullish thread keys are no-ops, never throw", () => {
    expect(readComposerDraft(null)).toBeNull();
    expect(readComposerDraft(undefined)).toBeNull();
    writeComposerDraft(null, "x");
    writeComposerDraft(undefined, "x");
    clearComposerDraft(null);
    clearComposerDraft(undefined);
  });
});

describe("composerDraft vs recovery (Phase 3.7/3.8)", () => {
  it("[P3-20] the recovery sequence does not clear or overwrite a saved draft", async () => {
    writeComposerDraft("c1", "keep me — do not auto-send");
    useSettingsStore.setState({
      providers: [],
      activeProviderId: null,
      selectedProviderId: null,
      selectedModelId: null,
      selectedReasoningLevel: null,
    });

    let down = true;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u === "/readyz") {
        if (down) throw new TypeError("fetch failed");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ready: true }),
        } as Response;
      }
      if (u === "/api/providers") {
        return { ok: true, status: 200, json: async () => [] } as Response;
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch;

    const unsub = registerAvailabilityRecovery();
    try {
      await useAvailabilityStore.getState().probeNow();
      await useAvailabilityStore.getState().probeNow();
      expect(useAvailabilityStore.getState().status).toBe("offline");

      down = false;
      await useAvailabilityStore.getState().probeNow();
      expect(useAvailabilityStore.getState().status).toBe("online");
      expect(useAvailabilityStore.getState().recoveryEpoch).toBe(1);

      // Untouched by recovery: same text, still present, never submitted.
      expect(readComposerDraft("c1")?.text).toBe("keep me — do not auto-send");
    } finally {
      unsub();
    }
  });
});
