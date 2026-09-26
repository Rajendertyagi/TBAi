import { describe, expect, it } from "bun:test";
import {
  buildCompactEntry,
  COMPACT_COMMAND_NAME,
  COMPACT_ENTRY_ID,
  isCompactCommandText,
  shouldOfferCompact,
} from "./compactSession";

describe("native compact command grammar", () => {
  it("matches only whole-box invocations", () => {
    expect(isCompactCommandText("/compact")).toBe(true);
    expect(isCompactCommandText("  /compact now")).toBe(true);
    expect(isCompactCommandText("/compactfoo")).toBe(false);
    expect(isCompactCommandText("please /compact")).toBe(false);
  });

  it("offers compact only with a native Code callback", () => {
    const context = { sessionId: "ses_1", compact: async () => undefined };
    expect(shouldOfferCompact(true, context)).toBe(true);
    expect(shouldOfferCompact(false, context)).toBe(false);
    expect(shouldOfferCompact(true, { sessionId: "ses_1" })).toBe(false);
    expect(shouldOfferCompact(true, null)).toBe(false);
  });

  it("keeps the built-in palette entry server-free", () => {
    const selected: string[] = [];
    const entry = buildCompactEntry((name) => selected.push(name));
    expect(entry.id).toBe(COMPACT_ENTRY_ID);
    expect(entry.label).toBe(`/${COMPACT_COMMAND_NAME}`);
    entry.execute();
    expect(selected).toEqual(["compact"]);
  });
});
