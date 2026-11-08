/**
 * Child-process fixture for V2d: handler that does NOT exit (counterfactual).
 *
 * This fixture deliberately does NOT use src/services/process-handlers. It
 * installs a logging-only unhandledRejection handler — with no process.exit —
 * to demonstrate the runtime behaviour that production module exists to
 * correct: Bun keeps the process running in an undefined state instead of
 * crashing. The parent asserts the process is still alive after a bound, then
 * kills it.
 *
 * The handler body mirrors the production one minus the exit, because a
 * counterfactual must differ from the implementation under test; it is not a
 * duplicate of production logic.
 */
import { logger, normalizeError } from "../../src/lib/logger.ts";

logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });

// Install a handler that logs but does NOT exit
process.on("unhandledRejection", (reason) => {
  logger.error("lifecycle", "unhandled_rejection", { ...normalizeError(reason) });
  // Deliberately NO process.exit(1) — the process must continue
});

// Trigger an unhandled rejection
void Promise.reject(new Error("no-exit-test"));

// Keep the process alive — if the handler doesn't exit, we stay running
await Bun.sleep(10000);
console.error("NO_EXIT_HANDLER_DONE");
