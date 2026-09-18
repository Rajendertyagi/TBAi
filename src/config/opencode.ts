import path from "path";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

/**
 * Centralized OpenCode integration configuration. Every value that would
 * otherwise be a magic string/number lives here so it is defined once.
 */
export const OPENCODE_CONFIG = {
  /** Binary invoked to run the managed OpenCode server. */
  binaryName: "opencode",
  /** HTTP path prefix the Hono proxy is mounted at; stripped before forwarding. */
  proxyPathPrefix: "/api/opencode",
  /** Max time to wait for readiness before failing startup. */
  startupTimeoutMs: 30_000,
  /** Interval between HTTP readiness probes while the managed server starts. */
  readyPollMs: 250,
  /**
   * Lightweight endpoint used to confirm the server is listening.
   *
   * The official V2 readiness call is `server.status()` → `GET /api/status`,
   * but that route does not exist on any released OpenCode server (1.18.x
   * answers its SPA fallback: HTTP 200 + `text/html`, which the client rejects
   * as `UnsupportedContentType`). `@opencode/client@2.0.4` targets an OpenCode
   * 2.x server; the newest release is 1.18.31.
   *
   * `GET /api/health` is the smallest transport-level check that is both
   * V2-named and present: it is registered on 1.18.x and answers
   * `{ healthy: true }`. The probe only cares that the port accepts
   * connections, so it stays status-agnostic — see `probeOnce` in
   * `serverManager.ts`.
   */
  readinessProbePath: "/api/health",
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
    "OpenCode CLI not found. Install it (https://opencode.ai) and ensure `opencode` is on PATH, then reload.",
} as const;

export type OpenCodeConfig = {
  readonly binaryName: string;
  readonly proxyPathPrefix: string;
  readonly startupTimeoutMs: number;
  readonly readyPollMs: number;
  readonly readinessProbePath: string;
  readonly shutdownTimeoutMs: number;
  readonly maxRestartAttempts: number;
  readonly diagnosticTailBytes: number;
  readonly serverHomeDir: string;
  readonly binaryMissingError: string;
};
