"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { OPENCODE_RECOVERY_NOTICE_MS } from "./config";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

/** The pill's own label; the full sentence is announced, not truncated here. */
const VISIBLE_LABEL = "Session restored";

/**
 * The verified session-restoration notice, presented on the vendored
 * `AgentStatus` element (S5).
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
 * ## Why the visible label is short and the sentence is announced
 *
 * `AgentStatus` truncates its label at `max-w-44`, so the old full sentence
 * would have been silently cut. The pill therefore shows only "Session
 * restored"; the confirmed detail lives in a polite live region beside it, so
 * assistive technology receives the whole message exactly once. The label is
 * deliberately not the active-turn wording — the primary status owns that.
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
 * ## Dismissal
 *
 * The dismiss control is supplied through `AgentStatus`'s `trailing` slot, which
 * is exposed to assistive technology for caller-supplied nodes (the default
 * decorative icons stay hidden). Dismissal is component-local and keyed by
 * `sessionId`, so a remount (an ordinary navigation) can show it again. That is
 * the documented product decision, not a bug.
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

  let announcement: string;
  if (activity === "running") {
    announcement = queued
      ? "Previous session restored — a run is still in progress, and a prompt is waiting to run."
      : "Previous session restored — a run is still in progress.";
  } else if (queued) {
    announcement = "Previous session restored — a prompt is waiting to run.";
  } else {
    announcement = "Previous session restored.";
  }

  return (
    // A flex item of the composer's reserved status row. `min-w-0`/`shrink`
    // let it clamp (and its label truncate) rather than overflow when it shares
    // a narrow row with the primary pill.
    <div
      data-restoration-notice
      className="flex min-w-0 max-w-full shrink items-center justify-start"
    >
      <AgentStatus
        state={activity === "running" ? "working" : "done"}
        label={VISIBLE_LABEL}
        trailing={
          <button
            type="button"
            aria-label="Dismiss session notice"
            className="flex size-5 items-center justify-center rounded-full p-0.5 text-muted-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setHiddenFor(sessionId)}
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        }
        className="min-w-0 max-w-full text-muted-foreground shadow-xs animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200 motion-reduce:animate-none"
      />
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
