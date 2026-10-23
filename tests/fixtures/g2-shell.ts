/**
 * Stand-in for the Rust desktop shell in the G2 lifecycle test.
 *
 * It creates the SAME named, kill-on-close job the Rust shell creates, spawns a
 * sidecar with that job's name, and deliberately spawns it `detached: true` so
 * Bun's implicit parent-lifetime binding cannot stand in for the named job. That
 * makes the negative case meaningful: with no shell-job join, the sidecar
 * survives a hard shell kill.
 */
import fs from "node:fs";
import path from "node:path";

import { createShellJob } from "../../src/services/process-ownership.ts";

const dir = process.env.TBAI_G2_DIR;
if (!dir) {
  console.error("G2_SHELL_REFUSED: TBAI_G2_DIR is required");
  process.exit(2);
}

const job = createShellJob();
const sidecarScript = process.env.TBAI_G2_SIDECAR ?? path.join(import.meta.dir, "g2-sidecar.ts");
const sidecar = Bun.spawn(["bun", sidecarScript], {
  cwd: import.meta.dir,
  env: {
    ...process.env,
    TBAI_SHELL_JOB_NAME: job.name,
  },
  detached: true,
  stdout: "pipe",
  stderr: "pipe",
});

fs.writeFileSync(
  path.join(dir, "shell.json"),
  JSON.stringify({ shellPid: process.pid, sidecarPid: sidecar.pid, jobName: job.name }),
);

// Keep the only handle open until the test kills the shell. Do not call
// `job.close()` here: that would be a graceful stop, not the crash path.
await sidecar.exited;
