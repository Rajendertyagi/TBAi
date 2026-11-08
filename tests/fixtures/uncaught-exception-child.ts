/**
 * Child-process fixture for V2: uncaughtException handler.
 *
 * Installs the PRODUCTION handler (src/services/process-handlers) — the same
 * function src/index.ts calls — then triggers an uncaught exception. The handler
 * must catch it, log `lifecycle.uncaught_exception`, and exit(1).
 *
 * The parent asserts the exit code and the log line, so a regression in the
 * production handler fails this test.
 */
import { logger } from "../../src/lib/logger.ts";
import { installProcessErrorHandlers } from "../../src/services/process-handlers.ts";

logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });

installProcessErrorHandlers();

// Trigger an uncaught exception
throw new Error("test-uncaught-exception");
