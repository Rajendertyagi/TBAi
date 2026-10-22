/**
 * The status chip's presentation, derived from the runtime's own state.
 *
 * ## THE DEFECT THIS PINS
 *
 * The chip used to keep a local `armed` flag - set when the reader pressed
 * Reconnect - and used THAT to decide "Reconnecting…", while the runtime's own
 * `connection: {type:"reconnecting", attempt}` went unread. An automatic
 * reconnect therefore showed as a red "Error": the runtime sets `load: error`
 * while it waits for its next attempt, and the chip read the load state first.
 *
 * The runtime's connection state is the fact. It is set by the one component
 * that knows whether a retry is scheduled, and it carries the attempt number.
 */

import { describe, expect, it } from "bun:test";
import { statusView } from "@web/features/opencode/statusView.ts";

const BUDGET = 10;

function view(
  overrides: {
    connection?: Parameters<typeof statusView>[0]["connection"];
    load?: Parameters<typeof statusView>[0]["load"];
    running?: boolean;
    cancelled?: boolean;
    recoveryBlocked?: boolean;
  } = {},
) {
  return statusView({
    connection: overrides.connection ?? { type: "connected", serverVersion: "2.0.22" },
    load: overrides.load ?? { type: "ready" },
    running: overrides.running ?? false,
    cancelled: overrides.cancelled ?? false,
    recoveryBlocked: overrides.recoveryBlocked ?? false,
    maxAttempts: BUDGET,
  });
}

describe("the OpenCode status chip's presentation", () => {
  it("shows an automatic reconnect as a reconnecting state, not as an error", () => {
    // The runtime sets `load: error` while it waits for its next attempt, so
    // the load state alone would report a red Error for a reconnect that is
    // about to succeed.
    const shown = view({
      connection: { type: "reconnecting", attempt: 3 },
      load: { type: "error", error: { message: "stream failed" } },
    });

    expect(shown.presentation).toBe("working");
    expect(shown.label).toBe("Reconnecting (attempt 3 of 10)");
    expect(shown.attempt).toBe(3);
    expect(shown.failed).toBe(false);
  });

  it("keeps the terminal failure an error, and offers the manual control", () => {
    const shown = view({
      connection: { type: "failed", attempt: 10 },
      load: { type: "error", error: { message: "stream failed" } },
    });

    expect(shown.presentation).toBe("error");
    expect(shown.label).toBe("Error");
    expect(shown.failed).toBe(true);
    expect(shown.canReconnect).toBe(true);
  });

  it("shows a connected, idle runtime as connected", () => {
    const shown = view();

    expect(shown.presentation).toBe("idle");
    expect(shown.label).toBe("Connected");
    expect(shown.attempt).toBeNull();
  });

  it("shows a runtime that has no connection as disconnected", () => {
    const shown = view({ connection: { type: "waiting-for-server" } });

    expect(shown.presentation).toBe("off");
    expect(shown.label).toBe("Disconnected");
  });

  it("shows a load in flight as working", () => {
    const shown = view({ load: { type: "loading" } });

    expect(shown.presentation).toBe("working");
    expect(shown.label).toBe("Working");
  });

  it("shows a run in flight as working", () => {
    const shown = view({ running: true });

    expect(shown.presentation).toBe("working");
  });

  it("shows a blocked recovery as an error with the manual control", () => {
    const shown = view({ recoveryBlocked: true });

    expect(shown.presentation).toBe("error");
    expect(shown.canReconnect).toBe(true);
  });

  it("shows a failed load that is not a reconnect as an error", () => {
    const shown = view({ load: { type: "error", error: { message: "history read failed" } } });

    expect(shown.presentation).toBe("error");
    expect(shown.label).toBe("Error");
    expect(shown.failed).toBe(false);
  });
});
