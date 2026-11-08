"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { WAITING_FOR_APPROVAL, activityFromParts } from "@/lib/assistantActivityParts";
import { OPENCODE_RETRY_TICK_MS, formatRetryCountdown } from "./config";
import { isConnectionHealthy } from "./statusView";
import { opencodeToolActivityLabel } from "./toolActivityLabel";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

const STOPPING = "Stopping…";

/**
 * The Code-mode primary status: the one surface that presents the ACTIVE TURN.
 *
 * ## What it owns
 *
 * Cancellation ("Stopping…"), the live engine retry countdown, approval
 * waiting, the running tool, and thinking. The connection heart
 * (`OpenCodeStatus`) owns transport/recovery health only, so the two never
 * report the same fact — the health predicate below is the same one the heart
 * uses, which is what makes "the heart is idle" and "the primary may present"
 * one decision instead of two that can drift.
 *
 * ## Precedence on a healthy connection
 *
 * cancelling > engine retry > approval waiting > running tool > thinking.
 *
 * ## Why the approval row reads `extras.permissions`
 *
 * OpenCode permissions are `ApprovalCard`s driven by the runtime's pending
 * permission list. The projection carries no `requires-action` tool-part
 * status, so the list is the only confirmation that a permission is still
 * outstanding. This row is a status line BESIDE those cards — never a second
 * approval control.
 *
 * ## Why the retry row has its own announcer
 *
 * `AgentStatus` has no live region, and its label changes every repaint. A
 * polite announcement per ATTEMPT therefore comes from the sr-only
 * `role="status"` node; the visible countdown is `aria-hidden`, so a screen
 * reader hears "Retrying, attempt 2" once rather than every tick. The
 * countdown is derived from the server's absolute deadline: when it is missing
 * or already passed the copy says "Retrying" with no number, because a
 * fabricated second is worse than no second.
 */
export function OpenCodePrimaryStatus() {
  const extras = useOptionalV2RuntimeExtras();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const lastMessage = useAuiState((state) => state.thread.messages.at(-1));

  const retry = extras?.state.retry ?? null;
  const next = retry?.next ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (next === null) return;
    // Repaint immediately on a new deadline, then follow the tick. The
    // interval exists only while a trustworthy deadline does.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), OPENCODE_RETRY_TICK_MS);
    return () => clearInterval(timer);
  }, [next]);

  if (extras === null) return null;

  const state = extras.state;
  if (
    !isConnectionHealthy({
      connection: state.connection,
      load: state.load,
      recoveryBlocked: state.revertRecovery.type === "blocked",
    })
  ) {
    return null;
  }

  if (state.execution.type === "cancelling") {
    return (
      <PrimaryRow>
        <AgentStatus
          data-primary-status
          state="working"
          label={STOPPING}
          className="min-w-0 max-w-full"
        />
      </PrimaryRow>
    );
  }

  if (retry) {
    const remaining = next === null ? null : Math.max(0, Math.ceil((next - now) / 1000));
    const countdown =
      remaining !== null && remaining > 0
        ? `Retrying in ${formatRetryCountdown(remaining)}`
        : "Retrying";
    return (
      <PrimaryRow>
        <span role="status" className="sr-only">
          Retrying, attempt {retry.attempt}
        </span>
        <AgentStatus
          data-primary-status
          aria-hidden="true"
          state="working"
          label={`${countdown} (attempt ${retry.attempt})`}
          className="min-w-0 max-w-full"
        />
      </PrimaryRow>
    );
  }

  if (extras.permissions.length > 0) {
    return (
      <PrimaryRow>
        <AgentStatus
          data-primary-status
          state="waiting"
          label={WAITING_FOR_APPROVAL}
          className="min-w-0 max-w-full"
        />
      </PrimaryRow>
    );
  }

  const activity =
    isRunning && lastMessage?.role === "assistant"
      ? activityFromParts(lastMessage.content, opencodeToolActivityLabel)
      : null;
  if (activity === null) return null;

  return (
    <PrimaryRow>
      <AgentStatus
        data-primary-status
        state={activity.state}
        label={activity.label}
        className="min-w-0 max-w-full"
      />
    </PrimaryRow>
  );
}

/**
 * A pill row that behaves as one flex item of the composer's reserved status
 * row: it may clamp and shrink instead of overflowing when it shares a narrow
 * row with the restoration notice.
 */
function PrimaryRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 max-w-full shrink items-center justify-start">{children}</div>
  );
}
