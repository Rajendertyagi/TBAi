import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  logger,
  type LogLevelFilter,
  type LogTargetDirective,
} from "../../src/lib/logger";
import {
  logFileNameSchema,
  logRecentQuerySchema,
  logSettingsSchema,
} from "../../src/lib/validation";
import {
  applyPersistedLogSettings,
  getPersistedLogSettings,
  isLogLevelEnvLocked,
  persistLogSettings,
} from "../../src/services/log-settings";

const TBAI_LEVEL_KEY = "TBAI_LOG_LEVEL";

function configure(level: LogLevelFilter, targets: LogTargetDirective[] = []) {
  logger.configure({ level, targets, file: null });
}

describe("scope capture levels", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env[TBAI_LEVEL_KEY];
    configure("debug", []);
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[TBAI_LEVEL_KEY];
    else process.env[TBAI_LEVEL_KEY] = savedEnv;
    configure("error", []);
  });

  it("uses the global level with no overrides", () => {
    configure("warn", []);
    expect(logger.levelForScope("http")).toBe("warn");
    expect(logger.isEnabled("info", "http")).toBe(false);
    expect(logger.isEnabled("warn", "http")).toBe(true);
  });

  it("matches a scope and everything below it, longest wins", () => {
    configure("info", [
      { scope: "mcp", level: "debug" },
      { scope: "mcp.client", level: "error" },
    ]);
    expect(logger.levelForScope("mcp")).toBe("debug");
    expect(logger.levelForScope("mcp.client")).toBe("error");
    expect(logger.levelForScope("mcp.client.tool")).toBe("error");
    expect(logger.levelForScope("http")).toBe("info");
    // Prefix without a dot boundary does not match.
    expect(logger.levelForScope("mcpish")).toBe("info");
  });

  it("off silences globally and per scope", () => {
    configure("off", []);
    expect(logger.isEnabled("error", "http")).toBe(false);
    configure("debug", [{ scope: "chat", level: "off" }]);
    expect(logger.isEnabled("error", "chat")).toBe(false);
    expect(logger.isEnabled("debug", "http")).toBe(true);
  });

  it("write() drops entries below the effective level", () => {
    configure("error", [{ scope: "mcp", level: "debug" }]);
    const since = logger.lastSeq;
    logger.debug("http", "dropped_event");
    logger.debug("mcp", "kept_event");
    const fresh = logger.getRecentEntries(since).map((e) => e.event);
    expect(fresh).not.toContain("dropped_event");
    expect(fresh).toContain("kept_event");
  });

  it("targets getter returns a copy", () => {
    configure("info", [{ scope: "mcp", level: "debug" }]);
    const copy = logger.targets;
    copy.push({ scope: "x", level: "error" });
    expect(logger.targets).toHaveLength(1);
  });
});

describe("log settings validation", () => {
  it("accepts a full payload and defaults targets", () => {
    const parsed = logSettingsSchema.safeParse({ level: "warn" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.targets).toEqual([]);
  });

  it("rejects bad scopes and levels", () => {
    expect(
      logSettingsSchema.safeParse({ level: "info", targets: [{ scope: "has space", level: "debug" }] })
        .success,
    ).toBe(false);
    expect(
      logSettingsSchema.safeParse({ level: "info", targets: [{ scope: "a::b", level: "debug" }] })
        .success,
    ).toBe(false);
    expect(logSettingsSchema.safeParse({ level: "trace", targets: [] }).success).toBe(false);
    expect(
      logSettingsSchema.safeParse({ level: "debug", targets: [{ scope: "mcp.client", level: "off" }] })
        .success,
    ).toBe(true);
  });

  it("coerces recent-query params and caps limit", () => {
    const parsed = logRecentQuerySchema.safeParse({ since: "10", limit: "50" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.since).toBe(10);
      expect(parsed.data.limit).toBe(50);
    }
    expect(logRecentQuerySchema.safeParse({ limit: 99999 }).success).toBe(false);
    expect(logRecentQuerySchema.safeParse({ minLevel: "trace" }).success).toBe(false);
  });

  it("locks log file names to the rotated sink", () => {
    expect(logFileNameSchema.safeParse("tbai.log").success).toBe(true);
    expect(logFileNameSchema.safeParse("tbai.log.2").success).toBe(true);
    expect(logFileNameSchema.safeParse("../chat.db").success).toBe(false);
    expect(logFileNameSchema.safeParse("tbai.log.1x").success).toBe(false);
    expect(logFileNameSchema.safeParse("other.log").success).toBe(false);
  });
});

describe("log settings persistence", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env[TBAI_LEVEL_KEY];
    delete process.env[TBAI_LEVEL_KEY];
    configure("debug", []);
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[TBAI_LEVEL_KEY];
    else process.env[TBAI_LEVEL_KEY] = savedEnv;
    persistLogSettings({ level: "debug", targets: [] });
    configure("error", []);
  });

  it("round-trips through app_settings", () => {
    persistLogSettings({ level: "warn", targets: [{ scope: "mcp", level: "debug" }] });
    expect(getPersistedLogSettings()).toEqual({
      level: "warn",
      targets: [{ scope: "mcp", level: "debug" }],
    });
  });

  it("applies stored settings at boot unless env owns the level", () => {
    persistLogSettings({ level: "error", targets: [] });
    applyPersistedLogSettings();
    expect(logger.level).toBe("error");

    process.env[TBAI_LEVEL_KEY] = "debug";
    expect(isLogLevelEnvLocked()).toBe(true);
    configure("info", []);
    applyPersistedLogSettings();
    expect(logger.level).toBe("info");
  });
});
