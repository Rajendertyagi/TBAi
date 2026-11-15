/**
 * Real-server sidecar stand-in for the G2 lifecycle test.
 *
 * Managed-only runtime: starts the managed OpenCode server through the real
 * `OpenCodeServerManager` and reports its state.
 */
import fs from "node:fs";
import path from "node:path";

import { OPENCODE_CONFIG } from "../../src/config/opencode.ts";
import { openCodeServerManager } from "../../src/services/opencode/serverManager.ts";
import { resolveOpenCodeDatabasePath } from "../../src/services/opencode/ownership.ts";
import {
  backendJobStatus,
  installBackendProcessJob,
  joinShellJob,
} from "../../src/services/process-ownership.ts";

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
  const baseUrl = await openCodeServerManager.ensureBaseUrl();
  const managedPid = openCodeServerManager.getManagedPid();

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
      adoptedPid: null,
      mode: "managed",
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
