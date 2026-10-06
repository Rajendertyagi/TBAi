import { describe, expect, it } from "bun:test";
import {
  createCompositionTracker,
  isComposing,
  isIMECompositionEvent,
  isPlainEnter,
  isPlainEscape,
  type CompositionTarget,
} from "./ime";

/**
 * The IME guard, which decides whether Enter means "newline" or "submit".
 *
 * Composing an IME candidate fires a keydown for Enter. If that were treated as
 * a submit, a reader answering in Japanese, Chinese or Korean would have their
 * half-finished reading sent as their answer, and the pinyin would be stored
 * instead of the kanji they meant. Both signals are checked because engines
 * disagree about which one they set.
 *
 * The event signals alone are NOT sufficient, which is why the tracker exists.
 * See the Safari ordering case below.
 */

function reactEvent(init: { isComposing?: boolean; keyCode?: number }): React.KeyboardEvent {
  return { nativeEvent: { isComposing: init.isComposing ?? false, keyCode: init.keyCode ?? 0 } } as never;
}

function nativeEvent(init: { isComposing?: boolean; keyCode?: number }): KeyboardEvent {
  return { isComposing: init.isComposing ?? false, keyCode: init.keyCode ?? 0 } as never;
}

/** A keydown-shaped event, for the intent-named helpers. */
function key(init: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
}): React.KeyboardEvent {
  return {
    key: init.key,
    shiftKey: init.shiftKey ?? false,
    nativeEvent: { isComposing: init.isComposing ?? false, keyCode: 0 },
  } as never;
}

/**
 * Minimal EventTarget stand-in. A real DOM is deliberately not used: the test
 * suite has no DOM, and the tracker's whole contract is "listen to these two
 * events", which this expresses exactly.
 */
function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>();
  const target: CompositionTarget = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    target,
    fire(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

describe("isIMECompositionEvent", () => {
  it("is true while a composition is open", () => {
    expect(isIMECompositionEvent(nativeEvent({ isComposing: true }))).toBe(true);
    expect(isIMECompositionEvent(reactEvent({ isComposing: true }))).toBe(true);
  });

  it("is true for the 229 keyCode, which some engines report instead", () => {
    // WebKit/Blink report keyCode 229 during composition while leaving
    // `isComposing` false, so either signal alone is not enough.
    expect(isIMECompositionEvent(nativeEvent({ keyCode: 229 }))).toBe(true);
    expect(isIMECompositionEvent(reactEvent({ keyCode: 229 }))).toBe(true);
  });

  it("is false for an ordinary keypress", () => {
    expect(isIMECompositionEvent(nativeEvent({}))).toBe(false);
    expect(isIMECompositionEvent(reactEvent({}))).toBe(false);
  });

  it("is false for an ordinary Enter, which is the case that must submit", () => {
    // Non-vacuity: without this, a guard that always returned true would pass
    // the composition cases and silently make the form unanswerable.
    expect(isIMECompositionEvent(nativeEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
    expect(isIMECompositionEvent(reactEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it("unwraps a React event to its native event", () => {
    // The React handler's own object has no `isComposing`; only the wrapped
    // native event does. Reading the wrapper directly would always answer false.
    const event = { nativeEvent: { isComposing: true, keyCode: 229 } } as never;
    expect(isIMECompositionEvent(event)).toBe(true);
  });
});

describe("createCompositionTracker", () => {
  it("reports composing between start and end", () => {
    const fake = fakeTarget();
    const tracker = createCompositionTracker(fake.target, (fn) => fn());
    expect(tracker.isComposing()).toBe(false);
    fake.fire("compositionstart");
    expect(tracker.isComposing()).toBe(true);
    fake.fire("compositionend");
    expect(tracker.isComposing()).toBe(false);
  });

  it("still suppresses the keydown that ends a composition (the Safari case)", () => {
    // Safari emits `compositionend` BEFORE the final `keydown`. With a
    // synchronous reset the flag would already be false when that keydown
    // arrives; the event's own `isComposing` is false too, and its keyCode is a
    // normal 13 — so the Enter that ENDED the composition would run the
    // handler, which is the exact failure this module exists to prevent.
    //
    // Asserted directly: the reset is deferred, and the flag is read again
    // before the scheduler has run.
    const fake = fakeTarget();
    const pending: Array<() => void> = [];
    const tracker = createCompositionTracker(fake.target, (fn) => pending.push(fn));

    fake.fire("compositionstart");
    fake.fire("compositionend"); // Safari: this arrives first
    // The keydown now, while the deferred reset is still queued.
    expect(tracker.isComposing()).toBe(true);

    // Only once the task drains does an ordinary Enter work again.
    for (const fn of pending) fn();
    expect(tracker.isComposing()).toBe(false);
  });

  it("detaches both listeners on dispose", () => {
    const fake = fakeTarget();
    const tracker = createCompositionTracker(fake.target, (fn) => fn());
    expect(fake.count("compositionstart")).toBe(1);
    expect(fake.count("compositionend")).toBe(1);
    tracker.dispose();
    expect(fake.count("compositionstart")).toBe(0);
    expect(fake.count("compositionend")).toBe(0);
  });
});

describe("isComposing", () => {
  it("falls back to the event's own signal when no tracker is attached", () => {
    // No DOM in this environment, so the shared tracker cannot exist. The event
    // signal must still be honoured, or the very first keydown of a composition
    // would slip through.
    expect(isComposing(key({ key: "Enter", isComposing: true }))).toBe(true);
    expect(isComposing(key({ key: "Enter" }))).toBe(false);
  });
});

describe("isPlainEnter / isPlainEscape", () => {
  it("accepts an ordinary Enter and Escape", () => {
    expect(isPlainEnter(key({ key: "Enter" }))).toBe(true);
    expect(isPlainEscape(key({ key: "Escape" }))).toBe(true);
  });

  it("rejects Enter and Escape while a composition owns the key", () => {
    expect(isPlainEnter(key({ key: "Enter", isComposing: true }))).toBe(false);
    expect(isPlainEscape(key({ key: "Escape", isComposing: true }))).toBe(false);
  });

  it("rejects Shift+Enter, which is a deliberate chord", () => {
    expect(isPlainEnter(key({ key: "Enter", shiftKey: true }))).toBe(false);
    // …while leaving plain Enter available, so the rejection is not vacuous.
    expect(isPlainEnter(key({ key: "Enter" }))).toBe(true);
  });

  it("rejects other keys", () => {
    expect(isPlainEnter(key({ key: "a" }))).toBe(false);
    expect(isPlainEscape(key({ key: "Enter" }))).toBe(false);
  });
});