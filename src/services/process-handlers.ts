/**
 * Process-level error handlers (single owner).
 *
 * The entry point installs these before anything else runs, and no other module
 * registers a process-level rejection or exception handler — so the tests that
 * exercise them exercise the production implementation rather than a copy.
 *
 * Installed Bun (1.4.3) does NOT crash by default on an unhandled rejection or
 * an uncaught exception once a handler is installed: the handler runs and the
 * process continues with exit code 0 unless the handler explicitly exits. Both
 * handlers therefore log a structured `lifecycle.*` line and then exit
 * non-zero, so a process-integrity failure is neither silently swallowed nor
 * left running in an undefined state.
 *
 * Locally contained, intentionally handled errors (trackRun `.catch`,
 * chat-runs, MCP `allSettled`) never reach these handlers.
 *
 * `tests/fixtures/no-exit-handler-child.ts` is the deliberate counterfactual:
 * it installs its own logging-only handler to demonstrate the runtime behaviour
 * this module exists to correct, and therefore must NOT call this module.
 */
import { logger, normalizeError } from "../lib/logger";

/**
 * Register the process-integrity handlers: log the failure and exit non-zero.
 * Call once, from the entry point, before boot work starts. Returns nothing.
 */
export function installProcessErrorHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    logger.error("lifecycle", "unhandled_rejection", { ...normalizeError(reason) });
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    logger.error("lifecycle", "uncaught_exception", { ...normalizeError(err) });
    process.exit(1);
  });
}
