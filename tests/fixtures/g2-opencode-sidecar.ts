/**
 * Real-server sidecar stand-in for the G2 lifecycle test.
 *
 * It is the shipped entry point in miniature: install the backend job, join the
 * shell's named job, then start the managed OpenCode server through the real
 * `OpenCodeServerManager` (or through `startOpenCodeRuntime` when adoption is exercised).
 *
 * On success it writes `ready.json` with the sidecar PID, base URL, and resolved
 * database path, then stays alive until the shell's job kills it. On refusal it
 * writes `error.json` and exits non-zero, leaving no managed child behind.
 */
import fs from "node:fs";
import path from "node:path";

import { OPENCODE_CONFIG } from "../../src/config/opencode.ts";
import { openCodeServerManager } from "../../src/services/opencode/serverManager.ts";
import { resolveOpenCodeDatabasePath } from "../../src/services/opencode/ownership.ts";
import { readConnectionState } from "../../src/services/opencode/connectionState.ts";
import { readOpenCodeRegistration } from "../../src/services/opencode/registration.ts";
import {
  backendJobStatus,
  installBackendProcessJob,
  joinShellJob,
} from "../../src/services/process-ownership.ts";
import { startOpenCodeRuntime } from "../../src/services/opencode/startup.ts";

const dir = process.env.TBAI_G2_DIR;
if (!dir) {
  console.error("G2_OPENCODE_SIDECAR_REFUSED: TBAI_G2_DIR is required");
  process.exit(2);
}

function fail(err: unknown): never {
  fs.writeFileSync(
    path.join(dir, "error.json"),
    JSON.stringify({
      name: err instanceof Error ? err.name : "Error",
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(4);
}

installBackendProcessJob();
const backendJob = backendJobStatus();
const shellJobName = process.env.TBAI_SHELL_JOB_NAME ?? "";
try {
  joinShellJob(shellJobName);
} catch (err) {
  fail(err);
}

try {
  let baseUrl: string;
  let mode: "managed" | "adopted" = "managed";
  let adoptedPid: number | null = null;
  let managedPid: number | null = null;

  if (process.env.TBAI_G2_ADOPT === "1") {
    const outcome = await startOpenCodeRuntime({ disabled: false });
    if (outcome.status === "adopted") {
      mode = "adopted";
      const state = readConnectionState();
      if (state.target.mode !== "adopted") {
        throw new Error("Expected adopted target mode after adopted outcome");
      }
      baseUrl = state.target.baseUrl;
      try {
        const reg = await readOpenCodeRegistration({ config: OPENCODE_CONFIG });
        adoptedPid = reg.pid;
      } catch {
        adoptedPid = null;
      }
    } else if (outcome.status === "managed") {
      mode = "managed";
      baseUrl = outcome.baseUrl;
      managedPid = openCodeServerManager.getManagedPid();
    } else {
      throw new Error(`Unexpected startup outcome: ${outcome.status}`);
    }
  } else {
    baseUrl = await openCodeServerManager.ensureBaseUrl();
    managedPid = openCodeServerManager.getManagedPid();
  }

  const binary = process.env.OPENCODE_BINARY ?? OPENCODE_CONFIG.binaryName;
  fs.mkdirSync(OPENCODE_CONFIG.serverHomeDir, { recursive: true });
  const dbPath = await resolveOpenCodeDatabasePath(
    binary,
    OPENCODE_CONFIG.serverHomeDir,
    OPENCODE_CONFIG.databasePathTimeoutMs,
  );
  fs.writeFileSync(
    path.join(dir, "ready.json"),
    JSON.stringify({
      sidecarPid: process.pid,
      managedPid,
      adoptedPid,
      mode,
      baseUrl,
      dbPath,
      backendJob,
    }),
  );
} catch (err) {
  fail(err);
}

// Stay alive until the shell job closes (or the test kills us).
await new Promise(() => {});
