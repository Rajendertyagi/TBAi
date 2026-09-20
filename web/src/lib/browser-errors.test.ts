/**
 * Browser-error classification and the global hook wiring.
 *
 * Two things must both hold: the ResizeObserver delivery notice is recognised
 * as a browser layout diagnostic, and every genuine error stays a real error.
 * The matcher is deliberately exact — a substring rule would swallow a real
 * feedback loop introduced later.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { installGlobalLogHooks, logger } from "./logger";
import {
  boundedStack,
  classifyBrowserError,
  isBrowserLayoutDiagnostic,
} from "./browser-errors";

describe("isBrowserLayoutDiagnostic", () => {
  it("recognises the exact browser notices", () => {
    expect(
      isBrowserLayoutDiagnostic("ResizeObserver loop completed with undelivered notifications."),
    ).toBe(true);
    // Trailing period is optional — browsers differ.
    expect(
      isBrowserLayoutDiagnostic("ResizeObserver loop completed with undelivered notifications"),
    ).toBe(true);
    expect(isBrowserLayoutDiagnostic("ResizeObserver loop limit exceeded")).toBe(true);
  });

  it("does NOT match a message that merely mentions ResizeObserver", () => {
    // Every one of these is an application failure and must stay one.
    for (const message of [
      "Uncaught Error: ResizeObserver loop completed with undelivered notifications.",
      "ResizeObserver loop completed with undelivered notifications. Something else failed",
      "TypeError: observer is not a function",
      "ResizeObserver is not defined",
      "ResizeObserver loop completed with undelivered notification",
    ]) {
      expect(isBrowserLayoutDiagnostic(message)).toBe(false);
    }
  });

  it("does not match ordinary errors", () => {
    for (const message of [
      "TypeError: Cannot read properties of undefined",
      "Failed to fetch",
      "",
      "NetworkError when attempting to fetch resource.",
    ]) {
      expect(isBrowserLayoutDiagnostic(message)).toBe(false);
    }
  });
});

describe("classifyBrowserError", () => {
  it("separates the layout diagnostic from an uncaught error", () => {
    expect(
      classifyBrowserError({
        message: "ResizeObserver loop completed with undelivered notifications.",
      }),
    ).toBe("layout_diagnostic");
    expect(classifyBrowserError({ message: "boom", errorName: "Error" })).toBe("uncaught");
  });
});

describe("boundedStack", () => {
  it("returns undefined for a non-Error", () => {
    expect(boundedStack("nope")).toBeUndefined();
    expect(boundedStack(undefined)).toBeUndefined();
  });

  it("bounds a long stack and keeps a short one intact", () => {
    const err = new Error("x");
    err.stack = "s".repeat(2000);
    expect(boundedStack(err, 500)?.length).toBe(500);
    const short = new Error("y");
    short.stack = "short";
    expect(boundedStack(short)).toBe("short");
  });
});

// ---- hook wiring ----

type Handler = (event: unknown) => void;
const handlers: Record<string, Handler> = {};

// Installed against a FAKE target, never `globalThis.window`: test files share
// one process, so replacing the global leaks into every other file (doing that
// here broke an unrelated localStorage-persistence suite).
installGlobalLogHooks({
  addEventListener: (type, listener) => {
    handlers[type] = listener as Handler;
  },
});

let calls: Array<{ level: string; scope: string; event: string; fields: Record<string, unknown> }> = [];
const realInfo = logger.info;
const realWarn = logger.warn;
const realError = logger.error;

function record(level: string) {
  return ((scope: string, event: string, fields: Record<string, unknown> = {}) => {
    calls.push({ level, scope, event, fields });
  }) as typeof logger.info;
}

beforeEach(() => {
  calls = [];
  logger.info = record("info");
  logger.warn = record("warn");
  logger.error = record("error");
});

afterEach(() => {
  logger.info = realInfo;
  logger.warn = realWarn;
  logger.error = realError;
});

describe("global hook wiring", () => {
  it("records the ResizeObserver notice as a layout diagnostic, not an error", () => {
    handlers["error"]({
      message: "ResizeObserver loop completed with undelivered notifications.",
      filename: "http://localhost/assets/index.js",
      lineno: 42,
      colno: 7,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ level: "warn", scope: "app", event: "browser_layout_diagnostic" });
    // Metadata is preserved so an unexpected layout problem stays diagnosable.
    expect(calls[0].fields.line).toBe(42);
    expect(calls[0].fields.column).toBe(7);
    expect(calls[0].fields.source).toBe("http://localhost/assets/index.js");
  });

  it("keeps a genuine window error a real error", () => {
    handlers["error"]({ message: "TypeError: nope", filename: "a.js", lineno: 1, colno: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ level: "error", scope: "app", event: "window_error" });
  });

  it("keeps unhandled rejections as real errors", () => {
    handlers["unhandledrejection"]({ reason: new Error("kaboom") });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ level: "error", scope: "app", event: "unhandled_rejection" });
    expect(calls[0].fields.message).toBe("kaboom");
  });

  it("does not downgrade a rejection that merely mentions ResizeObserver", () => {
    handlers["unhandledrejection"]({
      reason: new Error("Uncaught Error: ResizeObserver loop completed with undelivered notifications."),
    });
    expect(calls[0]).toMatchObject({ level: "error", event: "unhandled_rejection" });
  });
});
