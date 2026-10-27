/**
 * Stand-in for the TBAi sidecar in the G2 lifecycle test.
 *
 * Install order matches the shipped entry point: the backend job first, then the
 * shell job. It spawns a detached grandchild to demonstrate that the backend's
 * own kill-on-close job covers children Bun's implicit binding would not.
 */
import path from "node:path";

import {
  backendJobStatus,
  installBackendProcessJob,
  joinShellJob,
} from "../../src/services/process-ownership.ts";
import { writeRecordAtomically } from "../helpers/atomic-record.ts";

const dir = process.env.TBAI_G2_DIR;
if (!dir) {
  console.error("G2_SIDECAR_REFUSED: TBAI_G2_DIR is required");
  process.exit(2);
}

installBackendProcessJob();
const shellJobName = process.env.TBAI_SHELL_JOB_NAME ?? "";
if (process.env.TBAI_SKIP_SHELL_JOB !== "1") {
  try {
    joinShellJob(shellJobName);
  } catch (err) {
    writeRecordAtomically(
      path.join(dir, "sidecar-refused.json"),
      JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
    );
    process.exit(3);
  }
}

const grandchild = Bun.spawn(
  ["bun", path.join(import.meta.dir, "descendant-probe-server.ts"), path.join(dir, "grandchild")],
  {
    cwd: import.meta.dir,
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  },
);

// Published atomically: `startLifecycle` waits for this file to EXIST and then
// reads it once, so it must never be observable before every byte is there.
writeRecordAtomically(
  path.join(dir, "sidecar.json"),
  JSON.stringify({
    sidecarPid: process.pid,
    grandchildPid: grandchild.pid,
    shellJobName,
    backendJob: backendJobStatus(),
  }),
);

await grandchild.exited;
