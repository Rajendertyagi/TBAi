/**
 * Child-process fixture for V3d: EOF on stdin is NOT a shutdown trigger.
 *
 * Mirrors the entry point, then waits. The parent waits for the ready marker,
 * closes stdin WITHOUT sending a shutdown command, and asserts the process is
 * still alive — EOF must be ignored because it can occur during normal
 * operation (e.g. a Tauri crash).
 */
import fs from "node:fs";
import { logger } from "../../src/lib/logger.ts";
import { startServer, shutdownServer } from "../../src/server.ts";
import { getActiveServer } from "../../src/services/server-listener.ts";
import { installDesktopStdinShutdown } from "../../src/services/desktop-stdin.ts";

logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });

installDesktopStdinShutdown({
  onShutdown: () => {
    const server = getActiveServer();
    if (server) void shutdownServer(server, "STDIN_SHUTDOWN");
  },
});

const server = await startServer(0);
console.error(`SERVER_PORT=${server.port}`);

const readyMarker = process.env.TBAI_READY_MARKER ?? "";
if (readyMarker) fs.writeFileSync(readyMarker, "ready");
