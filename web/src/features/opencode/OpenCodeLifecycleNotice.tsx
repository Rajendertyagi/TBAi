"use client";

import type { ReactNode } from "react";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

/** The visible label stays short; `AgentStatus` truncates longer copy. */
const DEGRADED_LABEL = "Reconciling session";
const CAPACITY_LABEL = "Prompt capacity full";

/**
 * Recoverable lifecycle states, stated plainly beside the composer.
 *
 * Two states are deliberately surfaced here, and both are RECOVERABLE:
 *
 * - `health.degraded` means a lifecycle update could not be applied, so the
 *   facts were rolled back and are being proven again by reconciliation. It is
 *   a consistency repair, not a network or server failure, and the copy says so.
 * - `capacity.backpressure` means the admission registry cannot make room for
 *   a new prompt because every slot is live or protected. It clears as prompts
 *   settle or their owners release protection; nothing has to be retried by
 *   hand.
 *
 * Neither is a terminal error, so neither uses destructive styling. The status
 * row is otherwise owned by the active turn (`OpenCodePrimaryStatus`); this
 * notice adds the one fact the active-turn pill cannot know, and disappears on
 * its own the moment the projection says the state is over.
 */
export function OpenCodeLifecycleNotice() {
  const extras = useOptionalV2RuntimeExtras();
  if (!extras) return null;

  const { health, capacity } = extras.projection;

  if (health.degraded) {
    const announcement = health.recovering
      ? "Reconciling the session after a lifecycle update could not be applied. It will resume automatically."
      : "The session could not be reconciled automatically. Reconnect from the status menu to try again.";
    return (
      <LifecycleRow kind="degraded">
        <AgentStatus
          state="working"
          label={DEGRADED_LABEL}
          className="min-w-0 max-w-full text-muted-foreground shadow-xs"
        />
        <span role="status" className="sr-only">
          {announcement}
        </span>
      </LifecycleRow>
    );
  }

  if (capacity.backpressure) {
    return (
      <LifecycleRow kind="capacity">
        <AgentStatus
          state="waiting"
          label={CAPACITY_LABEL}
          className="min-w-0 max-w-full text-muted-foreground shadow-xs"
        />
        <span role="status" className="sr-only">
          Prompt capacity is full. Waiting for in-flight prompts to finish; this clears
          automatically.
        </span>
      </LifecycleRow>
    );
  }

  return null;
}

function LifecycleRow({ kind, children }: { kind: "degraded" | "capacity"; children: ReactNode }) {
  return (
    <div
      data-lifecycle-notice={kind}
      className="flex min-w-0 max-w-full shrink items-center justify-start"
    >
      {children}
    </div>
  );
}
