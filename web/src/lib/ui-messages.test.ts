import { describe, expect, it } from "bun:test";
import { lastUserText } from "./ui-messages";

/**
 * The shared "what did the user actually type" primitive, now used by two
 * callers (the runtime's draft handoff and the Composer's retry). Defensive by
 * contract: it runs against runtime state that may be mid-hydration.
 */

describe("lastUserText", () => {
  it("returns the most recent user turn's text", () => {
    expect(
      lastUserText([
        { role: "user", parts: [{ type: "text", text: "first" }] },
        { role: "assistant", parts: [{ type: "text", text: "an answer" }] },
        { role: "user", parts: [{ type: "text", text: "second" }] },
      ]),
    ).toBe("second");
  });

  it("joins multiple text parts and ignores non-text parts", () => {
    expect(
      lastUserText([
        {
          role: "user",
          parts: [
            { type: "text", text: "look at" },
            { type: "file", text: "ignored" },
            { type: "text", text: "this" },
          ],
        },
      ]),
    ).toBe("look at\nthis");
  });

  it("skips a trailing user turn that carries no text", () => {
    expect(
      lastUserText([
        { role: "user", parts: [{ type: "text", text: "the real one" }] },
        { role: "user", parts: [{ type: "image" }] },
      ]),
    ).toBe("the real one");
  });

  it("returns null when there is no user text at all", () => {
    expect(lastUserText([])).toBeNull();
    expect(lastUserText(undefined)).toBeNull();
    expect(lastUserText("not messages")).toBeNull();
    expect(lastUserText([{ role: "assistant", parts: [{ type: "text", text: "hi" }] }])).toBeNull();
    // Hydration in progress: a message with no parts yet is not a user turn.
    expect(lastUserText([{ role: "user" }])).toBeNull();
  });
});
