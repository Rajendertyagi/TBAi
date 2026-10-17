/**
 * Child-process fixture for V2: unhandledRejection handler.
 *
 * Installs the PRODUCTION handler (src/services/process-handlers) — the same
 * function src/index.ts calls — then triggers an unhandled promise rejection.
 * The handler must catch it, log `lifecycle.unhandled_rejection`, and exit(1).
 *
 * The parent asserts the exit code and the log line, so a regression in the
 * production handler fails this test.
 */
import { logger } from "../../src/lib/logger.ts";
import { installProcessErrorHandlers } from "../../src/services/process-handlers.ts";

logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });

installProcessErrorHandlers();

// Trigger an unhandled rejection
void Promise.reject(new Error("test-unhandled-rejection"));

// Keep the process alive long enough for the handler to run
await Bun.sleep(5000);
