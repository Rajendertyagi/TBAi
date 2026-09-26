import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDirectResumableStorage,
  directResumeStorageKey,
  readDirectResumableStreamId,
} from "./resumable-stream";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  get length(): number {
    return this.values.size;
  }
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
let sessionStorage: MemoryStorage;
let testWindow: { sessionStorage: Storage };

beforeEach(() => {
  sessionStorage = new MemoryStorage();
  testWindow = { sessionStorage };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: testWindow,
  });
});

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("Direct resumable stream storage", () => {
  it("preserves tbai-resume:<threadId> keys and reads the selected thread's stream id", () => {
    const threadAStorage = createDirectResumableStorage(() => "thread-a");
    const threadBStorage = createDirectResumableStorage(() => "thread-b");

    threadAStorage.setStreamId("stream-a", "thread-a");
    threadBStorage.setStreamId("stream-b", "thread-b");

    expect(directResumeStorageKey("thread-a")).toBe("tbai-resume:thread-a");
    expect(sessionStorage.getItem("tbai-resume:thread-a")).toBe("stream-a");
    expect(sessionStorage.getItem("tbai-resume:thread-b")).toBe("stream-b");
    expect(readDirectResumableStreamId("thread-a")).toBe("stream-a");
    expect(readDirectResumableStreamId("thread-b")).toBe("stream-b");
  });

  it("returns null when no thread id is available", () => {
    expect(readDirectResumableStreamId(null)).toBeNull();
    expect(readDirectResumableStreamId(undefined)).toBeNull();
  });

  it("returns null when the requested thread has no stored stream id", () => {
    expect(readDirectResumableStreamId("thread-without-stream")).toBeNull();
  });

  it("returns null when browser session storage is unavailable", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(readDirectResumableStreamId("thread-a")).toBeNull();

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: testWindow,
    });
    Object.defineProperty(testWindow, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("sessionStorage blocked", "SecurityError");
      },
    });

    expect(readDirectResumableStreamId("thread-a")).toBeNull();
  });
});
