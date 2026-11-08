/**
 * Child-process fixture for V3a: desktop stdin shutdown (graceful).
 *
 * Mirrors the entry point exactly: install the stdin reader BEFORE boot, then
 * start the server. The parent waits for the ready marker, writes
 * {"type":"shutdown"} to this process's stdin, and the reader invokes
 * shutdownServer("STDIN_SHUTDOWN"). The parent asserts exit code 0 and the
 * shutdown_complete log line.
 *
 * No artificial sleep: the listening server is the only unref'd-free handle,
 * so once the spine stops it (and the parent closes stdin), the process exits
 * on its own with the code the spine set.
 */
import fs from "node:fs";
import { logger } from "../../src/lib/logger.ts";
import { startServer, handleProcessShutdown } from "../../src/server.ts";
import { getActiveServer } from "../../src/services/server-listener.ts";
import { installDesktopStdinShutdown } from "../../src/services/desktop-stdin.ts";

logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });

installDesktopStdinShutdown({
  onShutdown: async () => {
    await handleProcessShutdown(getActiveServer(), "STDIN_SHUTDOWN");
  },
});

const server = await startServer(0);
console.error(`SERVER_PORT=${server.port}`);

const readyMarker = process.env.TBAI_READY_MARKER ?? "";
if (readyMarker) fs.writeFileSync(readyMarker, "ready");
