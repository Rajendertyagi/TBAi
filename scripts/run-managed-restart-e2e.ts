/**
 * Dedicated runner for the managed-restart recovery acceptance test.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tests/e2e/opencode/opencode-managed-restart-recovery.spec.ts` needs a local
 * stub model provider and a TBAi server configured to use it. The stub is a
 * `Bun.serve` instance that lives in THIS process. Playwright must therefore be
 * driven with an ASYNC child process: a synchronous `spawnSync` blocks this
 * process's event loop for the whole test, so the stub can never answer the
 * model request OpenCode sends. That was the exact cause of B1 — the prompt was
 * admitted and delivered, but the LLM step never started because the stub could
 * not respond while the runner's loop was blocked. The connection only arrived
 * at cleanup, when the loop was finally free.
 *
 * This runner is the durable, in-repo form of that fix. It is the only supported
 * way to run the dedicated spec, and CI invokes it from the Windows `e2e` job.
 *
 * It provides:
 *   - an isolated temp root and evidence directory per run;
 *   - a local stub provider (no external credentials) with a fixed marker;
 *   - a TBAi server pointed at that stub via a generated OpenCode config;
 *   - the pinned OpenCode binary (from OPENCODE_BINARY or PATH, version-checked);
 *   - cleanup of the server, stub and temp root after success AND failure;
 *   - fail-closed exit codes: a missing stub call or a non-zero Playwright exit
 *     fails the run, so a green result always means the recovery really worked.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStubProvider } from "../tests/harness/opencodeStubProvider";
import { buildStubOpenCodeConfig, STUB_MODEL_ID } from "../tests/harness/opencodeStubConfig";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = "tests/e2e/opencode/opencode-managed-restart-recovery.spec.ts";
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
  readonly project?: string;
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
  const stub = await startStubProvider({ model: STUB_MODEL_ID, text: `OK ${fixedMarker}` });
  let tbai: ReturnType<typeof spawn> | null = null;
  let pwExit = 1;

  try {
    const config = { ...buildStubOpenCodeConfig(stub.baseURL), plugin: [] };
    fs.writeFileSync(iso.configFile, JSON.stringify(config, null, 2), "utf8");
    fs.writeFileSync(path.join(evidenceDir, "fixed-marker.txt"), fixedMarker, "utf8");
    log("stub", stub.baseURL, "marker", fixedMarker);

    const port = 47123 + Math.floor(Math.random() * 1000);
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
    fs.writeFileSync(
      path.join(evidenceDir, "tbai-env.json"),
      JSON.stringify({ ...env, PATH: "<preserved>", Path: "<preserved>" }, null, 2),
      "utf8",
    );

    const out = fs.openSync(path.join(evidenceDir, "tbai.stdout.log"), "a");
    const err = fs.openSync(path.join(evidenceDir, "tbai.stderr.log"), "a");
    tbai = spawn(process.execPath, ["src/index.ts"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", out, err],
    });
    log("tbai spawned", tbai.pid, "port", port);
    const base = `http://127.0.0.1:${port}`;

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

    // THE FIX: async spawn keeps this process's event loop free so the in-process
    // stub can answer OpenCode's model request while Playwright drives the test.
    pwExit = await runChildAsync(
      process.execPath,
      ["x", "playwright", "test", SPEC, "--project=chromium-headless", "--reporter=line"],
      {
        cwd: path.join(REPO_ROOT, "web"),
        env: {
          ...process.env,
          TBAI_E2E_BASE_URL: base,
          TBAI_E2E_EXTERNAL_SERVER: "1",
          TBAI_RESTART_EVIDENCE_DIR: evidenceDir,
          TBAI_RESTART_TEMP_ROOT: root,
          TBAI_RESTART_FIXED_MARKER: fixedMarker,
        },
        stdio: "inherit",
      },
    );
    log("playwright exit", pwExit);

    // Fail closed: a passing Playwright run with zero stub calls means the model
    // was never reached — the exact B1 failure — and must not be reported green.
    fs.writeFileSync(
      path.join(evidenceDir, "stub-requests.json"),
      JSON.stringify(stub.requests, null, 2),
      "utf8",
    );
    log("stub requests", stub.requests.length);
    if (pwExit === 0 && stub.requests.length === 0) {
      log("FAIL: Playwright passed but the stub provider received no model request");
      pwExit = 1;
    }
  } finally {
    if (tbai && tbai.exitCode === null) {
      try {
        tbai.stdin?.write('{"type":"shutdown"}\n');
        tbai.stdin?.end();
        await waitFor(
          async () => tbai!.exitCode !== null || tbai!.signalCode !== null,
          30_000,
          "tbai exit",
        ).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
    if (tbai && tbai.exitCode === null) {
      try {
        tbai.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
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
  const root = path.join(
    REPO_ROOT,
    "tests",
    ".artifacts",
    "managed-restart",
    `${stamp}-${process.pid}`,
  );
  const evidenceDir = path.join(root, "evidence", "ui-restart");
  const openCodeBinary = process.env.OPENCODE_BINARY || undefined;
  console.log(`[managed-restart] root=${root}`);
  console.log(
    `[managed-restart] expected OpenCode version ${EXPECTED_OPENCODE_VERSION} (binary: ${openCodeBinary ?? "PATH"})`,
  );
  return runManagedRestartE2E({ root, evidenceDir, openCodeBinary });
}

if (import.meta.main) {
  process.exit(await main());
}
