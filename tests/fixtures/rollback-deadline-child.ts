/**
 * Child-process fixture for the startup-rollback DEADLINE case (§7).
 *
 * One chat run is registered and never settles, so `rollbackPartialStartup()`'s
 * bounded chat wait must expire with the run still running. The fixture pins the
 * three answers §7 asks for:
 *
 * 1. unsettled at the deadline → `ok: false, dbClosed: false, timedOut: true`
 *    and `server.startup_rollback_failed` on stderr (the caller must exit 1);
 * 2. the bound really expired (elapsed ≈ the 10 s bound), so the case is the
 *    deadline and not an early return;
 * 3. the database is still OPEN for the writer that outlived it: the late run
 *    settles and then performs a real INSERT, which must succeed. That is the
 *    property that makes the rollback's conservative refusal safe — no writer is
 *    ever handed a closed connection.
 *
 * It deliberately differs from normal shutdown, where the same sequence re-checks
 * outstanding work and DOES close the database (see shutdown-escalation.test.ts,
 * "run settles after its bound, before the close decision"). Rollback keeps the
 * fired bound as terminal because it cannot re-check cheaply and startup is
 * aborting anyway; see docs/decisions.md (2026-10-17) for the recorded tradeoff.
 *
 * ## DATA_DIR guard
 *
 * Unlike its siblings this fixture WRITES to the shared database, so a manual run
 * with no DATA_DIR would put a probe table in the developer's real `data/chat.db`.
 * The runtime modules are therefore imported dynamically, after the guard below,
 * because a static import would open the database before any check could run.
 */
if (!process.env.DATA_DIR) {
  console.error(
    "ROLLBACK_FIXTURE_REFUSED: DATA_DIR must be set (tests inherit it from tests/setup.ts)",
  );
  process.exit(3);
}

// Module marker: the runtime imports below are deferred until after the guard
// above, and a file with no static import/export is a script to TypeScript.
export {};

const { db } = await import("../../src/db/index.ts");
const { logger } = await import("../../src/lib/logger.ts");
const { rollbackPartialStartup } = await import("../../src/server.ts");
const { chatRuns } = await import("../../src/services/chat-runs.ts");

logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });

// A run nothing can settle: abortAll() aborts its controller but the terminal
// transition belongs to a route, which does not exist here — so the record stays
// `running` and the bounded wait must expire.
const run = chatRuns.create({ requestId: "rollback_deadline_run" });

const startedAt = Date.now();
const result = await rollbackPartialStartup();
const elapsedMs = Date.now() - startedAt;

// The writer that outlived the deadline: settle it, then write. Both must work
// on the still-open connection.
chatRuns.markCancelled(run.streamId);
let lateWrite = "ok";
try {
  db.query("CREATE TABLE IF NOT EXISTS rollback_deadline_probe (a INTEGER)").run();
  db.query("INSERT INTO rollback_deadline_probe VALUES (1)").run();
} catch (err) {
  lateWrite = err instanceof Error ? err.message : String(err);
}

console.log(
  `ROLLBACK_DEADLINE ${JSON.stringify({
    result,
    elapsedMs,
    lateWrite,
    unsettledAfterSettle: chatRuns.hasUnsettledWork(),
  })}`,
);
