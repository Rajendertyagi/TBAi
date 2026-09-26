import { spawn, type Subprocess } from "bun";
import fs from "fs";
import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";
import { getOpenCodeAuthHeaders, getOpenCodeAuthMetadata, getOpenCodeAuthPassword, isSupportedOpenCodeVersion, resolveAndValidateManagedBinary } from "./runtime";
export { OpenCodeBinaryMissingError } from "./runtime";
import { logger } from "../../lib/logger";

/** Appends a chunk to a bounded tail buffer, keeping only the last `maxBytes`. Pure. */
export function appendTail(tail: string, chunk: string, maxBytes: number): string {
  const next = tail + chunk;
  return next.length <= maxBytes ? next : next.slice(next.length - maxBytes);
}

/** Builds the argv for `opencode serve` on the given port. Pure. */
export function buildOpenCodeServeArgs(port: number, binary: string = OPENCODE_CONFIG.binaryName): string[] {
  return [binary, "serve", "--port", String(port)];
}

/** Allocates a free loopback port by binding :0 and releasing it. */
export function allocateLoopbackPort(): number {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(null, { status: 204 }),
  });
  const port = server.port;
  server.stop(true);
  if (!port) throw new Error("Failed to allocate a loopback port");
  return port;
}

/** Strips the proxy prefix from an inbound path, normalizing to "/". Pure. */
export function stripOpenCodeProxyPrefix(pathname: string): string {
  const prefix = OPENCODE_CONFIG.proxyPathPrefix;
  if (!pathname.startsWith(prefix)) return pathname;
  const rest = pathname.slice(prefix.length);
  return rest === "" ? "/" : rest;
}

/** Thrown when the managed process exits before the server becomes ready. */
export class OpenCodeProcessExitedError extends Error {
  constructor(public readonly exitCode: number) {
    super(`OpenCode server process exited before becoming ready (code ${exitCode})`);
    this.name = "OpenCodeProcessExitedError";
  }
}

/** Thrown when the server does not become reachable within the budget. */
export class OpenCodeReadinessTimeoutError extends Error {
  constructor(timeoutMs: number, port: number | null) {
    super(
      `OpenCode server did not become ready within ${timeoutMs}ms (port ${port ?? "unknown"})`,
    );
    this.name = "OpenCodeReadinessTimeoutError";
  }
}

/** Thrown when readiness is cancelled during shutdown. */
export class OpenCodeReadinessCancelledError extends Error {
  constructor() {
    super("OpenCode server readiness cancelled during shutdown");
    this.name = "OpenCodeReadinessCancelledError";
  }
}

/**
 * Resolves the `opencode` binary via PATH. Null when not installed.
 * The resolver is injectable so tests can supply fakes; production always
 * uses the default (`Bun.which`). Pure query otherwise.
 */
export function findOpenCodeBinary(
  which: (name: string) => string | null = Bun.which,
): string | null {
  return which(OPENCODE_CONFIG.binaryName);
}

/** One authenticated OpenCode V2 readiness probe. */
export async function probeOpenCodeInfo(
  baseUrl: string,
  path: string,
  timeoutMs: number,
  authHeaders: Record<string, string>,
  isSupportedVersion: (version: string) => boolean,
): Promise<"ready" | "not_ready"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders },
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status !== 200) return "not_ready";
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== "object") return "not_ready";
    const version = Reflect.get(payload, "version");
    return typeof version === "string" && isSupportedVersion(version) ? "ready" : "not_ready";
  } catch {
    return "not_ready";
  } finally {
    clearTimeout(timer);
  }
}

export interface ReadinessDeps {
  baseUrl: string;
  port: number | null;
  probePath: string;
  authHeaders: Record<string, string>;
  isSupportedVersion: (version: string) => boolean;
  timeoutMs: number;
  pollMs: number;
  getStopping: () => boolean;
  /** Resolves with the process exit code, or rejects with OpenCodeProcessExitedError. */
  exited: Promise<number>;
}

/**
 * Polls the managed server until it is actually reachable over HTTP. This is
 * the authoritative readiness gate: a spawned process is NOT assumed ready.
 * Races the probe loop against process exit and shutdown cancellation, and
 * fails clearly (distinct error types) on each failure mode. Bounded by
 * `timeoutMs` with short `pollMs` intervals.
 */
export async function waitForHttpReady(deps: ReadinessDeps): Promise<void> {
  const { baseUrl, port, probePath, authHeaders, isSupportedVersion, timeoutMs, pollMs, getStopping, exited } = deps;
  const startMs = Date.now();
  const probeTimeout = Math.min(pollMs * 4, timeoutMs);
  let attempt = 0;

  // Process exit must fail readiness immediately, not leave a dangling loop.
  const exitRejection = exited.then((code) => {
    throw new OpenCodeProcessExitedError(code ?? -1);
  });

  while (true) {
    const elapsed = Date.now() - startMs;
    if (getStopping()) {
      logger.error("opencode", "readiness.cancelled", {
        elapsedMs: elapsed,
        attempts: attempt,
      });
      throw new OpenCodeReadinessCancelledError();
    }
    if (elapsed >= timeoutMs) {
      logger.error("opencode", "readiness.timeout", {
        elapsedMs: elapsed,
        attempts: attempt,
        port,
      });
      throw new OpenCodeReadinessTimeoutError(timeoutMs, port);
    }

    attempt++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interval = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, pollMs);
    });

    const outcome = await Promise.race([
      probeOpenCodeInfo(
        baseUrl,
        probePath,
        probeTimeout,
        authHeaders,
        isSupportedVersion,
      ).then((r) => ({ kind: "probe" as const, r })),
      exitRejection,
    ]).catch((err: unknown) => {
      // A process exit must fail readiness immediately — never wait out the
      // interval before surfacing it.
      clearTimeout(timer);
      throw err;
    });

    if (outcome.r === "ready") {
      clearTimeout(timer);
      logger.info("opencode", "readiness.ready", {
        elapsedMs: elapsed,
        attempts: attempt,
        port,
      });
      return;
    }
    if (attempt === 1 || attempt % 10 === 0) {
      logger.debug("opencode", "readiness.probe", {
        attempt,
        elapsedMs: elapsed,
        outcome: "not_listening",
        port,
      });
    }

    // Pace the loop. A probe that fails fast (connection refused) resolves
    // immediately, and re-probing at once spins thousands of times per second:
    // that burns CPU and exhausts the logger's per-scope budget, which then
    // hides the readiness outcome itself. Awaiting the interval the probe raced
    // against guarantees at least `pollMs` between attempts; when the interval
    // already elapsed this resolves immediately, so a slow probe is never
    // delayed twice.
    await interval;
  }
}

/**
 * Owns the single managed `opencode serve` child process. Starts lazily on
 * first request, supervises it (auto-restart on unexpected exit, bounded),
 * and stops it gracefully on shutdown.
 *
 * Readiness is gated on an actual HTTP probe (see `waitForHttpReady`), so the
 * base URL is only ever returned once the server is reachable — never merely
 * spawned.
 */
export class OpenCodeServerManager {
  private child: Subprocess | null = null;
  private port: number | null = null;
  private readyPromise: Promise<string> | null = null;
  private stopping = false;
  private restartAttempts = 0;
  /** Bounded stdout/stderr tails per child, retained for exit diagnostics. */
  private childDiagnostics = new WeakMap<Subprocess, { stdout: string; stderr: string }>();

  constructor(private readonly config: OpenCodeConfig = OPENCODE_CONFIG) {}

  /** Returns the base URL of a running, ready server, starting one if needed. */
  async ensureBaseUrl(): Promise<string> {
    // Single in-flight startup/readiness operation: every caller (concurrent or
    // repeated) shares this promise, so we never spawn multiple servers or run
    // independent readiness loops. An already-ready server has a resolved
    // promise, so this returns instantly without re-probing.
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.start();
    return this.readyPromise;
  }

  private baseUrlFor(port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  /** Resolves and validates the managed V2 binary; overridable in tests. */
  protected resolveBinary(): string {
    return resolveAndValidateManagedBinary(this.config).path;
  }

  /** Spawns the child process for the given port. Extracted for test seams. */
  protected createChild(port: number, binaryPath: string = OPENCODE_CONFIG.binaryName): Subprocess {
    return spawn(buildOpenCodeServeArgs(port, binaryPath), {
      cwd: this.config.serverHomeDir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: getOpenCodeAuthPassword(this.config),
      },
      detached: process.platform !== "win32",
    });
  }

  private async start(): Promise<string> {
    if (this.stopping) throw new Error("OpenCode server is shutting down");
    // Preflight before spawning: a missing or unsupported binary must surface
    // as an actionable error, never as a spawn failure deep in startup.
    const binary = this.resolveBinary();
    fs.mkdirSync(this.config.serverHomeDir, { recursive: true });
    const port = allocateLoopbackPort();
    const child = this.createChild(port, binary);
    this.child = child;
    this.port = port;
    // Drain the child's pipes so a verbose server can never block on a full
    // stdout/stderr buffer. The readiness gate is the HTTP probe, not the log.
    this.drainStreams(child);
    child.exited
      .then((code) => this.onExit(child, code ?? -1))
      .catch(() => undefined);

    const baseUrl = this.baseUrlFor(port);
    logger.info("opencode", "readiness.start", {
      port,
      pid: child.pid,
      reused: false,
      baseUrl,
      managedMode: getOpenCodeAuthMetadata(this.config).source,
    });

    try {
      await waitForHttpReady({
        baseUrl,
        port,
        probePath: this.config.readinessProbePath,
        authHeaders: getOpenCodeAuthHeaders(this.config),
        isSupportedVersion: (version) => isSupportedOpenCodeVersion(version, this.config),
        timeoutMs: this.config.startupTimeoutMs,
        pollMs: this.config.readyPollMs,
        getStopping: () => this.stopping,
        exited: child.exited,
      });
    } catch (err) {
      // Only clear state we own. A restart may already have replaced this.child
      // with a newer attempt (the child exited during readiness); never clobber it.
      if (this.child === child) {
        this.child = null;
        this.port = null;
        this.readyPromise = null;
      }
      // A readiness timeout leaves a live child untracked; kill it so a
      // slow-starting server can never become an orphan. The other failure
      // modes already have the child exiting (OpenCodeProcessExitedError) or
      // being terminated by shutdown() (OpenCodeReadinessCancelledError).
      if (err instanceof OpenCodeReadinessTimeoutError && !this.stopping) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }
      throw err;
    }
    // A successful start resets the restart budget: only consecutive failed
    // restarts count toward maxRestartAttempts.
    this.restartAttempts = 0;
    logger.info("opencode", "opencode.spawn", { port, pid: child.pid });
    return baseUrl;
  }

  /** Reads child stdout/stderr into a bounded tail buffer (never blocks the pipe). */
  private drainStreams(child: Subprocess): void {
    const record = { stdout: "", stderr: "" };
    this.childDiagnostics.set(child, record);
    const drain = (stream: unknown, key: "stdout" | "stderr"): void => {
      if (!stream || typeof stream === "number") return;
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (text) {
              record[key] = appendTail(record[key], text, this.config.diagnosticTailBytes);
            }
          }
        } catch {
          /* stream closed */
        }
      })();
    };
    drain(child.stdout, "stdout");
    drain(child.stderr, "stderr");
  }

  /** Bounded stdout/stderr tail captured for a child (diagnostics seam). */
  protected diagnosticsFor(
    child: Subprocess,
  ): { stdout: string; stderr: string } | undefined {
    return this.childDiagnostics.get(child);
  }

  private async onExit(child: Subprocess, code: number): Promise<void> {
    if (this.stopping || this.port === null) return;
    const port = this.port;
    const tails = this.diagnosticsFor(child);
    logger.warn("opencode", "opencode.unexpected_exit", {
      code,
      pid: child.pid,
      port,
      attempt: this.restartAttempts + 1,
      maxAttempts: this.config.maxRestartAttempts,
      stderrTail: tails?.stderr ?? "",
      stdoutTail: tails?.stdout ?? "",
    });
    this.child = null;
    this.port = null;
    this.readyPromise = null;
    if (this.restartAttempts < this.config.maxRestartAttempts) {
      this.restartAttempts += 1;
      logger.info("opencode", "opencode.restart", {
        attempt: this.restartAttempts,
        maxAttempts: this.config.maxRestartAttempts,
        port,
      });
      try {
        await this.ensureBaseUrl();
      } catch (err) {
        // Shutdown may have intervened mid-restart; that is not a restart failure.
        if (this.stopping) return;
        logger.error("opencode", "opencode.restart_failed", {
          message: err instanceof Error ? err.message : String(err),
          attempt: this.restartAttempts,
          maxAttempts: this.config.maxRestartAttempts,
          port,
        });
      }
    }
  }

  /** Stops the server gracefully (SIGTERM, then SIGKILL after the timeout). */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), this.config.shutdownTimeoutMs),
    );
    const exited = child.exited.then(() => true).catch(() => false);
    if (!(await Promise.race([exited, timeout]))) {
      child.kill("SIGKILL");
    }
    this.child = null;
    this.port = null;
    this.readyPromise = null;
  }
}

/** Shared singleton used by the route layer and session service. */
export const openCodeServerManager = new OpenCodeServerManager();
