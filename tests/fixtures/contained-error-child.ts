/**
 * Child-process fixture for V2c: locally contained error.
 *
 * Installs the PRODUCTION handler (src/services/process-handlers) — the same
 * function src/index.ts calls — then creates a promise that IS caught before it
 * can become an unhandled rejection. The handler must NOT fire. Exit 0.
 *
 * The parent asserts the exit code is 0 and the handler did not log, so a
 * production handler that fired on contained errors would fail this test.
 */
import { logger } from "../../src/lib/logger.ts";
import { installProcessErrorHandlers } from "../../src/services/process-handlers.ts";

logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });

installProcessErrorHandlers();

// Create a promise that is caught — never becomes unhandled
const p = Promise.reject(new Error("contained-error"));
p.catch(() => {
  /* locally contained: the installed handler must NOT fire */
});

// Keep the process alive long enough for any erroneous handler to fire
await Bun.sleep(2000);
console.error("CONTAINED_ERROR_DONE");
