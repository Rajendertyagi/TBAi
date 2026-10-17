/**
 * Child-process fixture for the late-settlement shutdown case (V1/A2).
 *
 * One tracked chat run outlives its settle bound (10 s) and then settles BEFORE
 * the final database-close decision. The spine must report that honestly —
 * `shutdown_deadline_expired`, database closed, exit 0 — and never
 * `shutdown_failed`.
 *
 * ## Why this fixture parks the spine instead of sleeping
 *
 * "The run settled after the bound but before the re-check" is a window of
 * microseconds, so no timer can land in it honestly. The fixture instead parks
 * the spine at its last await before the re-check — the history drain — with a
 * real reconciliation tick held open on the finalizer's own `messageExists`
 * dependency. That turns the ordering into a condition instead of a stopwatch:
 *
 *   1. the spine's `stopChatStreamCleanup()` has already run, so the cleanup
 *      gate closing proves `chatRuns.awaitSettled()` returned — i.e. the bound
 *      already fired with this run still running;
 *   2. the spine is then parked on the tick, before it re-checks outstanding
 *      work and decides whether to close the database.
 *
 * Only after both hold does the fixture settle the run, so the re-check
 * genuinely observes work that settled after its deadline. Every step is
 * production wiring: the real `runShutdown`, the real run registry, the real
 * drains. The only test double is the reconciliation store, whose real methods
 * are synchronous (so nothing else in the tick can be awaited).
 *
 * The control — the same spine with work that NEVER settles — lives in
 * `shutdown-failed-child.ts` and must stay red: exit 1, database left open.
 */
import fs from "node:fs";
import { db } from "../../src/db/index.ts";
import { logger } from "../../src/lib/logger.ts";
import { shutdownServer } from "../../src/server.ts";
import { chatRuns } from "../../src/services/chat-runs.ts";
import {
  getChatStreamCleanupState,
  startChatStreamCleanup,
} from "../../src/services/chat-streams/cleanup.ts";
import {
  chatHistoryReconcilerDeps,
  runHistoryReconciliationOnce,
  startHistoryReconciliation,
} from "../../src/services/chat-streams/historyReconciler.ts";
import { bindBootPort, initListenerFetch } from "../../src/services/server-listener.ts";

const marker = process.env.TBAI_SHUTDOWN_MARKER ?? "";
logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });

// Report DB state at process exit: proves whether the database was closed.
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

// ── The park: one reconciliation tick, held inside its finalizer ────────────

let releasePark!: () => void;
const park = new Promise<void>((resolve) => {
  releasePark = resolve;
});
let signalParked!: () => void;
const parked = new Promise<void>((resolve) => {
  signalParked = resolve;
});

const capturedMessage = JSON.stringify({
  id: "msg_late_settle",
  role: "assistant",
  parts: [{ type: "text", text: "late" }],
});

const deps: typeof chatHistoryReconcilerDeps = {
  ...chatHistoryReconcilerDeps,
  store: {
    listPendingCompletedHistory: () => [
      {
        streamId: "stream_late_settle",
        conversationId: "conv_late",
        finalMessageJson: capturedMessage,
        finalParentId: null,
      },
    ],
    // Synchronous in the real store, exactly as it is here: the claim is the
    // single-winner gate, and this tick is the winner.
    claimHistory: () => true,
    completeHistory: () => true,
    skipHistory: () => true,
    getRunContext: () => ({
      conversationId: "conv_late",
      requestId: null,
      providerId: null,
      modelId: null,
      historyState: "claimed",
      historyMessageId: null,
      historyClaimedAt: null,
    }),
  },
  messageExists: () => {
    signalParked();
    return park.then(() => true);
  },
};

startHistoryReconciliation({ deps, runImmediately: false, graceMs: 0 });
void runHistoryReconciliationOnce();
await parked;

// ── One chat run that cannot settle on its own ──────────────────────────────

// A cleanup timer is running so the spine's progress past its chat bound is
// observable as a state transition: `runShutdown` stops it only after
// `chatRuns.awaitSettled()` returns.
startChatStreamCleanup(db, { intervalMs: 60_000, runImmediately: false });
const run = chatRuns.create({ requestId: "late_settle_run" });

const shutdown = shutdownServer(bound.server, "late-settle");

// The deadline fired (the gate below has closed), and the spine is parked on the
// reconciliation tick before the re-check.
while (getChatStreamCleanupState().running) {
  await Bun.sleep(10);
}

// Late, but before the database-close decision the re-check governs.
chatRuns.markCancelled(run.streamId);
releasePark();

await shutdown;
