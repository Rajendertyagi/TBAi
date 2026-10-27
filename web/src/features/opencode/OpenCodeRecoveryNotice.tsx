"use client";

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { paper } from "@/components/assistant-ui/elements/surfaces";
import { OPENCODE_RECOVERY_NOTICE_MS } from "./config";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

/**
 * The verified session-restoration notice.
 *
 * ## What it is, and what it deliberately is not
 *
 * `reusedExistingSession` is set by the backend only when it verified and
 * adopted an existing live session. That is a REUSE fact: an ordinary
 * navigation back to a conversation looks exactly like a relaunch, and neither
 * proves a crash or a restart. So this notice appears on every verified reuse,
 * is not narrowed by a boot id or a crash heuristic, and its copy never says
 * "recovered", "restarted", or "reopened".
 *
 * ## Activity and queue are separate evidence
 *
 * A confirmed `running` activity means THIS OpenCode process owns a drain. A
 * confirmed queued user prompt means the server's inbox (a `current` read) has
 * a `queue` row. `unavailable` is a failed read, so it never confirms a queue
 * even when stale records remain in the client. `unknown` activity never
 * becomes "not running" — the notice simply says less.
 *
 * A live retry does NOT suppress this notice. Both may be visible; the retry
 * banner is closer to the composer.
 *
 * Dismissal is component-local and keyed by `sessionId`, so a remount (an
 * ordinary navigation) can show it again. That is the documented product
 * decision, not a bug.
 */
export function OpenCodeRecoveryNotice({
  reusedExistingSession,
  sessionId,
}: {
  reusedExistingSession: boolean;
  sessionId: string;
}) {
  const extras = useOptionalV2RuntimeExtras();
  // The id the reader dismissed (or that timed out). Comparing it with the
  // current session id makes a new session — or a fresh mount — show the notice
  // again without persisting anything.
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);

  useEffect(() => {
    if (!reusedExistingSession) return;
    const timer = setTimeout(() => setHiddenFor(sessionId), OPENCODE_RECOVERY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [reusedExistingSession, sessionId]);

  if (!reusedExistingSession || hiddenFor === sessionId) return null;

  const state = extras?.state;
  // A failed inbox read is not an authoritative empty queue and is not a
  // confirmed queue either.
  const queued =
    state?.auxiliary.inbox === "current" &&
    Object.values(state.inboxById).some(
      (record) => record.type === "user" && record.delivery === "queue",
    );
  const activity = state?.activity ?? "unknown";

  let message: string;
  if (activity === "running") {
    message = queued
      ? "Previous session restored — a run is still in progress, and a prompt is waiting to run."
      : "Previous session restored — a run is still in progress.";
  } else if (queued) {
    message = "Previous session restored — a prompt is waiting to run.";
  } else {
    message = "Previous session restored.";
  }

  return (
    <div
      role="status"
      data-slot="agent-status"
      className={cn(
        paper,
        "inline-flex items-center gap-2 rounded-full py-1 ps-3.5 pe-1.5 text-xs text-muted-foreground shadow-xs animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200 motion-reduce:animate-none",
      )}
    >
      {activity === "running" ? (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full animate-pulse bg-blue-500 dark:bg-blue-400 motion-reduce:animate-none"
        />
      ) : (
        <Check aria-hidden="true" className="size-3 shrink-0 text-emerald-500" />
      )}
      <span>{message}</span>
      <button
        type="button"
        aria-label="Dismiss session notice"
        className="flex size-5 items-center justify-center rounded-full p-0.5 text-muted-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setHiddenFor(sessionId)}
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </div>
  );
}
