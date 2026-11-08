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
  /**
   * Address the managed child must bind to. Measured across every build in the
   * matrix documented on `minimumVersion` below: `--hostname 127.0.0.1` binds
   * only the loopback interface, so the managed HTTP server is never exposed on
   * a LAN or external interface even when the machine has one.
   */
  managedBindHostname: "127.0.0.1",
  /**
   * The `--port` value that asks the kernel for a free ephemeral port.
   *
   * Kernel assignment removes the allocate-then-release race: the child binds
   * the port itself and reports the address it actually got. Measured across
   * every build in the matrix on `minimumVersion`: `--port 0` binds a free
   * loopback port and prints `server listening on http://127.0.0.1:<port>`.
   */
  kernelAssignedPort: "0",
  /**
   * Phrase the managed child prints immediately before the URL it is listening
   * on. Measured identical across every build in the `minimumVersion` matrix:
   * `server listening on http://127.0.0.1:<port>`.
   */
  listeningAnnouncementPrefix: "server listening on",
  /**
   * Bound for one pending stdout line inspected for that announcement. A line
   * longer than this is not an announcement and is dropped rather than split,
   * so a secret printed inside it is never retained as a truncated fragment.
   */
  listeningLineMaxBytes: 4_096,
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
   * Budget for one `GET /api/config` read against the installed service.
   *
   * The read is loopback HTTP plus small local file reads, so a slower answer
   * means the service is not answering rather than that the document is large.
   * The bound is applied through the captured transport's signal, so a read
   * that outlives it is ABORTED rather than left pending behind a browser
   * request that has already gone away.
   */
  configReadTimeoutMs: 10_000,
  /**
   * Authoritative minimum OpenCode version supported by TBAi.
   *
   * Approved compatibility policy: OpenCode 2.2.0 and newer stable releases only.
   * Releases below 2.2.0, prereleases, and malformed versions are rejected.
   * There is no upper version limit for stable releases.
   */
  minimumVersion: "2.2.0",
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
  /** Explicit adopted server endpoint URL override (e.g. "http://127.0.0.1:56873"). */
  serverUrlEnvVar: "OPENCODE_URL",
  /** Explicit adopted server host override. */
  serverHostEnvVar: "OPENCODE_HOST",
  /** Explicit adopted server port override. */
  serverPortEnvVar: "OPENCODE_PORT",
  /** Graceful shutdown window before SIGKILL. */
  shutdownTimeoutMs: 5_000,
  /**
   * Budget for reading and parsing one registration record (§2.4.1). Local file
   * I/O against a record of a few hundred bytes; a slower read would not yield
   * an adoptable candidate within the client's own probe default.
   */
  registrationReadTimeoutMs: 2_000,
  /**
   * Maximum registration size, applied to the **bytes actually read** from the
   * opened handle (§2.4). A record is hundreds of bytes; 64 KiB refuses a
   * non-record without rejecting legitimate formatting and bounds the
   * synchronous parse.
   */
  registrationFileMaxBytes: 65_536,
  /** Directory under the state root that holds the registration record (§2.2). */
  registrationStateDirName: "opencode",
  /** Environment variable that relocates the state root (the client's own fallback). */
  registrationStateHomeEnvVar: "XDG_STATE_HOME",
  /** State root relative to the home directory when the variable is unset. */
  registrationFallbackStateSegments: [".local", "state"] as const,
  /**
   * Released channels share this filename, in the client's own `filename()`
   * selection (`latest`, `beta`, `next`). TBAi adds no beta-specific search.
   */
  registrationDefaultFilename: "service.json",
  /** Prefix for a channel that maps to its own file (`service-<channel>.json`). */
  registrationChannelFilenamePrefix: "service-",
  /** One loopback probe against an already-running adopted service (§6.5). */
  discoveryProbeTimeoutMs: 5_000,
  /** Revalidation cadence for an adopted service, to detect a lost service. */
  adoptionRevalidateIntervalMs: 30_000,
  /**
   * Bounded probes that must ALL fail to reach the adopted service before its
   * loss is CONFIRMED (§1.5.1 row 6). One failure is a transient network
   * condition and preserves a working target; a confirmed loss clears it and
   * falls back to the managed service (D3). Policy, not a measurement: the
   * number only has to be defensible as "more than a single blip".
   */
  adoptedLossConfirmAttempts: 2,
  /** Pause between those confirming probes. */
  adoptedLossRetryDelayMs: 250,
  /**
   * Time between SIGTERM and the SIGKILL decision for a managed child stop.
   * Part of the shared stop completion's worst case (§1.9.3.2, §6.5).
   */
  opencodeChildStopGraceMs: 5_000,
  /**
   * Time allowed after SIGKILL before the per-child stop resolves
   * `{ok:false, reason:"termination_unconfirmed"}`. It bounds the wait and
   * explicitly does not claim the process is gone (§6.5).
   */
  opencodeChildStopKillMs: 5_000,
  /** Consecutive unexpected-exit restarts before giving up. */
  maxRestartAttempts: 3,
  /** Time a managed process must run continuously after readiness to reset the restart budget. */
  stabilityPeriodMs: 5_000,
  /** Max bytes of child stdout/stderr retained per stream for exit diagnostics. */
  diagnosticTailBytes: 4_096,
  /** Neutral working directory for the shared server process (never a user workspace). */
  serverHomeDir: path.join(DATA_DIR, "opencode-home"),
  /** User-facing error when the `opencode` binary cannot be found on PATH. */
  binaryMissingError:
    "OpenCode CLI not found. Set OPENCODE_BINARY to an OpenCode 2.2.0 or newer stable executable or install `opencode` on PATH, then reload.",
} as const;

export type OpenCodeConfig = {
  readonly binaryName: string;
  readonly binaryEnvVar: string;
  readonly proxyPathPrefix: string;
  readonly startupTimeoutMs: number;
  readonly readyPollMs: number;
  readonly managedBindHostname: string;
  readonly kernelAssignedPort: string;
  readonly listeningAnnouncementPrefix: string;
  readonly listeningLineMaxBytes: number;
  readonly readinessProbePath: string;
  readonly databasePathTimeoutMs: number;
  readonly versionProbeTimeoutMs: number;
  readonly configReadTimeoutMs: number;
  readonly minimumVersion: string;
  readonly authUsername: string;
  readonly authPasswordEnvVar: string;
  readonly authPasswordLegacyEnvVar: string;
  readonly authPasswordChildEnvVars: readonly string[];
  readonly serverUrlEnvVar: string;
  readonly serverHostEnvVar: string;
  readonly serverPortEnvVar: string;
  readonly shutdownTimeoutMs: number;
  readonly registrationReadTimeoutMs: number;
  readonly registrationFileMaxBytes: number;
  readonly registrationStateDirName: string;
  readonly registrationStateHomeEnvVar: string;
  readonly registrationFallbackStateSegments: readonly string[];
  readonly registrationDefaultFilename: string;
  readonly registrationChannelFilenamePrefix: string;
  readonly discoveryProbeTimeoutMs: number;
  readonly adoptionRevalidateIntervalMs: number;
  readonly adoptedLossConfirmAttempts: number;
  readonly adoptedLossRetryDelayMs: number;
  readonly opencodeChildStopGraceMs: number;
  readonly opencodeChildStopKillMs: number;
  readonly maxRestartAttempts: number;
  readonly stabilityPeriodMs: number;
  readonly diagnosticTailBytes: number;
  readonly serverHomeDir: string;
  readonly binaryMissingError: string;
};
