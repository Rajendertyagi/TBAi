/**
 * G2: observe the origin the DEVELOPMENT WebView actually runs with, through
 * the WebView's own DevTools protocol.
 *
 * ## Why the configuration is not the evidence
 *
 * `build.devUrl` in `src-tauri/tauri.conf.json` is an INPUT. A recorded
 * `devUrl` proves what the app was asked to load, not what the window loaded,
 * and the difference is the whole question: if the window is showing an error
 * page or a different port, `devUrl` would still read `http://localhost:3000`.
 * So the configured value is recorded separately, labelled as configuration,
 * and the observation comes from the running page:
 *
 *   1. `build`           — the bundle `bun run dev` serves is built and stamped;
 *   2. `dev-start`       — `tauri dev` is started with WebView2 remote debugging,
 *                          declared on the window through a `--config` overlay
 *                          because Tauri passes wry's own browser arguments and
 *                          WebView2 then ignores its environment variable;
 *   3. `cdp-unavailable` — `http://127.0.0.1:<port>/json/list` answers;
 *   4. `target-list`     — a `page` target on the configured origin exists;
 *   5. `evaluate`        — `Runtime.evaluate` returns `location.origin`, `href`, `title`;
 *   6. `probe-api`       — `await fetch('/api/server/instance')` runs IN the page.
 *
 * `Runtime.evaluate` is sent with `awaitPromise: true`, because the fetch probe
 * is a promise; without it the protocol would return the promise object and the
 * result would look like an empty object rather than an answer.
 *
 * ## The step is never substituted
 *
 * If CDP cannot be reached, the item is recorded as OPEN WITH A RECORDED
 * FAILURE. Reading `devUrl` instead is explicitly forbidden: it is the exact
 * substitution this driver exists to prevent.
 *
 * ## Debugging a failure
 *
 * The dev child's own output goes to a log; its sanitized tail, its opening
 * section and the lines that say whether the Rust build finished and the app
 * started are all in `dev.json`, so a red CI step names the stage instead of
 * leaving a wait to be guessed at. The application log is uploaded sanitized.
 * The data directory is never uploaded.
 *
 * Usage:
 *   bun run observe:dev-origin [--out=<dir>] [--cdp-timeout-ms=<n>]
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFreshWebBuild } from "./lib/web-build";
import {
  allocateFreePort,
  errorMessage,
  sleep,
  stopProcessTree,
  type ProcessStopResult,
} from "./lib/process";
import { sanitizeLogFile, sanitizeLogText } from "./lib/sanitize";
import {
  httpJson,
  originOf,
  sequentialStages,
  tailText,
  writeEvidenceFile,
  type StageResult,
} from "./lib/webview-observation";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_CLI = path.join(REPO_ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
const TAURI_CONF = path.join(REPO_ROOT, "src-tauri", "tauri.conf.json");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "tests", ".artifacts", "origin", "dev");

/** The debug build compiles Rust before the window exists; that is the budget. */
const DEFAULT_CDP_TIMEOUT_MS = 10 * 60_000;
const EVALUATE_TIMEOUT_MS = 30_000;
const POLL_MS = 500;
const LOG_TAIL_CHARS = 8_000;
const LOG_HEAD_CHARS = 4_000;

/**
 * wry passes these itself, and a window that sets `additionalBrowserArgs`
 * replaces them, so they are repeated in the overlay (Tauri's config schema
 * says as much). The debug port is the only addition.
 */
const WEBVIEW2_BASE_ARGS = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/** Lines that say whether the Rust build finished and the app started. */
const LAUNCH_MARKER_PATTERN =
  /Compiling |Finished |Running |error\[|could not compile|VITE v|Local: /;

export const DEV_STAGES = [
  "build",
  "dev-start",
  "cdp-unavailable",
  "target-list",
  "evaluate",
  "probe-api",
] as const;
export type DevStage = (typeof DEV_STAGES)[number];

export interface DevConfiguration {
  readonly devUrl: string | null;
  readonly beforeDevCommand: string | null;
  readonly error: string | null;
}

/** Reads the launch configuration. Its `devUrl` is recorded, never used as evidence. */
export function readDevConfiguration(confPath: string): DevConfiguration {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(confPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") {
      return { devUrl: null, beforeDevCommand: null, error: `${confPath} is not a JSON object` };
    }
    const build = (parsed as Record<string, unknown>).build;
    if (build === null || typeof build !== "object") {
      return { devUrl: null, beforeDevCommand: null, error: `${confPath} has no build section` };
    }
    const record = build as Record<string, unknown>;
    const devUrl = typeof record.devUrl === "string" ? record.devUrl : null;
    return {
      devUrl,
      beforeDevCommand:
        typeof record.beforeDevCommand === "string" ? record.beforeDevCommand : null,
      error: devUrl === null ? `${confPath} declares no build.devUrl` : null,
    };
  } catch (error) {
    return { devUrl: null, beforeDevCommand: null, error: `${confPath}: ${errorMessage(error)}` };
  }
}

/**
 * The `--config` overlay that gives the dev window a remote debugging port.
 *
 * Tauri passes wry's own WebView2 arguments, which makes WebView2 ignore
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, so the port has to be declared on the
 * window itself. The overlay is written for this run only; the app's own
 * configuration is not modified. Pure, so its shape is testable.
 */
export function buildDebugPortOverlay(
  config: unknown,
  debugArgs: string,
): { overlay: Record<string, unknown> | null; error: string | null } {
  const record =
    config !== null && typeof config === "object" ? (config as Record<string, unknown>) : null;
  const app = record?.app;
  const windows =
    app !== null && typeof app === "object" ? (app as Record<string, unknown>).windows : undefined;
  if (!Array.isArray(windows) || windows.length === 0) {
    return {
      overlay: null,
      error: "the configuration declares no app.windows to attach the port to",
    };
  }
  return {
    overlay: {
      app: {
        windows: windows.map((entry) =>
          entry !== null && typeof entry === "object"
            ? { ...(entry as Record<string, unknown>), additionalBrowserArgs: debugArgs }
            : entry,
        ),
      },
    },
    error: null,
  };
}

/** The first `maxChars` characters, so the launch's own output survives a noisy tail. */
export function headText(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n…[${text.length - maxChars} characters omitted]`;
}

/** Build/launch lines from the dev log, so a failed wait is attributable. */
export function selectLaunchMarkers(text: string, limit: number): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && LAUNCH_MARKER_PATTERN.test(line))
    .slice(0, limit);
}

export interface CdpTarget {
  readonly type: string;
  readonly url: string;
  readonly title: string | null;
  readonly webSocketDebuggerUrl: string | null;
}

/** The CDP target list, or null when the payload is not an array. */
export function parseCdpTargets(text: string | null): CdpTarget[] | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const targets: CdpTarget[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    targets.push({
      type: typeof record.type === "string" ? record.type : "",
      url: typeof record.url === "string" ? record.url : "",
      title: typeof record.title === "string" ? record.title : null,
      webSocketDebuggerUrl:
        typeof record.webSocketDebuggerUrl === "string" ? record.webSocketDebuggerUrl : null,
    });
  }
  return targets;
}

/**
 * The page target the development window is showing.
 *
 * Only a `page` whose URL is on `expectedOrigin` counts: `about:blank`, a
 * DevTools page and an error page on another port are all pages, and none of
 * them is the app. `null` means the window is not (yet) on the configured
 * origin, which is a `target-list` failure, not a value to substitute.
 */
export function selectDevTarget(
  targets: readonly CdpTarget[],
  expectedOrigin: string | null,
): CdpTarget | null {
  if (expectedOrigin === null) return null;
  for (const target of targets) {
    if (target.type !== "page") continue;
    if (target.webSocketDebuggerUrl === null) continue;
    if (originOf(target.url) !== expectedOrigin) continue;
    return target;
  }
  return null;
}

/** The `Runtime.evaluate` result, or the reason there is none. */
export function parseEvaluateResponse(message: unknown): { value: unknown; error: string | null } {
  if (message === null || typeof message !== "object") {
    return { value: null, error: "the CDP response is not an object" };
  }
  const record = message as Record<string, unknown>;
  if (record.error !== undefined && record.error !== null) {
    const error = record.error as Record<string, unknown>;
    return {
      value: null,
      error: `CDP rejected the command: ${typeof error.message === "string" ? error.message : JSON.stringify(error)}`,
    };
  }
  const result = record.result;
  if (result === null || typeof result !== "object") {
    return { value: null, error: "the CDP response carries no result" };
  }
  const envelope = result as Record<string, unknown>;
  if (envelope.exceptionDetails !== undefined && envelope.exceptionDetails !== null) {
    const details = envelope.exceptionDetails as Record<string, unknown>;
    const exception = details.exception as Record<string, unknown> | undefined;
    const description =
      exception !== undefined && typeof exception.description === "string"
        ? exception.description
        : typeof details.text === "string"
          ? details.text
          : "the evaluated expression threw";
    return { value: null, error: `the expression threw: ${description}` };
  }
  const inner = envelope.result;
  if (inner === null || typeof inner !== "object") {
    return { value: null, error: "the CDP response carries no value" };
  }
  return { value: (inner as Record<string, unknown>).value ?? null, error: null };
}

/**
 * One `server started` record from the application log.
 *
 * `instanceId` is the backend's own identity (`GET /api/server/instance`
 * returns the same value), which is what makes the record attributable to a
 * process rather than to "the log".
 */
export interface BackendBootRecord {
  readonly instanceId: string;
  readonly port: number | null;
}

/** One `startup_failed` record, with the failure text the backend logged. */
export interface BackendFailureRecord {
  readonly instanceId: string;
  readonly reason: string;
}

/**
 * What the application log says about backend startup, per instance.
 *
 * Several launches can write to ONE `TBAI_LOG_FILE`: the `beforeDevCommand`
 * child inherits it, and so does anything else the launch starts. A reader
 * therefore cannot treat "a `startup_failed` line exists" as "the backend this
 * observation is about failed" — that was a real false positive. Attribution is
 * by instance id, and entries that carry none are kept separately so they are
 * visible instead of silently credited to somebody.
 */
export interface BackendLogAttribution {
  readonly booted: readonly BackendBootRecord[];
  readonly failed: readonly BackendFailureRecord[];
  readonly unattributedFailures: readonly string[];
  /** Lines that are not JSON log entries (a child's plain output, a stack frame). */
  readonly nonLogLines: number;
}

/**
 * Attribute the application log's startup records to the instances that wrote
 * them. Pure, so the attribution rules are testable without a WebView.
 *
 * The logger's file sink writes one JSON object per line; anything else (a
 * child's stderr, a Rust stack trace) is counted, not guessed at.
 */
export function attributeBackendLog(logText: string): BackendLogAttribution {
  const booted: BackendBootRecord[] = [];
  const failed: BackendFailureRecord[] = [];
  const unattributedFailures: string[] = [];
  let nonLogLines = 0;

  for (const line of logText.split(/\r?\n/)) {
    const text = line.trim();
    if (text === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      nonLogLines += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== "object") {
      nonLogLines += 1;
      continue;
    }
    const entry = parsed as Record<string, unknown>;
    if (entry.scope !== "server" || typeof entry.event !== "string") {
      nonLogLines += 1;
      continue;
    }
    const instanceId = typeof entry.instanceId === "string" ? entry.instanceId.trim() : "";
    if (entry.event === "started") {
      if (instanceId === "") {
        // A start with no identity cannot prove ownership of anything.
        nonLogLines += 1;
        continue;
      }
      const port =
        typeof entry.port === "number" && Number.isInteger(entry.port) ? entry.port : null;
      booted.push({ instanceId, port });
      continue;
    }
    if (entry.event === "startup_failed") {
      const reason =
        typeof entry.message === "string" && entry.message.trim() !== ""
          ? entry.message
          : typeof entry.error === "string" && entry.error.trim() !== ""
            ? entry.error
            : "startup_failed (no reason logged)";
      if (instanceId === "") {
        unattributedFailures.push(reason);
        continue;
      }
      failed.push({ instanceId, reason });
    }
  }

  return { booted, failed, unattributedFailures, nonLogLines };
}

/** The port an origin string names, or null when it names none usable. */
export function portOfOrigin(origin: string | null): number | null {
  if (origin === null) return null;
  try {
    const url = new URL(origin);
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * The instance id the in-page API answered with, or null when it answered with
 * none. `null` means the observation has no owner to attribute anything to.
 */
export function instanceIdFromProbe(probe: {
  readonly status: number | null;
  readonly body: string | null;
}): string | null {
  if (probe.status !== 200 || probe.body === null) return null;
  try {
    const parsed: unknown = JSON.parse(probe.body);
    if (parsed === null || typeof parsed !== "object") return null;
    const id = (parsed as Record<string, unknown>).instanceId;
    return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
  } catch {
    return null;
  }
}

export interface DevOriginInput {
  readonly configuredDevUrl: string | null;
  readonly configurationError: string | null;
  readonly build: { readonly ok: boolean; readonly error: string | null };
  readonly dev: {
    readonly spawnError: string | null;
    readonly exitedEarly: boolean;
    readonly exitCode: number | null;
  };
  readonly cdp: { readonly available: boolean; readonly error: string | null };
  readonly target: {
    readonly url: string | null;
    readonly webSocketUrl: string | null;
    readonly seen: readonly string[];
  };
  readonly evaluation: {
    readonly origin: string | null;
    readonly href: string | null;
    readonly title: string | null;
    readonly error: string | null;
  };
  readonly probe: {
    readonly status: number | null;
    readonly body: string | null;
    readonly error: string | null;
  };
  /**
   * Startup records from the application log, attributed per instance.
   *
   * The observation is evidence only when the instance that answered the
   * in-page API is the instance the log records as having started on the
   * configured port. A `startup_failed` written by a DIFFERENT process is
   * reported as a note, never as this run's failure: that misattribution is
   * exactly what made this check a false positive.
   */
  readonly backend: BackendLogAttribution;
}

export interface DevAssessment {
  readonly ok: boolean;
  readonly stage: DevStage | null;
  readonly failures: readonly string[];
  /**
   * Startup failures the log DID record, but not for the instance that served
   * this WebView. They are reported, and they are deliberately not failures of
   * this run: a shared log file must not turn one process's crash into another
   * process's failed evidence.
   */
  readonly notes: readonly string[];
}

/**
 * Every reason the run is not evidence of what it claims, and the first stage
 * that failed. Pure, so the failure matrix is testable without a WebView.
 */
export function assessDevOrigin(input: DevOriginInput): DevAssessment {
  const configuredOrigin = originOf(input.configuredDevUrl);

  const buildFailures: string[] = [];
  if (input.configurationError !== null) buildFailures.push(input.configurationError);
  else if (configuredOrigin === null) {
    buildFailures.push(
      `the configured devUrl is not a usable origin: ${input.configuredDevUrl ?? "(none)"}`,
    );
  }
  if (!input.build.ok) buildFailures.push(input.build.error ?? "the web bundle was not built");

  const devFailures: string[] = [];
  const notes: string[] = [];
  if (input.dev.spawnError !== null)
    devFailures.push(`tauri dev could not be started: ${input.dev.spawnError}`);
  if (input.dev.exitedEarly) {
    devFailures.push(
      `tauri dev exited with ${input.dev.exitCode ?? "no code"} before the observation completed`,
    );
  }

  // Backend startup, attributed per instance. The answering instance is the
  // only process whose start/failure says anything about THIS observation.
  const expectedPort = portOfOrigin(configuredOrigin);
  const observedInstanceId = instanceIdFromProbe(input.probe);
  if (observedInstanceId !== null) {
    const ownFailure = input.backend.failed.find(
      (entry) => entry.instanceId === observedInstanceId,
    );
    const ownBoot = input.backend.booted.find((entry) => entry.instanceId === observedInstanceId);
    if (ownFailure !== undefined) {
      devFailures.push(
        `the development backend (instance ${observedInstanceId}) failed to start: ${ownFailure.reason}`,
      );
    } else if (ownBoot === undefined) {
      const started =
        input.backend.booted.length === 0
          ? "no instance logged a successful start"
          : `instances that started: ${input.backend.booted
              .map((entry) => `${entry.instanceId} on ${entry.port ?? "an unrecorded port"}`)
              .join(", ")}`;
      devFailures.push(
        `the application log records no successful start for instance ${observedInstanceId}, the process that answered GET /api/server/instance (${started}), ` +
          `so the origin and the API cannot be attributed to this launch`,
      );
    } else if (expectedPort !== null && ownBoot.port !== expectedPort) {
      devFailures.push(
        `the development backend (instance ${observedInstanceId}) bound port ${
          ownBoot.port ?? "(unrecorded)"
        }, but the WebView is served from ${expectedPort}`,
      );
    }
    for (const other of input.backend.failed) {
      if (other.instanceId === observedInstanceId) continue;
      notes.push(
        `another process (instance ${other.instanceId}) logged startup_failed; it is not the process serving this WebView: ${other.reason}`,
      );
    }
    for (const reason of input.backend.unattributedFailures) {
      notes.push(`a startup_failed entry carried no instance id: ${reason}`);
    }
  }

  const cdpFailures: string[] = [];
  if (input.cdp.error !== null) cdpFailures.push(input.cdp.error);
  else if (!input.cdp.available) cdpFailures.push("the WebView DevTools endpoint never answered");

  const targetFailures: string[] = [];
  if (input.target.url === null || input.target.webSocketUrl === null) {
    targetFailures.push(
      `no page target on ${configuredOrigin ?? "(no configured origin)"}; targets seen: ${
        input.target.seen.length === 0 ? "(none)" : input.target.seen.join(", ")
      }`,
    );
  }

  const evaluateFailures: string[] = [];
  if (input.evaluation.error !== null) evaluateFailures.push(input.evaluation.error);
  else if (input.evaluation.origin === null) evaluateFailures.push("the page reported no origin");
  else if (configuredOrigin !== null && input.evaluation.origin !== configuredOrigin) {
    evaluateFailures.push(
      `the page's origin is ${input.evaluation.origin}, but the configured devUrl is ${input.configuredDevUrl}`,
    );
  }

  const probeFailures: string[] = [];
  if (input.probe.error !== null) probeFailures.push(input.probe.error);
  else if (input.probe.status !== 200) {
    probeFailures.push(
      `the in-page GET /api/server/instance returned ${input.probe.status ?? "no status"}`,
    );
  } else if (observedInstanceId === null) {
    probeFailures.push(
      `the in-page GET /api/server/instance returned no instanceId: ${JSON.stringify(
        tailText(input.probe.body ?? "", 500),
      )}`,
    );
  }

  const stages: StageResult<DevStage>[] = [
    { stage: "build", failures: buildFailures },
    { stage: "dev-start", failures: devFailures },
    { stage: "cdp-unavailable", failures: cdpFailures },
    { stage: "target-list", failures: targetFailures },
    { stage: "evaluate", failures: evaluateFailures },
    { stage: "probe-api", failures: probeFailures },
  ];
  const summary = sequentialStages(stages);
  return { ok: summary.ok, stage: summary.stage, failures: summary.failures, notes };
}

/**
 * One `Runtime.evaluate` round-trip over the target's DevTools socket.
 *
 * `awaitPromise` is always true so a promise-returning expression is answered,
 * not echoed. Events (messages without our id) are ignored; the first answer
 * with id 1 settles the call, and the socket is closed either way.
 */
function evaluateOverCdp(
  webSocketUrl: string,
  expression: string,
  timeoutMs: number = EVALUATE_TIMEOUT_MS,
): Promise<{ value: unknown; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { value: unknown; error: string | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(
      () =>
        finish({ value: null, error: `the DevTools socket did not answer within ${timeoutMs} ms` }),
      timeoutMs,
    );
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        finish({ value: null, error: "the DevTools socket sent a non-text frame" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        finish({ value: null, error: "the DevTools socket sent an unreadable frame" });
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>).id !== 1
      ) {
        return; // a protocol event, not the answer
      }
      finish(parseEvaluateResponse(parsed));
    };
    socket.onerror = () => finish({ value: null, error: "the DevTools socket reported an error" });
    socket.onclose = () =>
      finish({ value: null, error: "the DevTools socket closed before answering" });
  });
}

interface DevOptions {
  readonly outDir: string;
  readonly cdpTimeoutMs: number;
}

function parseArgs(argv: readonly string[]): DevOptions | null {
  let outDir = DEFAULT_OUT_DIR;
  let cdpTimeoutMs = DEFAULT_CDP_TIMEOUT_MS;
  for (const arg of argv) {
    if (arg.startsWith("--out=")) outDir = path.resolve(arg.slice("--out=".length).trim());
    else if (arg.startsWith("--cdp-timeout-ms=")) {
      const parsed = Number.parseInt(arg.slice("--cdp-timeout-ms=".length).trim(), 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        console.error("[g2] --cdp-timeout-ms= must be a positive integer");
        return null;
      }
      cdpTimeoutMs = parsed;
    } else {
      console.error(`[g2] unknown argument: ${arg}`);
      return null;
    }
  }
  if (outDir.length === 0) {
    console.error("[g2] --out= must not be empty");
    return null;
  }
  return { outDir, cdpTimeoutMs };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: bun run observe:dev-origin [--out=<dir>] [--cdp-timeout-ms=<n>]");
    return 0;
  }
  const options = parseArgs(argv);
  if (!options) return 1;

  const runId = `${new Date().toISOString()}-${os.hostname()}`;
  const evidencePath = path.join(options.outDir, "dev.json");
  fs.rmSync(evidencePath, { force: true });

  const configuration = readDevConfiguration(TAURI_CONF);
  const configuredOrigin = originOf(configuration.devUrl);

  const build = ensureFreshWebBuild("g2");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-origin-dev-"));
  const dataDir = path.join(tempRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const devLogPath = path.join(tempRoot, "tauri-dev.log");
  const appLogPath = path.join(tempRoot, "tbai.log");

  const dev: { spawnError: string | null; exitedEarly: boolean; exitCode: number | null } = {
    spawnError: null,
    exitedEarly: false,
    exitCode: null,
  };
  const cdp: { available: boolean; error: string | null; port: number | null } = {
    available: false,
    error: null,
    port: null,
  };
  const target: {
    url: string | null;
    webSocketUrl: string | null;
    title: string | null;
    seen: string[];
  } = { url: null, webSocketUrl: null, title: null, seen: [] };
  const evaluation: {
    origin: string | null;
    href: string | null;
    title: string | null;
    error: string | null;
  } = { origin: null, href: null, title: null, error: null };
  const probe: { status: number | null; body: string | null; error: string | null } = {
    status: null,
    body: null,
    error: null,
  };
  let devChild: ChildProcess | null = null;
  let logFd: number | null = null;
  let stoppingForTeardown = false;
  let portEnv: string | null = null;
  let debugArgs: string | null = null;
  let overlayWritten = false;
  let cdpAttempts = 0;
  let lastPollError: string | null = null;
  let devStop: ProcessStopResult = {
    attempted: false,
    method: null,
    descendants: [],
    survivors: [],
    confirmed: true,
    errors: [],
  };
  const teardownErrors: string[] = [];

  try {
    if (!build.ok) {
      // Nothing to observe: the dev server serves this bundle, so an unbuilt
      // bundle would make every later stage measure the wrong thing.
    } else if (!fs.existsSync(TAURI_CLI)) {
      cdp.error = `the Tauri CLI is missing at ${TAURI_CLI}; run bun install`;
    } else {
      cdp.port = await allocateFreePort();
      debugArgs = `--remote-debugging-port=${cdp.port} ${WEBVIEW2_BASE_ARGS}`;
      const overlayPath = path.join(tempRoot, "dev-overlay.json");
      const overlay = buildDebugPortOverlay(
        JSON.parse(fs.readFileSync(TAURI_CONF, "utf8")),
        debugArgs,
      );
      if (overlay.overlay === null) {
        cdp.error = `${overlay.error} (${TAURI_CONF})`;
      }
      if (overlay.overlay !== null) {
        fs.writeFileSync(overlayPath, JSON.stringify(overlay.overlay, null, 2));
        overlayWritten = true;
      }
      portEnv = configuredOrigin === null ? null : new URL(configuredOrigin).port || null;
      logFd = fs.openSync(devLogPath, "a");
      devChild = overlayWritten
        ? spawn(process.execPath, [TAURI_CLI, "dev", "--no-watch", "--config", overlayPath], {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              DATA_DIR: dataDir,
              TBAI_LOG_FILE: appLogPath,
              // The backend `beforeDevCommand` starts must bind the port
              // devUrl names. Left to self-heal it would scan upward while
              // the window kept loading the configured port, and the page
              // could then be an error page that still reports the expected
              // origin.
              ...(portEnv === null ? {} : { PORT: portEnv }),
            },
            stdio: ["ignore", logFd, logFd],
            windowsHide: true,
          })
        : null;
      devChild?.on("error", (error) => {
        dev.spawnError = errorMessage(error);
      });
      devChild?.on("exit", (code) => {
        if (stoppingForTeardown) return;
        dev.exitedEarly = true;
        dev.exitCode = code;
      });

      const deadline = Date.now() + options.cdpTimeoutMs;
      for (;;) {
        // Nothing was launched: `cdp.error` already says why, and polling an
        // endpoint that cannot exist would only replace that reason.
        if (devChild === null) break;
        cdpAttempts += 1;
        const listing = await httpJson(`http://127.0.0.1:${cdp.port}/json/list`, {
          timeoutMs: 5_000,
        });
        lastPollError = listing.error;
        if (listing.status !== null) {
          cdp.available = true;
          const targets = parseCdpTargets(listing.text);
          if (targets === null) {
            // Answered, but with something that is not a target list.
            cdp.error = `the DevTools endpoint returned no target list: ${tailText(listing.text ?? "", 300)}`;
            break;
          }
          target.seen = targets.map((entry) => `${entry.type} ${entry.url}`).slice(0, 20);
          const selected = selectDevTarget(targets, configuredOrigin);
          if (selected !== null) {
            target.url = selected.url;
            target.webSocketUrl = selected.webSocketDebuggerUrl;
            target.title = selected.title;
            break;
          }
        }
        if (dev.exitedEarly || dev.spawnError !== null) break;
        if (Date.now() > deadline) {
          cdp.error =
            `no page target appeared on ${configuredOrigin ?? "(configured origin)"} within ${options.cdpTimeoutMs} ms` +
            ` (${cdpAttempts} probes; last: ${lastPollError ?? "no error recorded"})`;
          break;
        }
        await sleep(POLL_MS);
      }

      if (target.webSocketUrl !== null) {
        const originResult = await evaluateOverCdp(
          target.webSocketUrl,
          "({ origin: window.location.origin, href: window.location.href, title: document.title })",
        );
        evaluation.error = originResult.error;
        if (originResult.value !== null && typeof originResult.value === "object") {
          const record = originResult.value as Record<string, unknown>;
          evaluation.origin = typeof record.origin === "string" ? record.origin : null;
          evaluation.href = typeof record.href === "string" ? record.href : null;
          evaluation.title = typeof record.title === "string" ? record.title : null;
        }

        const probeResult = await evaluateOverCdp(
          target.webSocketUrl,
          "(async () => { const r = await fetch('/api/server/instance');" +
            " return { status: r.status, body: await r.text() }; })()",
        );
        probe.error = probeResult.error;
        if (probeResult.value !== null && typeof probeResult.value === "object") {
          const record = probeResult.value as Record<string, unknown>;
          probe.status = typeof record.status === "number" ? record.status : null;
          probe.body = typeof record.body === "string" ? record.body : null;
        }
      }
    }
  } catch (error) {
    const message = `the run failed before the observation completed: ${errorMessage(error)}`;
    if (evaluation.origin === null) evaluation.error = evaluation.error ?? message;
    else probe.error = probe.error ?? message;
  }

  // Teardown on every path: the CLI owns cargo, the app, WebView2 and the
  // beforeDevCommand backend, so stopping its tree is the only stop that counts.
  stoppingForTeardown = true;
  if (devChild?.pid !== undefined) {
    try {
      devStop = stopProcessTree(devChild.pid);
      teardownErrors.push(...devStop.errors);
    } catch (error) {
      devStop = {
        attempted: true,
        method: null,
        descendants: [],
        survivors: [],
        confirmed: false,
        errors: [errorMessage(error)],
      };
      teardownErrors.push(`stopping tauri dev failed: ${errorMessage(error)}`);
    }
  }
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch (error) {
      teardownErrors.push(`closing the dev log failed: ${errorMessage(error)}`);
    }
    logFd = null;
  }
  if (devStop.survivors.length > 0) {
    teardownErrors.push(`the dev tree left pid(s) ${devStop.survivors.join(", ")} running`);
  }

  let rawDevLog = "";
  try {
    if (fs.existsSync(devLogPath)) rawDevLog = fs.readFileSync(devLogPath, "utf8");
  } catch (error) {
    teardownErrors.push(`reading the dev log failed: ${errorMessage(error)}`);
  }
  const appLog = sanitizeLogFile(appLogPath, path.join(options.outDir, "tbai.log"));
  // An absent log is normal when the app never booted; only a source that
  // existed and could not be copied is a teardown failure.
  if (appLog.sourceExisted && !appLog.written) {
    teardownErrors.push(`the application log was not uploaded: ${appLog.error}`);
  }

  let tempRootRemoved = false;

  // The application log is read BEFORE the temporary root is removed. Every
  // process that inherits `TBAI_LOG_FILE` writes to it, so the startup records
  // are attributable per instance rather than readable as a bare substring: a
  // failure logged by one process must never be reported as another's. The
  // instance that answered the in-page API is the only one that says anything
  // about this observation.
  let appLogText = "";
  try {
    if (fs.existsSync(appLogPath)) appLogText = fs.readFileSync(appLogPath, "utf8");
  } catch (error) {
    teardownErrors.push(
      `reading the application log for attribution failed: ${errorMessage(error)}`,
    );
  }
  const backend = attributeBackendLog(appLogText);
  const observedInstanceId = instanceIdFromProbe(probe);

  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRootRemoved = !fs.existsSync(tempRoot);
  } catch (error) {
    teardownErrors.push(`removing the temporary root failed: ${errorMessage(error)}`);
  }

  const assessment = assessDevOrigin({
    configuredDevUrl: configuration.devUrl,
    configurationError: configuration.error,
    build,
    dev,
    cdp,
    target: { url: target.url, webSocketUrl: target.webSocketUrl, seen: target.seen },
    evaluation,
    probe,
    backend,
  });

  const failures = [...assessment.failures];
  if (devStop.attempted && !devStop.confirmed) {
    failures.push("teardown: the dev process tree did not terminate");
  }
  if (!tempRootRemoved) failures.push("teardown: the temporary root was not removed");
  for (const error of teardownErrors) failures.push(`teardown: ${error}`);

  const evidence = {
    schemaVersion: 1 as const,
    kind: "dev" as const,
    runId,
    generatedAt: new Date().toISOString(),
    configured: {
      /** Configuration only. NOT evidence of what the window loaded. */
      devUrl: configuration.devUrl,
      devUrlOrigin: configuredOrigin,
      beforeDevCommand: configuration.beforeDevCommand,
      source: TAURI_CONF,
      portForcedIntoDevCommand: portEnv,
    },
    observed: {
      origin: evaluation.origin,
      href: evaluation.href,
      title: evaluation.title,
      targetUrl: target.url,
      targetsSeen: target.seen,
    },
    launch: {
      tauriCli: TAURI_CLI,
      configOverlay: overlayWritten,
      windowAdditionalBrowserArgs: debugArgs,
    },
    cdp: {
      port: cdp.port,
      available: cdp.available,
      error: cdp.error,
      attempts: cdpAttempts,
      lastPollError,
    },
    build,
    probe,
    observations: {
      originMatchesConfigured: evaluation.origin !== null && evaluation.origin === configuredOrigin,
      inPageApiStatus: probe.status,
      /** The instance that answered the in-page API: the owner of this observation. */
      observedInstanceId,
      /**
       * True only when the instance that served this WebView is the instance the
       * log records as having failed to start.
       */
      backendStartupFailed:
        observedInstanceId !== null &&
        backend.failed.some((entry) => entry.instanceId === observedInstanceId),
      /** Every startup record the log holds, attributed to the instance that wrote it. */
      backendStartup: {
        booted: backend.booted,
        failed: backend.failed,
        unattributedFailures: backend.unattributedFailures,
        nonLogLines: backend.nonLogLines,
      },
    },
    assessment: {
      ok: assessment.ok && failures.length === 0,
      stage: assessment.stage,
      failures,
      notes: assessment.notes,
    },
    teardown: { devStop, tempRootRemoved, errors: teardownErrors },
    logs: {
      app: {
        sourceExisted: appLog.sourceExisted,
        written: appLog.written,
        redactions: appLog.redactions,
        truncatedChars: appLog.truncatedChars,
        error: appLog.error,
      },
      /** Sanitized: this file is uploaded too. */
      devTail: sanitizeLogText(tailText(rawDevLog, LOG_TAIL_CHARS)).text,
      /** The launch's opening output, which the tail loses once the backend logs. */
      devHead: sanitizeLogText(headText(rawDevLog, LOG_HEAD_CHARS)).text,
      /** Whether the Rust build finished and the app started, or why it did not. */
      launchMarkers: selectLaunchMarkers(rawDevLog, 30).map(
        (line) => sanitizeLogText(line, 500).text,
      ),
    },
    dataDir,
  };

  const written = writeEvidenceFile(evidencePath, evidence);
  if (!written.written) {
    console.error(`[g2] ${written.error}`);
    return 1;
  }

  const ok = evidence.assessment.ok && written.written;
  console.log(`[g2] ${ok ? "PASS" : "FAIL"} — ${evidencePath}`);
  for (const note of assessment.notes) console.log(`[g2] note: ${note}`);
  if (!ok) {
    console.error(`[g2] stage: ${assessment.stage ?? "(teardown only)"}`);
    for (const failure of failures) console.error(`[g2]   ${failure}`);
  }
  return ok ? 0 : 1;
}

// Guarded so the unit test can import the pure assessment without launching Tauri.
if (import.meta.main) {
  process.exitCode = await main();
}
