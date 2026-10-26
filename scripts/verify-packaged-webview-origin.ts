/**
 * G1: read the origin the PACKAGED Tauri WebView actually runs with, and prove
 * the app's own API is readable from that origin.
 *
 * ## What was missing
 *
 * The `tauri` CI job already builds the real packaged app, starts it, and reads
 * `/api/server/instance` — but every one of those requests comes from the test
 * process on `127.0.0.1`. It therefore proves the packaged SERVER runs; it does
 * not observe the WebView's origin, and it does not prove the WebView can read a
 * response from the API across the custom-protocol boundary. `http://app.localhost`
 * is Tauri's documented Windows form for a custom `app` protocol page
 * (`docs/architecture.md`, "Windows WebView2 produces the origin
 * `http://app.localhost`"), and the CORS policy is pinned by a unit test — but
 * neither is an observation of the running app.
 *
 * ## How the observation is taken
 *
 * The app is driven by `tauri-driver` (Tauri's WebDriver bridge, paired with the
 * Microsoft Edge WebDriver that matches the installed WebView2 runtime; both are
 * provisioned by the `tauri` job). One WebDriver session is created with the
 * `tauri:options.application` capability, and the values come FROM THE WEBVIEW:
 *
 *   1. `session-create` — the driver accepts a session for the packaged exe;
 *   2. `port-wait`     — the app's sidecar writes `<DATA_DIR>/port`;
 *   3. `executeScript` — `window.location.origin` in the page;
 *   4. `fetch`         — `fetch()` of `/api/server/instance` executed INSIDE that
 *                        origin, recording status and body.
 *
 * The direct `127.0.0.1` probe is recorded as corroboration: when both reads
 * succeed, their instance IDs must agree, because a mismatch would mean the page
 * reached a different server than the one the app launched. A missing direct
 * probe is recorded, not failed: it weakens corroboration but contradicts nothing.
 *
 * ## Evidence on every path
 *
 * `packaged.json` is written whatever happens, with the stage that failed, so a
 * red CI step names where the observation stopped instead of just "no output".
 * The uploaded copies of the driver log and the application log are sanitized
 * (see `scripts/lib/sanitize.ts`); the data directory itself is never uploaded.
 *
 * ## What this is not
 *
 * It is Windows-only by construction: the driver, the WebView2 runtime and the
 * `http://app.localhost` form are all Windows facts. On any other platform the
 * script fails at `session-create` and says so.
 *
 * Usage:
 *   bun run verify:packaged-origin [--app=<exe>] [--out=<dir>]
 *                                  [--driver=<tauri-driver>] [--native-driver=<msedgedriver>]
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  sequentialStages,
  tailText,
  writeEvidenceFile,
  type StageResult,
} from "./lib/webview-observation";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_APP = path.join(REPO_ROOT, "TBAi-windows-x64-portable", "TBAi.exe");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "tests", ".artifacts", "origin");

/**
 * The origin a Windows WebView2 page gets for a custom protocol: `http://<scheme>.localhost`.
 * Tauri registers the protocol as `app` (`src-tauri/tauri.conf.json` `frontendDist`).
 */
export const EXPECTED_PACKAGED_ORIGIN = "http://app.localhost";

const DRIVER_READY_TIMEOUT_MS = 60_000;
const PORT_MIRROR_TIMEOUT_MS = 120_000;
const CDP_STEP_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const LOG_TAIL_CHARS = 8_000;

export const PACKAGED_STAGES = ["session-create", "port-wait", "executeScript", "fetch"] as const;
export type PackagedStage = (typeof PACKAGED_STAGES)[number];

export interface PackagedOriginInput {
  readonly appPath: string;
  readonly appExists: boolean;
  readonly driver: {
    readonly spawnError: string | null;
    /** Non-null when the driver process ended before a session was created. */
    readonly exitCode: number | null;
  };
  readonly session: { readonly id: string | null; readonly error: string | null };
  readonly port: { readonly value: number | null; readonly error: string | null };
  readonly script: { readonly origin: string | null; readonly error: string | null };
  readonly probe: {
    readonly status: number | null;
    readonly body: string | null;
    readonly error: string | null;
  };
  /** The app's own instance id, read directly from `127.0.0.1` (corroboration). */
  readonly appInstanceId: string | null;
}

export interface PackagedAssessment {
  readonly ok: boolean;
  readonly stage: PackagedStage | null;
  readonly failures: readonly string[];
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function instanceIdOf(text: string | null): string | null {
  const record = parseJsonObject(text);
  const value = record?.instanceId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Every reason the run is not evidence of what it claims, and the first stage
 * that failed.
 *
 * Pure, so the whole failure matrix is testable without a driver, an app, or a
 * WebView.
 */
export function assessPackagedOrigin(input: PackagedOriginInput): PackagedAssessment {
  const sessionFailures: string[] = [];
  if (!input.appExists) {
    sessionFailures.push(`the packaged app does not exist at ${input.appPath}`);
  }
  if (input.driver.spawnError !== null) {
    sessionFailures.push(`the driver could not be started: ${input.driver.spawnError}`);
  }
  if (input.driver.exitCode !== null) {
    sessionFailures.push(
      `the driver exited with ${input.driver.exitCode} before a session was created`,
    );
  }
  if (input.session.error !== null) sessionFailures.push(input.session.error);
  if (sessionFailures.length === 0 && input.session.id === null) {
    sessionFailures.push("the driver returned no session id");
  }

  const portFailures: string[] = [];
  if (input.port.error !== null) portFailures.push(input.port.error);
  else if (input.port.value === null) {
    portFailures.push("the app never reported a usable port");
  }

  const scriptFailures: string[] = [];
  if (input.script.error !== null) {
    scriptFailures.push(input.script.error);
  } else if (input.script.origin === null) {
    scriptFailures.push("the WebView reported no origin");
  } else if (input.script.origin !== EXPECTED_PACKAGED_ORIGIN) {
    scriptFailures.push(
      `the WebView's origin is ${input.script.origin}, expected ${EXPECTED_PACKAGED_ORIGIN}`,
    );
  }

  const probeFailures: string[] = [];
  if (input.probe.error !== null) {
    probeFailures.push(input.probe.error);
  } else if (input.probe.status !== 200) {
    probeFailures.push(
      `the in-origin GET /api/server/instance returned ${input.probe.status ?? "no status"}`,
    );
  } else {
    const instanceId = instanceIdOf(input.probe.body);
    if (instanceId === null) {
      probeFailures.push(
        `the in-origin GET /api/server/instance returned no instanceId: ${JSON.stringify(
          tailText(input.probe.body ?? "", 500),
        )}`,
      );
    } else if (input.appInstanceId !== null && input.appInstanceId !== instanceId) {
      probeFailures.push(
        "the in-origin read reached a different server than the app launched " +
          `(${instanceId} vs ${input.appInstanceId})`,
      );
    }
  }

  const stages: StageResult<PackagedStage>[] = [
    { stage: "session-create", failures: sessionFailures },
    { stage: "port-wait", failures: portFailures },
    { stage: "executeScript", failures: scriptFailures },
    { stage: "fetch", failures: probeFailures },
  ];
  return sequentialStages(stages);
}

/** The WebDriver session id and capabilities from a `POST /session` body. */
export function parseSessionResponse(text: string | null): {
  sessionId: string | null;
  capabilities: unknown;
  error: string | null;
} {
  const record = parseJsonObject(text);
  if (record === null) {
    return {
      sessionId: null,
      capabilities: null,
      error: `the driver returned no readable session: ${JSON.stringify(tailText(text ?? "", 500))}`,
    };
  }
  const value = record.value;
  if (value !== null && typeof value === "object") {
    const body = value as Record<string, unknown>;
    if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
      return { sessionId: body.sessionId, capabilities: body.capabilities ?? null, error: null };
    }
    const message = typeof body.message === "string" ? body.message : JSON.stringify(body);
    return {
      sessionId: null,
      capabilities: null,
      error: `the driver refused the session: ${message}`,
    };
  }
  return {
    sessionId: null,
    capabilities: null,
    error: `the driver returned no session object: ${JSON.stringify(tailText(text ?? "", 500))}`,
  };
}

/**
 * The value a WebDriver execute call returned.
 *
 * A W3C command failure carries `value.error` plus `value.message`; a script's
 * own object never carries both, so the two cannot be confused.
 */
export function parseExecuteResponse(text: string | null): {
  value: unknown;
  error: string | null;
} {
  const record = parseJsonObject(text);
  if (record === null) {
    return {
      value: null,
      error: `the driver returned no readable response: ${tailText(text ?? "", 500)}`,
    };
  }
  const value = record.value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const body = value as Record<string, unknown>;
    if (typeof body.error === "string" && typeof body.message === "string") {
      return { value: null, error: `the driver rejected the script: ${body.message}` };
    }
  }
  return { value, error: null };
}

/** `{ origin, href, title }` from the origin script, with nulls for anything missing. */
export function readOriginValue(value: unknown): {
  origin: string | null;
  href: string | null;
  title: string | null;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { origin: null, href: null, title: null };
  }
  const record = value as Record<string, unknown>;
  return {
    origin: typeof record.origin === "string" ? record.origin : null,
    href: typeof record.href === "string" ? record.href : null,
    title: typeof record.title === "string" ? record.title : null,
  };
}

/** `{ status, body }` from the in-origin fetch script. */
export function readProbeValue(value: unknown): {
  status: number | null;
  body: string | null;
  error: string | null;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: null, body: null, error: "the in-origin script returned no result" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.fetchError === "string") {
    return { status: null, body: null, error: `the in-origin fetch failed: ${record.fetchError}` };
  }
  return {
    status: typeof record.status === "number" ? record.status : null,
    body: typeof record.body === "string" ? record.body : null,
    error: null,
  };
}

interface PackagedOptions {
  readonly appPath: string;
  readonly outDir: string;
  readonly driverBinary: string;
  readonly nativeDriver: string | null;
}

function parseArgs(argv: readonly string[]): PackagedOptions | null {
  let appPath = DEFAULT_APP;
  let outDir = DEFAULT_OUT_DIR;
  let driverBinary = process.env.TAURI_DRIVER ?? "tauri-driver";
  let nativeDriver = process.env.EDGEDRIVER ?? null;
  for (const arg of argv) {
    if (arg.startsWith("--app=")) appPath = path.resolve(arg.slice("--app=".length).trim());
    else if (arg.startsWith("--out=")) outDir = path.resolve(arg.slice("--out=".length).trim());
    else if (arg.startsWith("--driver=")) driverBinary = arg.slice("--driver=".length).trim();
    else if (arg.startsWith("--native-driver=")) {
      nativeDriver = path.resolve(arg.slice("--native-driver=".length).trim());
    } else {
      console.error(`[g1] unknown argument: ${arg}`);
      return null;
    }
  }
  if (appPath.length === 0 || outDir.length === 0 || driverBinary.length === 0) {
    console.error("[g1] --app=, --out= and --driver= must not be empty");
    return null;
  }
  return { appPath, outDir, driverBinary, nativeDriver };
}

/**
 * Probes the driver binary before spawning it, so a missing binary becomes a
 * recorded failure with the OS error instead of an asynchronous 'error' event
 * racing the first request.
 *
 * `tauri-driver` has no version flag — it treats one as an unknown argument and
 * exits 1 ("Error: unused arguments left") — so the probe is `--help`, which
 * `src/cli.rs` implements by printing the banner and exiting 0. The version is
 * therefore recorded as null rather than invented.
 */
export function checkDriverBinary(binary: string): {
  available: boolean;
  version: string | null;
  helpLine: string | null;
  error: string | null;
} {
  const result = spawnSync(binary, ["--help"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error) {
    return { available: false, version: null, helpLine: null, error: errorMessage(result.error) };
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const helpLine =
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null;
  if (result.status !== 0) {
    return {
      available: false,
      version: null,
      helpLine,
      error: `${binary} --help exited ${result.status ?? "null"}: ${tailText(output, 500)}`,
    };
  }
  return { available: true, version: null, helpLine, error: null };
}

export type HostIntegrity = "low" | "medium" | "high" | "system" | "unknown";

/**
 * Reads the mandatory integrity level out of `whoami /groups` output.
 *
 * The level is recorded because the observation depends on it: WebView2 Runtime
 * 150 and later ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` when the host is
 * elevated, and msedgedriver passes the `--remote-debugging-port` it attaches to
 * through that variable (wry#1782, WebView2Feedback#5645). An elevated run
 * therefore never opens the CDP endpoint, so the evidence has to say which level
 * it was taken at instead of assuming the session timeout was the app's fault.
 */
export function parseIntegrityLevel(text: string): HostIntegrity {
  const match = /Mandatory Label\\(\w+)(?: Mandatory Level)?/.exec(text);
  if (match === null) return "unknown";
  const level = match[1].toLowerCase();
  return level === "low" || level === "medium" || level === "high" || level === "system"
    ? level
    : "unknown";
}

/** The current host's integrity level; `unknown` when it cannot be read. */
function readHostIntegrity(): { level: HostIntegrity; error: string | null } {
  const result = spawnSync("whoami", ["/groups"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error) return { level: "unknown", error: errorMessage(result.error) };
  const level = parseIntegrityLevel(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.status !== 0) {
    return { level, error: `whoami /groups exited ${result.status ?? "null"}` };
  }
  return {
    level,
    error: level === "unknown" ? "whoami /groups reported no mandatory label" : null,
  };
}

async function waitForPortMirror(
  mirrorPath: string,
  timeoutMs: number,
): Promise<{ port: number | null; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = fs.readFileSync(mirrorPath, "utf8").trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
        return { port: parsed, error: null };
      }
    } catch {
      /* not written yet */
    }
    if (Date.now() > deadline) {
      return {
        port: null,
        error: `the app did not write a usable port to ${mirrorPath} within ${timeoutMs} ms`,
      };
    }
    await sleep(POLL_MS);
  }
}

async function createSession(
  driverBaseUrl: string,
  appPath: string,
): Promise<{
  response: ReturnType<typeof parseSessionResponse>;
  status: number | null;
  error: string | null;
}> {
  const deadline = Date.now() + DRIVER_READY_TIMEOUT_MS;
  let last: { status: number | null; text: string | null; error: string | null } = {
    status: null,
    text: null,
    error: null,
  };
  for (;;) {
    last = await httpJson(`${driverBaseUrl}/session`, {
      method: "POST",
      body: { capabilities: { alwaysMatch: { "tauri:options": { application: appPath } } } },
      timeoutMs: CDP_STEP_TIMEOUT_MS,
    });
    if (last.status !== null) break;
    if (Date.now() > deadline) break;
    await sleep(POLL_MS);
  }
  if (last.status === null) {
    return {
      response: { sessionId: null, capabilities: null, error: null },
      status: null,
      error: `the driver did not accept a request within ${DRIVER_READY_TIMEOUT_MS} ms: ${last.error ?? "unknown error"}`,
    };
  }
  return { response: parseSessionResponse(last.text), status: last.status, error: null };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: bun run verify:packaged-origin [--app=<exe>] [--out=<dir>]\n" +
        "                                      [--driver=<tauri-driver>] [--native-driver=<msedgedriver>]",
    );
    return 0;
  }
  const options = parseArgs(argv);
  if (!options) return 1;

  const runId = `${new Date().toISOString()}-${os.hostname()}`;
  const evidencePath = path.join(options.outDir, "packaged.json");
  fs.rmSync(evidencePath, { force: true });
  const hostIntegrity = readHostIntegrity();
  const elevated = hostIntegrity.level === "high" || hostIntegrity.level === "system";

  const appExists = fs.existsSync(options.appPath);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-origin-packaged-"));
  const dataDir = path.join(tempRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const driverLogPath = path.join(tempRoot, "tauri-driver.log");
  const appLogPath = path.join(tempRoot, "tbai.log");

  const session: {
    id: string | null;
    capabilities: unknown;
    status: number | null;
    error: string | null;
  } = {
    id: null,
    capabilities: null,
    status: null,
    error: null,
  };
  const driver: { spawnError: string | null; exitCode: number | null } = {
    spawnError: null,
    exitCode: null,
  };
  const port: { value: number | null; error: string | null } = { value: null, error: null };
  const script: {
    origin: string | null;
    href: string | null;
    title: string | null;
    error: string | null;
  } = {
    origin: null,
    href: null,
    title: null,
    error: null,
  };
  const probe: { status: number | null; body: string | null; error: string | null } = {
    status: null,
    body: null,
    error: null,
  };
  let appInstanceId: string | null = null;
  let driverVersion: string | null = null;
  let driverHelpLine: string | null = null;
  let driverPort: number | null = null;
  let nativePort: number | null = null;
  let driverStop: ProcessStopResult = {
    attempted: false,
    method: null,
    descendants: [],
    survivors: [],
    confirmed: true,
    errors: [],
  };
  let sessionDeleteStatus: number | null = null;
  let logFd: number | null = null;
  let driverChild: ReturnType<typeof spawn> | null = null;
  const teardownErrors: string[] = [];

  try {
    if (!appExists) {
      // Nothing to drive. The assessment below records this at `session-create`;
      // the evidence is still written, which is the point of running the script
      // on a machine that has neither the packaged app nor the driver.
      driver.spawnError = null;
    } else {
      const checked = checkDriverBinary(options.driverBinary);
      driverVersion = checked.version;
      driverHelpLine = checked.helpLine;
      if (!checked.available) {
        driver.spawnError = checked.error ?? "the driver is not available";
      } else {
        driverPort = await allocateFreePort();
        nativePort = await allocateFreePort();
        const args = [
          ...(options.nativeDriver === null ? [] : ["--native-driver", options.nativeDriver]),
          "--port",
          String(driverPort),
          "--native-port",
          String(nativePort),
        ];
        logFd = fs.openSync(driverLogPath, "a");
        driverChild = spawn(options.driverBinary, args, {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            DATA_DIR: dataDir,
            // Explicit, so the sanitized upload has a known path in every install.
            TBAI_LOG_FILE: appLogPath,
          },
          stdio: ["ignore", logFd, logFd],
          windowsHide: true,
        });
        driverChild.on("error", (error) => {
          driver.spawnError = errorMessage(error);
        });
        driverChild.on("exit", (code) => {
          driver.exitCode = code;
        });

        const created = await createSession(`http://127.0.0.1:${driverPort}`, options.appPath);
        session.status = created.status;
        session.error = created.error ?? created.response.error;
        session.id = created.response.sessionId;
        session.capabilities = created.response.capabilities;

        if (session.id !== null) {
          port.value = await (async () => {
            const mirror = await waitForPortMirror(
              path.join(dataDir, "port"),
              PORT_MIRROR_TIMEOUT_MS,
            );
            port.error = mirror.error;
            return mirror.port;
          })();

          if (port.value !== null) {
            const direct = await httpJson(`http://127.0.0.1:${port.value}/api/server/instance`, {
              timeoutMs: CDP_STEP_TIMEOUT_MS,
            });
            appInstanceId = instanceIdOf(direct.text);

            const originCall = await httpJson(
              `http://127.0.0.1:${driverPort}/session/${session.id}/execute/sync`,
              {
                method: "POST",
                body: {
                  script:
                    "return { origin: window.location.origin, href: window.location.href, title: document.title };",
                  args: [],
                },
                timeoutMs: CDP_STEP_TIMEOUT_MS,
              },
            );
            if (originCall.status === null) {
              script.error = `could not execute in the WebView: ${originCall.error ?? "unknown error"}`;
            } else {
              const executed = parseExecuteResponse(originCall.text);
              script.error = executed.error;
              const read = readOriginValue(executed.value);
              script.origin = read.origin;
              script.href = read.href;
              script.title = read.title;
            }

            const apiUrl = `http://127.0.0.1:${port.value}/api/server/instance`;
            const fetchCall = await httpJson(
              `http://127.0.0.1:${driverPort}/session/${session.id}/execute/async`,
              {
                method: "POST",
                body: {
                  script:
                    "const done = arguments[arguments.length - 1];" +
                    `fetch(${JSON.stringify(apiUrl)})` +
                    "  .then(async (response) => done({ status: response.status, body: await response.text() }))" +
                    "  .catch((error) => done({ fetchError: String(error) }));",
                  args: [],
                },
                timeoutMs: CDP_STEP_TIMEOUT_MS,
              },
            );
            if (fetchCall.status === null) {
              probe.error = `could not run the in-origin fetch: ${fetchCall.error ?? "unknown error"}`;
            } else {
              const executed = parseExecuteResponse(fetchCall.text);
              probe.error = executed.error;
              const read = readProbeValue(executed.value);
              probe.status = read.status;
              probe.body = read.body;
              probe.error = read.error ?? probe.error;
            }
          }
        }
      }
    }
  } catch (error) {
    const message = `the run failed before the observation completed: ${errorMessage(error)}`;
    if (session.id === null) session.error = session.error ?? message;
    else probe.error = probe.error ?? message;
  }

  // Teardown, on every path. The session delete is attempted before the tree is
  // stopped, because a graceful close is what tells the app to shut its sidecar
  // down; the tree stop is the guarantee.
  if (driverChild !== null && driverPort !== null && session.id !== null) {
    const deleted = await httpJson(`http://127.0.0.1:${driverPort}/session/${session.id}`, {
      method: "DELETE",
      timeoutMs: CDP_STEP_TIMEOUT_MS,
    });
    sessionDeleteStatus = deleted.status;
    if (deleted.status === null)
      teardownErrors.push(`deleting the session failed: ${deleted.error}`);
  }
  if (driverChild?.pid !== undefined) {
    try {
      driverStop = stopProcessTree(driverChild.pid);
      teardownErrors.push(...driverStop.errors);
    } catch (error) {
      driverStop = {
        attempted: true,
        method: null,
        descendants: [],
        survivors: [],
        confirmed: false,
        errors: [errorMessage(error)],
      };
      teardownErrors.push(`stopping the driver failed: ${errorMessage(error)}`);
    }
  }
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch (error) {
      teardownErrors.push(`closing the driver log failed: ${errorMessage(error)}`);
    }
    logFd = null;
  }
  if (driverStop.survivors.length > 0) {
    teardownErrors.push(`the driver tree left pid(s) ${driverStop.survivors.join(", ")} running`);
  }

  let rawDriverLog = "";
  try {
    if (fs.existsSync(driverLogPath)) rawDriverLog = fs.readFileSync(driverLogPath, "utf8");
  } catch (error) {
    teardownErrors.push(`reading the driver log failed: ${errorMessage(error)}`);
  }
  const driverLog = sanitizeLogFile(driverLogPath, path.join(options.outDir, "tauri-driver.log"));
  const appLog = sanitizeLogFile(appLogPath, path.join(options.outDir, "tbai.log"));
  // An absent log is normal when nothing launched; only a source that existed
  // and could not be copied is a teardown failure.
  if (driverLog.sourceExisted && !driverLog.written) {
    teardownErrors.push(`the driver log was not uploaded: ${driverLog.error}`);
  }
  if (appLog.sourceExisted && !appLog.written) {
    teardownErrors.push(`the application log was not uploaded: ${appLog.error}`);
  }

  let tempRootRemoved = false;
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRootRemoved = !fs.existsSync(tempRoot);
  } catch (error) {
    teardownErrors.push(`removing the temporary root failed: ${errorMessage(error)}`);
  }

  const assessment = assessPackagedOrigin({
    appPath: options.appPath,
    appExists,
    driver,
    session: { id: session.id, error: session.error },
    port,
    script: { origin: script.origin, error: script.error },
    probe,
    appInstanceId,
  });

  const failures = [...assessment.failures];
  if (elevated && assessment.stage === "session-create") {
    failures.push(
      "host: elevated, so WebView2 ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS and the " +
        "debugging port msedgedriver attaches to never opens (wry#1782); run this at medium integrity",
    );
  }
  if (driverStop.attempted && !driverStop.confirmed) {
    failures.push("teardown: the driver process tree did not terminate");
  }
  if (!tempRootRemoved) failures.push("teardown: the temporary root was not removed");
  for (const error of teardownErrors) failures.push(`teardown: ${error}`);

  const evidence = {
    schemaVersion: 1 as const,
    kind: "packaged" as const,
    runId,
    generatedAt: new Date().toISOString(),
    expectedOrigin: EXPECTED_PACKAGED_ORIGIN,
    app: { path: options.appPath, exists: appExists, dataDir, logPath: appLogPath },
    host: {
      platform: process.platform,
      integrity: hostIntegrity.level,
      elevated,
      integrityError: hostIntegrity.error,
    },
    driver: {
      binary: options.driverBinary,
      nativeDriver: options.nativeDriver,
      version: driverVersion,
      helpLine: driverHelpLine,
      port: driverPort,
      nativePort,
      pid: driverChild?.pid ?? null,
      spawnError: driver.spawnError,
      exitCode: driver.exitCode,
      sessionStatus: session.status,
      sessionId: session.id,
      capabilities: session.capabilities,
    },
    port,
    script,
    probe,
    appInstanceId,
    observations: {
      originMatchesExpected: script.origin === EXPECTED_PACKAGED_ORIGIN,
      inOriginApiStatus: probe.status,
      /** Null when corroboration was unavailable; a mismatch is a failure instead. */
      instanceMatchesApp:
        appInstanceId === null ? null : instanceIdOf(probe.body) === appInstanceId,
    },
    assessment: { ok: assessment.ok && failures.length === 0, stage: assessment.stage, failures },
    teardown: { sessionDeleteStatus, driverStop, tempRootRemoved, errors: teardownErrors },
    logs: {
      driver: {
        sourceExisted: driverLog.sourceExisted,
        written: driverLog.written,
        redactions: driverLog.redactions,
        truncatedChars: driverLog.truncatedChars,
        error: driverLog.error,
      },
      app: {
        sourceExisted: appLog.sourceExisted,
        written: appLog.written,
        redactions: appLog.redactions,
        truncatedChars: appLog.truncatedChars,
        error: appLog.error,
      },
      /** Sanitized: this file is uploaded too. */
      driverTail: sanitizeLogText(tailText(rawDriverLog, LOG_TAIL_CHARS)).text,
    },
  };

  const written = writeEvidenceFile(evidencePath, evidence);
  if (!written.written) {
    console.error(`[g1] ${written.error}`);
    return 1;
  }

  const ok = evidence.assessment.ok && written.written;
  console.log(`[g1] ${ok ? "PASS" : "FAIL"} — ${evidencePath}`);
  if (!ok) {
    console.error(`[g1] stage: ${assessment.stage ?? "(teardown only)"}`);
    for (const failure of failures) console.error(`[g1]   ${failure}`);
  }
  return ok ? 0 : 1;
}

// Guarded so the unit test can import the pure assessment without driving an app.
if (import.meta.main) {
  process.exitCode = await main();
}
