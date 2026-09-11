import { startServer } from "./server";
import { logger, normalizeError } from "./lib/logger";

const PORT = parseInt(process.env.PORT || "3000", 10);

startServer(PORT).catch((err) => {
  logger.error("server", "startup_failed", { ...normalizeError(err) });
  process.exitCode = 1;
});
