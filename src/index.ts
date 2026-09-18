import { startServer } from "./server";
import { resolveConfiguredPort } from "./services/server-port";
import { logger, normalizeError } from "./lib/logger";

// Boot port: explicit PORT env wins, then the persisted setting, then 3000.
// (server-port.ts owns the precedence; the entry point only triggers boot.)
const { port: PORT } = resolveConfiguredPort();

startServer(PORT).catch((err) => {
  logger.error("server", "startup_failed", { ...normalizeError(err) });
  process.exitCode = 1;
});
