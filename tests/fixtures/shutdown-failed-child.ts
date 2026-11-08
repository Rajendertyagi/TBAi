/**
 * Child-process fixture for the shutdown escalation test.
 *
 * Binds a listener, creates a chat run no route owns, and runs the real
 * shutdown spine. The run can never settle (abort() has no route handler to
 * observe it), so the spine's bounded await must expire with work still
 * active: shutdown_failed, no db.close(), process.exit(1).
 *
 * The parent asserts the exit code, the log line, and — via the exit hook
 * below — that the database was still usable at process termination.
 */
import fs from "node:fs";
import { chatRuns } from "../../src/services/chat-runs.ts";
import { shutdownServer } from "../../src/server.ts";
import { initListenerFetch, bindBootPort } from "../../src/services/server-listener.ts";
import { db } from "../../src/db/index.ts";
import { logger } from "../../src/lib/logger.ts";

const marker = process.env.TBAI_SHUTDOWN_MARKER ?? "";
logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });

// Report DB state at process exit: proves the database was left open.
process.once("exit", () => {
  if (!marker) return;
  try {
    db.query("SELECT 1").get();
    fs.writeFileSync(marker, "open");
  } catch {
    fs.writeFileSync(marker, "closed");
  }
});

initListenerFetch(() => new Response("ok"));
const bound = bindBootPort(0);
// A run no route owns: abort() cannot settle it, so the spine's bounded
// await must expire with work still active.
chatRuns.create({ requestId: "stuck-child-run" });
const result = await shutdownServer(bound.server, "test-failed-path");
process.exit(result.exitCode);
