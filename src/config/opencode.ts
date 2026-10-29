import path from "node:path";

import { DATA_DIR } from "./data-dir";

/**
 * Centralized OpenCode integration configuration. Every value that would
 * otherwise be a magic string/number lives here so it is defined once.
 */
export const OPENCODE_CONFIG = {
  /** Default binary name used only when no explicit path is configured. */
  binaryName: "opencode",
  /** Explicit managed V2 binary override. */
  binaryEnvVar: "OPENCODE_BINARY",
  /** HTTP path prefix the Hono proxy is mounted at; stripped before forwarding. */
  proxyPathPrefix: "/api/opencode",
  /** Max time to wait for readiness before failing startup. */
  startupTimeoutMs: 30_000,
  /** Interval between HTTP readiness probes while the managed server starts. */
  readyPollMs: 250,
  /** OpenCode V2 authenticated readiness endpoint. */
  readinessProbePath: "/api/info",
  /**
   * Budget for `opencode debug paths db`, the authoritative way to learn which
   * database the managed child will open before it is spawned. A timeout is a
   * refusal (G2), never a guess at a default path.
   */
  databasePathTimeoutMs: 5_000,
  /**
   * Budget for the `--version` preflight that `resolveAndValidateManagedBinary`
   * runs before anything is spawned.
   *
   * MEASURED: a warm `opencode --version` on the pinned binary answered in
   * 96-262 ms over five runs. The budget used to be a literal 2,000 ms, which
   * was enough locally and not enough on a loaded CI runner: a cold start of a
   * large signed executable (first-run AV scan, cold page cache) exceeded it,
   * and the timeout surfaced through the `/api/opencode/config` route as
   * `opencode.config_read_error` - a configuration failure that was really a
   * slow process launch. The bound is named here, documented with the
   * measurement, and confined to the preflight: it is not the readiness budget
   * (`startupTimeoutMs`) and not the database probe budget above.
   */
  versionProbeTimeoutMs: 10_000,
  /**
   * Supported managed OpenCode range, `>=2.0.15 <2.2.1`.
   *
   * 2.2.0 was adopted on 2026-10-28 after checking the surfaces TBAi uses
   * against the published `@opencode/client@2.2.0` typings and the installed
   * `opencode v2.2.0` binary:
   *
   * - **No route was removed.** The generated client declaration only gained
   *   routes (plugin.gui, generate.image/decisions, voice.models,
   *   mcp.client.token, file.watch/unwatch, experimental.media,
   *   debug.heapDump, usage.limits). The two removed declaration lines are the
   *   type-import line and the old `event.subscribe` signature, which gained
   *   an OPTIONAL type filter and still streams the whole union when called
   *   with no options - the way TBAi calls it.
   * - **No event type was removed.** The `V2Event` union is unchanged.
   * - **The imported types are unchanged**, except two OPTIONAL additions:
   *   `ModelInfo.type?` and `ServerInfo.hostname?`.
   * - **The auth contract is unchanged** (`OPENCODE_PASSWORD` first, then the
   *   legacy `OPENCODE_SERVER_PASSWORD`).
   *
   * **Why the ceiling is 2.2.1 rather than the next minor.** A ceiling one
   * version past the audited release admits exactly 2.2.0. TBAi calls these
   * routes by name and reads the event union, so each newer release has to be
   * checked against the same list before it is admitted; `<2.3.0` would
   * silently authorize 2.2.1 and everything after it.
   *
   * The lower half is unchanged: 2.0.15 through 2.1.x remain supported. That
   * direction was checked when 2.1 landed - the 2.1.2 client against a real
   * 2.0.22 server passes the same real-server suites. The 2.1.x audit trail
   * (declared 404s, branded id aliases) is in `docs/decisions.md`.
   */
  minimumVersion: "2.0.15",
  maximumVersionExclusive: "2.2.1",
  /** Default HTTP Basic username expected by OpenCode V2. */
  authUsername: "opencode",
  /**
   * Optional explicit password override; generated credentials are process-local.
   *
   * MEASURED AGAINST opencode 2.0.22, both by reading the binary's own source
   * and by spawning it: the server reads `OPENCODE_PASSWORD` FIRST and only
   * falls back to `OPENCODE_SERVER_PASSWORD`. Both names work on their own;
   * when both are set the current name wins. With neither set the server
   * generates an unrecoverable random password and answers 401 to everything,
   * including its own readiness probe.
   *
   * So the failure is never "the wrong name is unread" - it is the two sides
   * disagreeing. `createChild` inherits `...process.env`, so when TBAi runs
   * inside a process that already exports `OPENCODE_PASSWORD` (another OpenCode
   * server, a terminal it spawned, a test runner), the child inherits THAT
   * value while TBAi's client sends its own generated one. The managed server
   * then 401s every request and can never become ready.
   *
   * The credential is therefore sent under BOTH names so the server cannot
   * read a different one than the client sends, and the current name is read
   * first when honouring an operator override.
   */
  authPasswordEnvVar: "OPENCODE_PASSWORD",
  /** Legacy in-range name, still honoured as an override source. */
  authPasswordLegacyEnvVar: "OPENCODE_SERVER_PASSWORD",
  /** Both names are set to one value so server and client can never disagree. */
  authPasswordChildEnvVars: ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"] as const,
  /** Graceful shutdown window before SIGKILL. */
  shutdownTimeoutMs: 5_000,
  /** Consecutive unexpected-exit restarts before giving up. */
  maxRestartAttempts: 3,
  /** Max bytes of child stdout/stderr retained per stream for exit diagnostics. */
  diagnosticTailBytes: 4_096,
  /** Neutral working directory for the shared server process (never a user workspace). */
  serverHomeDir: path.join(DATA_DIR, "opencode-home"),
  /** User-facing error when the `opencode` binary cannot be found on PATH. */
  binaryMissingError:
    "OpenCode CLI not found. Set OPENCODE_BINARY to an OpenCode 2.0.15–2.2.0 executable or install `opencode` on PATH, then reload.",
} as const;

export type OpenCodeConfig = {
  readonly binaryName: string;
  readonly binaryEnvVar: string;
  readonly proxyPathPrefix: string;
  readonly startupTimeoutMs: number;
  readonly readyPollMs: number;
  readonly readinessProbePath: string;
  readonly databasePathTimeoutMs: number;
  readonly versionProbeTimeoutMs: number;
  readonly minimumVersion: string;
  readonly maximumVersionExclusive: string;
  readonly authUsername: string;
  readonly authPasswordEnvVar: string;
  readonly authPasswordLegacyEnvVar: string;
  readonly authPasswordChildEnvVars: readonly string[];
  readonly shutdownTimeoutMs: number;
  readonly maxRestartAttempts: number;
  readonly diagnosticTailBytes: number;
  readonly serverHomeDir: string;
  readonly binaryMissingError: string;
};
