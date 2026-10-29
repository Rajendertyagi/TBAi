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
 *
 * ## THE CONTRACT THIS PINS NOW
 *
 * The chip owns TRANSPORT AND RECOVERY HEALTH only. A run, a cancellation, an
 * engine retry and a history refresh all leave a connected transport connected
 * — those are the primary pill's facts. The four cases that used to assert the
 * old heart contract ("load/run in flight = working", "retry = retrying") were
 * rewritten in S3; the heart's contract changed by design, not by accident, and
 * the cases remain to hold the new one.
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
    retry?: { attempt: number } | null;
  } = {},
) {
  return statusView({
    connection: overrides.connection ?? { type: "connected", serverVersion: "2.0.22" },
    load: overrides.load ?? { type: "ready" },
    running: overrides.running ?? false,
    cancelled: overrides.cancelled ?? false,
    recoveryBlocked: overrides.recoveryBlocked ?? false,
    retry: overrides.retry ?? null,
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

  it("keeps a load in flight off the heart: a refresh is not a connection state", () => {
    const shown = view({ load: { type: "loading" } });

    expect(shown.presentation).toBe("idle");
    expect(shown.label).toBe("Connected");
  });

  it("keeps a run in flight off the heart: turn status belongs to the primary", () => {
    const shown = view({ running: true });

    expect(shown.presentation).toBe("idle");
    expect(shown.label).toBe("Connected");
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

describe("the status chip's health predicate", () => {
  it("stays Connected while a cancelling execution runs on a connected transport", () => {
    // §2: health has no `!cancelled` term. The primary owns "Stopping…"; the
    // heart reporting Disconnected at the same moment would be a second answer
    // to one fact.
    const shown = view({ cancelled: true });

    expect(shown.presentation).toBe("idle");
    expect(shown.label).toBe("Connected");
  });

  it("is Disconnected for waiting-for-server even while cancelling", () => {
    const shown = view({
      cancelled: true,
      connection: { type: "waiting-for-server" },
    });

    expect(shown.presentation).toBe("off");
    expect(shown.label).toBe("Disconnected");
  });

  it("is Disconnected for a closed transport even while cancelling", () => {
    // §2b: `off` is driven solely by the CONNECTION, never by the execution.
    const shown = view({ cancelled: true, connection: { type: "closed" } });

    expect(shown.presentation).toBe("off");
    expect(shown.label).toBe("Disconnected");
  });

  it("keeps a reconciling load Connected", () => {
    const shown = view({ load: { type: "reconciling" } });

    expect(shown.presentation).toBe("idle");
    expect(shown.label).toBe("Connected");
  });
});

describe("the status chip's live engine retry", () => {
  it("keeps a scheduled engine retry off the heart: the primary owns the countdown", () => {
    const shown = view({ retry: { attempt: 2 } });

    expect(shown.presentation).toBe("idle");
    expect(shown.label).toBe("Connected");
    // The engine's attempt counter is not the transport's; the chip must never
    // present it as progress toward the reconnect budget.
    expect(shown.attempt).toBeNull();
  });

  it("stays Connected when a retry coincides with a refresh and a run", () => {
    const loading = view({ retry: { attempt: 1 }, load: { type: "loading" } });
    expect(loading.presentation).toBe("idle");
    expect(loading.label).toBe("Connected");

    const running = view({ retry: { attempt: 2 }, running: true });
    expect(running.presentation).toBe("idle");
    expect(running.label).toBe("Connected");
  });

  it("still loses to a reconnect: the wire, not the turn, is the fact", () => {
    const shown = view({
      retry: { attempt: 2 },
      connection: { type: "reconnecting", attempt: 4 },
    });

    expect(shown.presentation).toBe("working");
    expect(shown.label).toBe("Reconnecting (attempt 4 of 10)");
    expect(shown.attempt).toBe(4);
  });

  it("still loses to a terminal failure, which is what the reader must see", () => {
    const shown = view({
      retry: { attempt: 2 },
      connection: { type: "failed", attempt: 10 },
    });

    expect(shown.presentation).toBe("error");
    expect(shown.label).toBe("Error");
    expect(shown.canReconnect).toBe(true);
  });

  it("still loses to a failed load: an error is reported, not a wait", () => {
    const shown = view({
      retry: { attempt: 2 },
      load: { type: "error", error: { message: "history read failed" } },
    });

    expect(shown.presentation).toBe("error");
    expect(shown.label).toBe("Error");
  });
});
