import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  copyTextFromMenu,
  cutTextareaSelection,
  pastePlainTextInto,
  type TextareaLike,
} from "./clipboard";

function fakeTextarea(value: string, selection?: [number, number]): TextareaLike & {
  events: string[];
} {
  let text = value;
  const events: string[] = [];
  const [start, end] = selection ?? [0, 0];
  return {
    events,
    get value() {
      return text;
    },
    selectionStart: start,
    selectionEnd: end,
    focus: () => {},
    setRangeText: (replacement: string, s = 0, e = text.length) => {
      text = text.slice(0, s) + replacement + text.slice(e);
    },
    dispatchEvent: (event: Event) => {
      events.push(event.type);
      return true;
    },
  };
}

const realNavigator = globalThis.navigator;

function stubClipboard(stub: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: stub },
    configurable: true,
  });
}

describe("copyTextFromMenu", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: realNavigator,
      configurable: true,
    });
  });

  it("returns false for empty text without touching the clipboard", async () => {
    let calls = 0;
    stubClipboard({ writeText: async () => void calls++ });
    await expect(copyTextFromMenu("")).resolves.toBe(false);
    expect(calls).toBe(0);
  });

  it("writes via the async Clipboard API", async () => {
    let written = "";
    stubClipboard({ writeText: async (t: string) => void (written = t) });
    await expect(copyTextFromMenu("hello")).resolves.toBe(true);
    expect(written).toBe("hello");
  });

  it("returns false when the clipboard write rejects", async () => {
    stubClipboard({
      writeText: async () => {
        throw new Error("blocked");
      },
    });
    await expect(copyTextFromMenu("hello")).resolves.toBe(false);
  });
});

describe("cutTextareaSelection (atomic: copy first, remove on success only)", () => {
  beforeEach(() => {
    stubClipboard({ writeText: async () => {} });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: realNavigator,
      configurable: true,
    });
  });

  it("copies then removes the selection on success", async () => {
    let written = "";
    stubClipboard({ writeText: async (t: string) => void (written = t) });
    const ta = fakeTextarea("hello world", [0, 5]);
    let failed = 0;
    await expect(cutTextareaSelection(ta, () => void failed++)).resolves.toBe(true);
    expect(written).toBe("hello");
    expect(ta.value).toBe(" world");
    expect(ta.events).toContain("input");
    expect(failed).toBe(0);
  });

  it("keeps the text intact and reports when the write fails", async () => {
    stubClipboard({
      writeText: async () => {
        throw new Error("blocked");
      },
    });
    const ta = fakeTextarea("hello world", [0, 5]);
    let failed = 0;
    await expect(cutTextareaSelection(ta, () => void failed++)).resolves.toBe(false);
    expect(ta.value).toBe("hello world");
    expect(failed).toBe(1);
  });

  it("does nothing on an empty selection", async () => {
    const ta = fakeTextarea("hello", [2, 2]);
    let failed = 0;
    await expect(cutTextareaSelection(ta, () => void failed++)).resolves.toBe(false);
    expect(ta.value).toBe("hello");
    expect(failed).toBe(0);
  });
});

describe("insertTextAtCursor", () => {
  it("inserts at the caret without touching surrounding text", async () => {
    const { insertTextAtCursor } = await import("./clipboard");
    const ta = fakeTextarea("hello world", [5, 5]);
    expect(insertTextAtCursor(ta, " brave")).toBe(true);
    expect(ta.value).toBe("hello brave world");
    expect(ta.events).toContain("input");
  });

  it("replaces the selection and ignores empty inserts", async () => {
    const { insertTextAtCursor } = await import("./clipboard");
    const ta = fakeTextarea("hello world", [0, 5]);
    expect(insertTextAtCursor(ta, "hi")).toBe(true);
    expect(ta.value).toBe("hi world");
    expect(insertTextAtCursor(ta, "")).toBe(false);
  });
});

describe("pastePlainTextInto", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: realNavigator,
      configurable: true,
    });
  });

  it("inserts clipboard text at the cursor", async () => {
    stubClipboard({ readText: async () => "pasted" });
    const ta = fakeTextarea("ab", [1, 1]);
    let failed = 0;
    await expect(pastePlainTextInto(ta, () => void failed++)).resolves.toBe(true);
    expect(ta.value).toBe("apastedb");
    expect(ta.events).toContain("input");
    expect(failed).toBe(0);
  });

  it("reports failure when clipboard read is unavailable", async () => {
    stubClipboard({});
    const ta = fakeTextarea("ab", [0, 0]);
    let failed = 0;
    await expect(pastePlainTextInto(ta, () => void failed++)).resolves.toBe(false);
    expect(ta.value).toBe("ab");
    expect(failed).toBe(1);
  });
});
