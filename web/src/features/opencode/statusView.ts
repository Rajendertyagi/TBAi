/**
 * What the status chip shows for the OpenCode runtime's connection.
 *
 * ## WHY THIS EXISTS
 *
 * The chip has two sources of truth and used to pick the wrong one. It kept a
 * local `armed` flag - set when the reader pressed Reconnect - and used that
 * to decide "Reconnecting…", while the RUNTIME's own connection state
 * (`connection: {type:"reconnecting", attempt}`) went unread. The result was
 * that an automatic reconnect - one the runtime scheduled for itself, after a
 * stream failure - showed as a red "Error", because the runtime sets
 * `load: error` while it waits for the next attempt, and the chip read the
 * load state first.
 *
 * The runtime's connection state is the fact. It is set by the one component
 * that knows whether a retry is scheduled (`sync/eventPipeline.ts`), it carries
 * the attempt number, and it distinguishes the terminal state from the
 * in-between one. A local flag cannot: it can only say "the reader asked".
 *
 * This module is a pure decision function so the mapping is testable without a
 * DOM, and so the chip and the popover cannot disagree about it.
 */

/** The connection states the runtime reports. Mirrors `V2ConnectionState`. */
export type ConnectionState =
  | { readonly type: "waiting-for-server" }
  | { readonly type: "connected"; readonly serverVersion: string | null }
  | { readonly type: "reconnecting"; readonly attempt: number }
  | { readonly type: "failed"; readonly attempt: number }
  | { readonly type: "closed" };

/** The load states the runtime reports. Mirrors `V2LoadState`. */
export type LoadState =
  | { readonly type: "idle" }
  | { readonly type: "loading" }
  | { readonly type: "ready" }
  | { readonly type: "reconciling" }
  | { readonly type: "error"; readonly error: { readonly message: string } };

/** How the chip presents itself. */
export type StatusPresentation = "error" | "off" | "working" | "idle";

/** What the chip shows, derived from the runtime's own state. */
export interface StatusView {
  /** Which heart to draw. */
  readonly presentation: StatusPresentation;
  /** The label beside the heart. */
  readonly label: string;
  /**
   * The attempt number of an automatic reconnect, or `null` when the runtime is
   * not reconnecting.
   */
  readonly attempt: number | null;
  /**
   * Whether the manual Reconnect control is available.
   *
   * A terminal failure is the one state where the reader is expected to act:
   * the runtime has spent its budget and will not try again.
   */
  readonly canReconnect: boolean;
  /**
   * Whether the runtime is in a terminal failure.
   *
   * The terminal state keeps the ERROR presentation even though it is also
   * the state that offers the manual control - the two are separate facts.
   */
  readonly failed: boolean;
}

/**
 * Whether the transport is healthy.
 *
 * This is the plan's health predicate and it is deliberately narrow: the heart
 * and the primary both read it, so "the heart is idle" and "the primary may
 * present" are one decision rather than two that can drift apart. It says
 * nothing about a turn: a cancelling execution, a live engine retry, a running
 * tool and a load refresh all leave it true.
 *
 * @param args - The runtime's connection and load state, and whether the staged
 * recovery is blocked.
 * @returns True when the runtime is connected, has no load error and no blocked
 * recovery.
 */
export function isConnectionHealthy(args: {
  readonly connection: ConnectionState;
  readonly load: LoadState;
  readonly recoveryBlocked: boolean;
}): boolean {
  return (
    args.connection.type === "connected" && args.load.type !== "error" && !args.recoveryBlocked
  );
}

/**
 * Derives what the status chip shows from the runtime's state.
 *
 * The chip owns TRANSPORT AND RECOVERY HEALTH only. The precedence is:
 *
 * 1. A terminal failure is an error, and it offers the manual control.
 * 2. An automatic reconnect is NOT an error. The runtime sets `load: error`
 *    while it waits for its next attempt, so the load state is only consulted
 *    once the connection state says the runtime is neither reconnecting nor
 *    connected.
 * 3. A blocked recovery or a failed load is an error.
 * 4. A runtime that is not connected is "off".
 * 5. Otherwise the runtime is connected and idle — even while a run, a
 *    cancellation, an engine retry or a history refresh is in flight. Those
 *    belong to the primary status pill, and a chip that pulsed for them would
 *    report one fact in two places.
 *
 * `running`, `cancelled` and `retry` remain part of the input so the caller
 * states the full runtime snapshot and so a regression that reintroduces
 * turn-level coupling has an input to read: the unit suite proves each of the
 * three is ignored here.
 *
 * @param args - The runtime's connection and load state, the live turn facts
 * (accepted but not consulted), and the reconnect budget.
 * @returns What the chip shows.
 */
export function statusView(args: {
  readonly connection: ConnectionState;
  readonly load: LoadState;
  readonly running: boolean;
  readonly cancelled: boolean;
  readonly recoveryBlocked: boolean;
  readonly retry: { readonly attempt: number } | null;
  readonly maxAttempts: number;
}): StatusView {
  const { connection, load, recoveryBlocked, maxAttempts } = args;
  if (connection.type === "reconnecting") {
    return {
      presentation: "working",
      label: `Reconnecting (attempt ${connection.attempt} of ${maxAttempts})`,
      attempt: connection.attempt,
      canReconnect: false,
      failed: false,
    };
  }
  if (connection.type === "failed") {
    return {
      presentation: "error",
      label: "Error",
      attempt: connection.attempt,
      canReconnect: true,
      failed: true,
    };
  }
  if (recoveryBlocked) {
    return {
      presentation: "error",
      label: "Error",
      attempt: null,
      canReconnect: true,
      failed: false,
    };
  }
  if (load.type === "error") {
    return {
      presentation: "error",
      label: "Error",
      attempt: null,
      canReconnect: true,
      failed: false,
    };
  }
  if (!isConnectionHealthy({ connection, load, recoveryBlocked })) {
    return {
      presentation: "off",
      label: "Disconnected",
      attempt: null,
      canReconnect: false,
      failed: false,
    };
  }
  return {
    presentation: "idle",
    label: "Connected",
    attempt: null,
    canReconnect: false,
    failed: false,
  };
}
