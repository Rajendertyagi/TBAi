import { startServer, rollbackPartialStartup, handleProcessShutdown } from "./server";
import { getActiveServer, getInstanceId } from "./services/server-listener";
import { installDesktopStdinShutdown } from "./services/desktop-stdin";
import { resolveConfiguredPort } from "./services/server-port";
import { installProcessErrorHandlers } from "./services/process-handlers";
import {
  installBackendProcessJob,
  joinShellJob,
  ShellJobUnavailableError,
} from "./services/process-ownership";
import { logger, normalizeError } from "./lib/logger";

// Boot port: explicit PORT env wins, then the persisted setting, then 3000.
// (server-port.ts owns the precedence; the entry point only triggers boot.)
const { port: PORT } = resolveConfiguredPort();

// Process-level safety net (one implementation, in services/process-handlers,
// so the handler tests exercise the production wiring rather than a copy).
// Rationale, runtime evidence and the deliberate counterfactual live there.
installProcessErrorHandlers();

// OS-enforced lifecycle (G2, Windows). The backend job must exist before any
// child can spawn; it is what takes OpenCode and MCP children with the sidecar
// on a hard kill. When Tauri supplied a shell-job name, join it before any boot
// work: a missing job means the shell already died, and an unprotected sidecar
// must exit rather than keep running.
installBackendProcessJob();
const shellJobName = process.env.TBAI_SHELL_JOB_NAME?.trim();
if (shellJobName) {
  try {
    joinShellJob(shellJobName);
    logger.info("process", "shell_job_joined", { shellJobName });
  } catch (err) {
    logger.error("process", "shell_job_join_failed", {
      shellJobName,
      ...normalizeError(err),
      expected: err instanceof ShellJobUnavailableError,
    });
    process.exit(1);
  }
}

// Desktop stdin shutdown: Tauri writes {"type":"shutdown"}\n to the sidecar's
// stdin. The reader (owned by services/desktop-stdin) invokes the canonical
// spine for the CURRENT listener — resolved lazily, so a port restart is
// honored. EOF is NOT a shutdown trigger (it can occur on a Tauri crash).
installDesktopStdinShutdown({
  onShutdown: async () => {
    await handleProcessShutdown(getActiveServer(), "STDIN_SHUTDOWN");
  },
});

startServer(PORT).catch((err) => {
  // `instanceId` attributes this failure to THIS process. Several launches can
  // share one log file, so a reader must not infer that a failure belongs to
  // the process it happens to be observing.
  logger.error("server", "startup_failed", {
    ...normalizeError(err),
    instanceId: getInstanceId(),
  });
  void rollbackPartialStartup().then(
    (result) => {
      if (result.ok) {
        process.exitCode = 1;
      } else {
        // Terminal failure: unsafe work may remain — exit explicitly so no
        // application task can touch the database after this point.
        process.exit(1);
      }
    },
    (rollbackErr) => {
      logger.error("server", "startup_rollback_failed", { ...normalizeError(rollbackErr) });
      process.exit(1);
    },
  );
});
