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
 * Derives what the status chip shows from the runtime's state.
 *
 * The precedence is deliberate:
 *
 * 1. A terminal failure is an error, and it offers the manual control.
 * 2. An automatic reconnect is NOT an error. The runtime sets `load: error`
 *    while it waits for its next attempt, so the load state is only consulted
 *    once the connection state says the runtime is neither reconnecting nor
 *    connected.
 * 3. A runtime that is not connected is "off".
 * 4. A load or a run in flight is "working".
 * 5. Otherwise the runtime is connected and idle.
 *
 * @param args - The runtime's connection and load state, whether the run is in
 * flight, and the reconnect budget.
 * @returns What the chip shows.
 */
export function statusView(args: {
  readonly connection: ConnectionState;
  readonly load: LoadState;
  readonly running: boolean;
  readonly cancelled: boolean;
  readonly recoveryBlocked: boolean;
  readonly maxAttempts: number;
}): StatusView {
  const { connection, load, running, cancelled, recoveryBlocked, maxAttempts } = args;
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
  if (connection.type !== "connected" || cancelled) {
    return {
      presentation: "off",
      label: "Disconnected",
      attempt: null,
      canReconnect: false,
      failed: false,
    };
  }
  if (load.type === "loading" || load.type === "reconciling" || running) {
    return {
      presentation: "working",
      label: "Working",
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
