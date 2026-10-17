import { startServer, rollbackPartialStartup, handleProcessShutdown } from "./server";
import { getActiveServer } from "./services/server-listener";
import { installDesktopStdinShutdown } from "./services/desktop-stdin";
import { resolveConfiguredPort } from "./services/server-port";
import { installProcessErrorHandlers } from "./services/process-handlers";
import { logger, normalizeError } from "./lib/logger";

// Boot port: explicit PORT env wins, then the persisted setting, then 3000.
// (server-port.ts owns the precedence; the entry point only triggers boot.)
const { port: PORT } = resolveConfiguredPort();

// Process-level safety net (one implementation, in services/process-handlers,
// so the handler tests exercise the production wiring rather than a copy).
// Rationale, runtime evidence and the deliberate counterfactual live there.
installProcessErrorHandlers();

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
  logger.error("server", "startup_failed", { ...normalizeError(err) });
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
