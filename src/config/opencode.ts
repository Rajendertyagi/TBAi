import path from "path";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

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
  /** Inclusive managed OpenCode version range. */
  minimumVersion: "2.0.15",
  maximumVersionExclusive: "2.1.0",
  /** Default HTTP Basic username expected by OpenCode V2. */
  authUsername: "opencode",
  /** Optional explicit password override; generated credentials are process-local. */
  authPasswordEnvVar: "OPENCODE_SERVER_PASSWORD",
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
    "OpenCode CLI not found. Set OPENCODE_BINARY to an OpenCode 2.0.15–2.0.x executable or install `opencode` on PATH, then reload.",
} as const;

export type OpenCodeConfig = {
  readonly binaryName: string;
  readonly binaryEnvVar: string;
  readonly proxyPathPrefix: string;
  readonly startupTimeoutMs: number;
  readonly readyPollMs: number;
  readonly readinessProbePath: string;
  readonly minimumVersion: string;
  readonly maximumVersionExclusive: string;
  readonly authUsername: string;
  readonly authPasswordEnvVar: string;
  readonly shutdownTimeoutMs: number;
  readonly maxRestartAttempts: number;
  readonly diagnosticTailBytes: number;
  readonly serverHomeDir: string;
  readonly binaryMissingError: string;
};
