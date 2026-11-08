/**
 * Child-process fixture for V3b: desktop stdin shutdown with a stuck operation.
 *
 * Mirrors the entry point, then creates a chat run no route owns: abort() has
 * no handler to observe it, so the shutdown spine's bounded await expires with
 * write-capable work still active → shutdown_failed, exit 1, database left
 * open. The parent waits for the ready marker, writes shutdown to stdin, and
 * asserts the failure classification and exit code.
 */
import fs from "node:fs";
import { logger } from "../../src/lib/logger.ts";
import { startServer, handleProcessShutdown } from "../../src/server.ts";
import { getActiveServer } from "../../src/services/server-listener.ts";
import { installDesktopStdinShutdown } from "../../src/services/desktop-stdin.ts";
import { chatRuns } from "../../src/services/chat-runs.ts";

logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });

installDesktopStdinShutdown({
  onShutdown: async () => {
    await handleProcessShutdown(getActiveServer(), "STDIN_SHUTDOWN");
  },
});

const server = await startServer(0);
console.error(`SERVER_PORT=${server.port}`);

// A run no route owns: abort() cannot settle it, so the spine's bounded await
// must expire with write-capable work still active.
chatRuns.create({ requestId: "stdin-timeout-stuck" });

const readyMarker = process.env.TBAI_READY_MARKER ?? "";
if (readyMarker) fs.writeFileSync(readyMarker, "ready");
