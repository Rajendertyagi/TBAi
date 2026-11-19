/**
 * Dedicated runner for the managed-restart recovery acceptance tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * The recovery specs need a local stub model provider and a TBAi server
 * configured to use it. The stub is a `Bun.serve` instance that lives in THIS
 * process. Playwright must therefore be driven with an ASYNC child process: a
 * synchronous `spawnSync` blocks this process's event loop for the whole test,
 * so the stub can never answer the model request. That was the exact cause of
 * B1 — the prompt was admitted and delivered, but the LLM step never started
 * because the stub could not respond while the runner's loop was blocked.
 *
 * This runner is the durable, in-repo form of that fix. It is the only supported
 * way to run the dedicated recovery specs, and CI invokes it from the Windows
 * `e2e` job.
 *
 * SCENARIOS
 * ---------
 * - completed-transcript (default): the original B1 test — a completed turn
 *   survives a managed-child restart.
 * - orderly-shutdown: the stub holds the first request so the turn is genuinely
 *   unfinished; the spec drives a real application shutdown + restart through
 *   the control protocol below, then asserts recovery continued the turn.
 * - abrupt-crash: the stub holds the first request; the spec kills the verified
 *   managed child, the manager restarts it, and recovery must continue the turn.
 *
 * CONTROL PROTOCOL (orderly-shutdown scenario)
 * --------------------------------------------
 * When `controlDir` is set, the runner watches it (non-blocking) for command
 * files written by the spec:
 *   - `cmd.shutdown` → send the production `{"type":"shutdown"}` line to TBAi's
 *     stdin, wait for exit, write `done.shutdown`.
 *   - `cmd.start` → relaunch TBAi with the SAME data/env/port, wait for healthz,
 *     write `done.start`.
 * The spec waits for each `done.*` file. This keeps the production shutdown
 * entry point real while letting a single Playwright spec drive the full cycle.
 *
 * The runner fails closed: a passing Playwright run with fewer than the expected
 * stub calls is a failure, so a green result always means the model was reached.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStubProvider } from "../tests/harness/opencodeStubProvider";
import { buildStubOpenCodeConfig, STUB_MODEL_ID } from "../tests/harness/opencodeStubConfig";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SPEC = "tests/e2e/opencode/opencode-managed-restart-recovery.spec.ts";
const EXPECTED_OPENCODE_VERSION = "2.2.6";

/**
 * Run a child process asynchronously, keeping the caller's event loop free.
 *
 * This is the load-bearing seam behind the B1 fix: the in-process stub provider
 * must remain able to serve HTTP while this child (Playwright) runs. Exported so
 * a regression test can prove the event loop stays responsive.
 */
export function runChildAsync(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string>; stdio?: "inherit" | "ignore" } = {},
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  cond: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string,
  interval = 250,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await cond()) return;
    } catch {
      /* retry */
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function inside(root: string, target: string): boolean {
  const r = path.resolve(root).toLowerCase();
  const t = path.resolve(target).toLowerCase();
  return t === r || t.startsWith(r + path.sep.toLowerCase());
}

/** Minimal environment needed to launch Bun/TBAi on Windows without inheriting host state. */
function preservedEnv(): Record<string, string> {
  const keys = [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "SYSTEMDRIVE",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
  ];
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

export interface ManagedRestartRunOptions {
  readonly root: string;
  readonly evidenceDir: string;
  readonly openCodeBinary?: string;
  /** Spec file (relative to repo root). Defaults to the completed-transcript B1 spec. */
  readonly spec?: string;
  /** Hold the first stub request to create a genuinely unfinished turn. */
  readonly holdFirstRequest?: boolean;
  /** Directory for the shutdown/start control protocol (orderly-shutdown scenario). */
  readonly controlDir?: string;
  /** Minimum stub requests required for a passing run (fail-closed). Defaults to 1. */
  readonly minStubRequests?: number;
}

/** Execute one managed-restart acceptance run. Returns the Playwright exit code. */
export async function runManagedRestartE2E(options: ManagedRestartRunOptions): Promise<number> {
  const { root, evidenceDir } = options;
  fs.mkdirSync(evidenceDir, { recursive: true });

  const log = (...args: unknown[]) => {
    const line = `${new Date().toISOString()} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
    console.log(line);
    fs.appendFileSync(path.join(evidenceDir, "runner.log"), `${line}\n`, "utf8");
  };

  const iso = {
    root,
    xdgConfigHome: path.join(root, "xdg-config"),
    configDir: path.join(root, "xdg-config", "opencode"),
    configFile: path.join(root, "xdg-config", "opencode", "opencode.json"),
    xdgDataHome: path.join(root, "xdg-data"),
    dataDir: path.join(root, "xdg-data", "opencode"),
    xdgStateHome: path.join(root, "xdg-state"),
    xdgCacheHome: path.join(root, "xdg-cache"),
    tbaiDataDir: path.join(root, "tbai-data"),
    workspaceDir: path.join(root, "workspace"),
    opencodeDbPath: path.join(root, "xdg-data", "opencode", "opencode.db"),
    tempDir: path.join(root, "temp"),
    userHomeDir: path.join(root, "user-home"),
    appDataDir: path.join(root, "appdata-roaming"),
    localAppDataDir: path.join(root, "appdata-local"),
  };
  const dirs = [
    iso.root,
    iso.xdgConfigHome,
    iso.configDir,
    iso.xdgDataHome,
    iso.dataDir,
    iso.xdgStateHome,
    iso.xdgCacheHome,
    iso.tbaiDataDir,
    iso.workspaceDir,
    iso.tempDir,
    iso.userHomeDir,
    iso.appDataDir,
    iso.localAppDataDir,
    path.dirname(iso.opencodeDbPath),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries(iso)) {
    if (!inside(root, v)) throw new Error(`${k} escapes root: ${v}`);
  }

  const ts = path.basename(root);
  const fixedMarker = `UI-RESTART-MARKER-${ts}-${process.pid}`;
  const stub = await startStubProvider({
    model: STUB_MODEL_ID,
    text: `OK ${fixedMarker}`,
    holdFirstRequest: options.holdFirstRequest === true,
  });
  let tbai: ReturnType<typeof spawn> | null = null;
  let controlTimer: ReturnType<typeof setInterval> | null = null;
  let pwExit = 1;

  const port = 47123 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    ...preservedEnv(),
    DATA_DIR: iso.tbaiDataDir,
    WORKSPACE_DIR: iso.workspaceDir,
    OPENCODE_DB: iso.opencodeDbPath,
    XDG_DATA_HOME: iso.xdgDataHome,
    XDG_CONFIG_HOME: iso.xdgConfigHome,
    XDG_STATE_HOME: iso.xdgStateHome,
    XDG_CACHE_HOME: iso.xdgCacheHome,
    OPENCODE_CONFIG_DIR: iso.configDir,
    OPENCODE_CONFIG: iso.configFile,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    HOME: iso.userHomeDir,
    USERPROFILE: iso.userHomeDir,
    APPDATA: iso.appDataDir,
    LOCALAPPDATA: iso.localAppDataDir,
    TEMP: iso.tempDir,
    TMP: iso.tempDir,
    PORT: String(port),
    NODE_ENV: "test",
    TBAI_OPENCODE_DIAG_LOG: path.join(evidenceDir, "opencode-diag.jsonl"),
  };
  if (options.openCodeBinary) env.OPENCODE_BINARY = options.openCodeBinary;
  for (const k of [
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_URL",
    "OPENCODE_HOST",
    "OPENCODE_PORT",
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_PASSWORD",
  ])
    delete env[k];

  const startTBAi = (): ReturnType<typeof spawn> => {
    const out = fs.openSync(path.join(evidenceDir, "tbai.stdout.log"), "a");
    const err = fs.openSync(path.join(evidenceDir, "tbai.stderr.log"), "a");
    const child = spawn(process.execPath, ["src/index.ts"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", out, err],
    });
    log("tbai spawned", child.pid, "port", port);
    return child;
  };

  const stopTBAi = async (child: ReturnType<typeof spawn>): Promise<void> => {
    if (child.exitCode !== null) return;
    try {
      child.stdin?.write('{"type":"shutdown"}\n');
      child.stdin?.end();
      await waitFor(
        async () => child.exitCode !== null || child.signalCode !== null,
        30_000,
        "tbai exit",
      ).catch(() => undefined);
    } catch {
      /* ignore */
    }
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  };

  try {
    const config = { ...buildStubOpenCodeConfig(stub.baseURL), plugin: [] };
    fs.writeFileSync(iso.configFile, JSON.stringify(config, null, 2), "utf8");
    fs.writeFileSync(path.join(evidenceDir, "fixed-marker.txt"), fixedMarker, "utf8");
    fs.writeFileSync(
      path.join(evidenceDir, "tbai-env.json"),
      JSON.stringify({ ...env, PATH: "<preserved>", Path: "<preserved>" }, null, 2),
      "utf8",
    );
    log(
      "stub",
      stub.baseURL,
      "marker",
      fixedMarker,
      "holdFirstRequest",
      options.holdFirstRequest === true,
    );

    tbai = startTBAi();
    await waitFor(
      async () => {
        try {
          return (await fetch(`${base}/healthz`)).ok;
        } catch {
          return false;
        }
      },
      120_000,
      "tbai healthz",
    );
    log("tbai ready");

    // Control protocol for the orderly-shutdown scenario. Non-blocking polling
    // keeps the event loop free for the in-process stub (the B1 fix).
    if (options.controlDir) {
      const controlDir = options.controlDir;
      fs.mkdirSync(controlDir, { recursive: true });
      let busy = false;
      controlTimer = setInterval(() => {
        if (busy) return;
        try {
          if (
            fs.existsSync(path.join(controlDir, "cmd.shutdown")) &&
            !fs.existsSync(path.join(controlDir, "done.shutdown"))
          ) {
            busy = true;
            void (async () => {
              try {
                log("control: shutdown requested");
                const current = tbai!;
                await stopTBAi(current);
                fs.writeFileSync(path.join(controlDir, "done.shutdown"), "ok", "utf8");
                log("control: shutdown done");
              } finally {
                busy = false;
              }
            })();
          } else if (
            fs.existsSync(path.join(controlDir, "cmd.start")) &&
            !fs.existsSync(path.join(controlDir, "done.start"))
          ) {
            busy = true;
            void (async () => {
              try {
                log("control: start requested");
                tbai = startTBAi();
                await waitFor(
                  async () => {
                    try {
                      return (await fetch(`${base}/healthz`)).ok;
                    } catch {
                      return false;
                    }
                  },
                  120_000,
                  "tbai healthz after restart",
                );
                fs.writeFileSync(path.join(controlDir, "done.start"), "ok", "utf8");
                log("control: start done");
              } finally {
                busy = false;
              }
            })();
          }
        } catch (err) {
          log("control error", String(err));
          busy = false;
        }
      }, 250);
    }

    // THE FIX: async spawn keeps this process's event loop free so the in-process
    // stub can answer OpenCode's model request while Playwright drives the test.
    const spec = options.spec ?? DEFAULT_SPEC;
    pwExit = await runChildAsync(
      process.execPath,
      ["x", "playwright", "test", spec, "--project=chromium-headless", "--reporter=line"],
      {
        cwd: path.join(REPO_ROOT, "web"),
        env: {
          ...process.env,
          TBAI_E2E_BASE_URL: base,
          TBAI_E2E_EXTERNAL_SERVER: "1",
          TBAI_RESTART_EVIDENCE_DIR: evidenceDir,
          TBAI_RESTART_TEMP_ROOT: root,
          TBAI_RESTART_FIXED_MARKER: fixedMarker,
          ...(options.controlDir ? { TBAI_RESTART_CONTROL_DIR: options.controlDir } : {}),
        },
        stdio: "inherit",
      },
    );
    log("playwright exit", pwExit);

    // Fail closed: a passing Playwright run with too few stub calls means the
    // model was never reached (B1) or recovery never re-submitted (interruption
    // scenarios). Never report green on missing evidence.
    fs.writeFileSync(
      path.join(evidenceDir, "stub-requests.json"),
      JSON.stringify(stub.requests, null, 2),
      "utf8",
    );
    log("stub requests", stub.requests.length);
    const minRequests = options.minStubRequests ?? 1;
    if (pwExit === 0 && stub.requests.length < minRequests) {
      log(
        `FAIL: Playwright passed but stub received ${stub.requests.length} < ${minRequests} requests`,
      );
      pwExit = 1;
    }
    // For interruption scenarios, prove the SHARED RECOVERY SERVICE drove the
    // continuation — not an OpenCode-internal auto-resume. The stub always
    // answers the same text, so a plain assistant response is indistinguishable.
    // The recovery synthetic posts a distinctive prompt; require a request whose
    // messages carry it. This is the load-bearing evidence for point 2.
    if (pwExit === 0 && options.holdFirstRequest === true) {
      const recoveryMarker = "The server restarted while you were working";
      const recoveryRequest = stub.requests.find((r) =>
        r.messages?.some(
          (m) => typeof m.content === "string" && m.content.includes(recoveryMarker),
        ),
      );
      if (!recoveryRequest) {
        log(
          "FAIL: Playwright passed but no stub request carried the recovery-synthetic prompt " +
            "— the assistant response did not come from the shared recovery service",
        );
        pwExit = 1;
      } else {
        log("recovery synthetic reached stub at request", recoveryRequest.sequence);
      }
    }
  } finally {
    if (controlTimer) clearInterval(controlTimer);
    if (tbai) await stopTBAi(tbai);
    try {
      stub.stop();
    } catch {
      /* ignore */
    }
  }
  return pwExit;
}

async function main(): Promise<number> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  const scenario = process.env.TBAI_RECOVERY_SCENARIO ?? "completed-transcript";
  const root = path.join(
    REPO_ROOT,
    "tests",
    ".artifacts",
    "managed-restart",
    `${scenario}-${stamp}-${process.pid}`,
  );
  const evidenceDir = path.join(root, "evidence", "ui-restart");
  const openCodeBinary = process.env.OPENCODE_BINARY || undefined;
  console.log(`[managed-restart] scenario=${scenario} root=${root}`);
  console.log(
    `[managed-restart] expected OpenCode version ${EXPECTED_OPENCODE_VERSION} (binary: ${openCodeBinary ?? "PATH"})`,
  );

  const scenarioConfig: Record<string, Partial<ManagedRestartRunOptions>> = {
    "completed-transcript": { spec: DEFAULT_SPEC, minStubRequests: 1 },
    "orderly-shutdown": {
      spec: "tests/e2e/opencode/opencode-recovery-shutdown.spec.ts",
      holdFirstRequest: true,
      controlDir: path.join(root, "control"),
      // title + held main turn + recovery synthetic
      minStubRequests: 3,
    },
    "abrupt-crash": {
      spec: "tests/e2e/opencode/opencode-recovery-crash.spec.ts",
      holdFirstRequest: true,
      // title + held main turn + recovery synthetic
      minStubRequests: 3,
    },
  };
  const config = scenarioConfig[scenario];
  if (!config) {
    console.error(`[managed-restart] unknown scenario: ${scenario}`);
    return 1;
  }
  return runManagedRestartE2E({ root, evidenceDir, openCodeBinary, ...config });
}

if (import.meta.main) {
  process.exit(await main());
}
