import { afterEach, describe, expect, it } from "bun:test";
import { writeClipboardText } from "./clipboard";

/**
 * The three outcomes of a plain clipboard write.
 *
 * These are the branches the question dock's copy buttons turn into reader-facing
 * copy, so an untested branch here is a button that can fail silently. The
 * helper was moved out of the component for exactly this reason: as a private
 * function it had coverage only in its author's head.
 *
 * `globalThis.navigator` is stubbed per test because the check is deliberately
 * capability-based — it reads the same global the browser would.
 */

const realNavigator = globalThis.navigator;

function stubClipboard(writeText: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value: writeText === undefined ? {} : { clipboard: { writeText } },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { value: realNavigator, configurable: true, writable: true });
});

describe("writeClipboardText", () => {
  it("reports a confirmed write", async () => {
    const written: string[] = [];
    stubClipboard(async (text: string) => { written.push(text); });
    expect(await writeClipboardText("hello")).toBe("copied");
    // Non-vacuity: the text must actually have reached the clipboard, not merely
    // resolved without throwing.
    expect(written).toEqual(["hello"]);
  });

  it("reports a refusal distinctly from an absent API", async () => {
    stubClipboard(async () => { throw new Error("denied"); });
    expect(await writeClipboardText("hello")).toBe("refused");
  });

  it("reports unavailable when there is no clipboard at all", async () => {
    stubClipboard(undefined);
    expect(await writeClipboardText("hello")).toBe("unavailable");
  });

  it("reports unavailable when the clipboard exists but ships no writeText", async () => {
    // The shape some browsers expose: a `clipboard` object that is present but
    // cannot write. Treating this as "copied" would be a lie the reader cannot
    // detect, because nothing would be on the clipboard.
    stubClipboard(undefined);
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: {} }, configurable: true, writable: true });
    expect(await writeClipboardText("hello")).toBe("unavailable");
  });

  it("reports unavailable when writeText is present but not callable", async () => {
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: "nope" } }, configurable: true, writable: true });
    expect(await writeClipboardText("hello")).toBe("unavailable");
  });

  it("never rejects, whatever the browser does", async () => {
    // The contract the dock relies on: it awaits this to set a status, so a
    // rejection here would be an unhandled rejection in the click handler.
    stubClipboard(async () => { throw new TypeError("boom"); });
    await expect(writeClipboardText("hello")).resolves.toBe("refused");
  });

  it("distinguishes an empty string from a refused write", async () => {
    // Unlike the menu helper, an empty string is still a real write here: the
    // dock never emits one, but if it did, "copied nothing" must not be
    // reported as "the browser refused".
    stubClipboard(async () => { /* resolves without writing */ });
    expect(await writeClipboardText("")).toBe("copied");
  });
});
