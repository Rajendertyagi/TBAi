import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildCompactEntry,
  COMPACT_COMMAND_NAME,
  COMPACT_ENTRY_ID,
  isCompactCommandText,
  runCompactSession,
  shouldOfferCompact,
} from "./compactSession";
import { logger } from "../../lib/logger";

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

describe("compact run lifecycle", () => {
  const realInfo = logger.info;
  const realWarn = logger.warn;
  let events: Array<{ level: string; event: string; fields: Record<string, unknown> }>;

  beforeEach(() => {
    events = [];
    logger.info = ((_scope: string, event: string, fields: Record<string, unknown> = {}) => {
      events.push({ level: "info", event, fields });
    }) as typeof logger.info;
    logger.warn = ((_scope: string, event: string, fields: Record<string, unknown> = {}) => {
      events.push({ level: "warn", event, fields });
    }) as typeof logger.warn;
  });

  afterEach(() => {
    logger.info = realInfo;
    logger.warn = realWarn;
  });

  it("records a started/completed pair carrying the session", async () => {
    let ran = false;
    await runCompactSession(
      async () => {
        ran = true;
      },
      { sessionId: "ses_1" },
    );

    expect(ran).toBe(true);
    expect(events.map((e) => e.event)).toEqual([
      "command.compact_started",
      "command.compact_completed",
    ]);
    expect(events.every((e) => e.fields.sessionId === "ses_1")).toBe(true);
  });

  it("records failure and rethrows, so a refused compact is never silent", async () => {
    const failure = new Error("summarize refused");

    // Rethrowing is the contract: the caller owns the user-visible error, this
    // only observes. Swallowing here would make the UI claim success.
    await expect(runCompactSession(() => Promise.reject(failure))).rejects.toBe(failure);

    expect(events.map((e) => e.event)).toEqual([
      "command.compact_started",
      "command.compact_failed",
    ]);
    // `completed` must be absent, or a failed run would read as a success.
    expect(events.some((e) => e.event === "command.compact_completed")).toBe(false);
    expect(events[1]?.level).toBe("warn");
    expect(events[1]?.fields.error).toBe("summarize refused");
  });
});
