"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

/**
 * Queued prompt controls for the native OpenCode runtime.
 *
 * Shows prompts that are admitted/queued but not yet the active execution,
 * with a cancel affordance that targets only that queued inbox item.
 */
export function OpenCodeQueuedPrompts() {
  const extras = useOptionalV2RuntimeExtras();
  if (!extras) return null;
  const actions = extras.projection.queuedPromptActions;
  if (actions.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5" data-slot="opencode-queued-prompts">
      {actions.map((action) => {
        const busy =
          action.state === "requested" ||
          action.state === "dispatching" ||
          action.state === "pending-confirmation";
        const terminal =
          action.state === "confirmed" ||
          action.state === "failed" ||
          action.state === "superseded" ||
          action.state === "unavailable";
        const label =
          action.state === "confirmed"
            ? "Queued prompt cancelled"
            : action.state === "failed"
              ? "Queued prompt cancel failed"
              : action.state === "superseded"
                ? "Queued prompt cancel superseded"
                : action.state === "unknown"
                  ? "Queued prompt cancel status unknown"
                  : "Queued prompt";
        return (
          <div
            key={action.promptId}
            className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-muted/30 px-2.5 py-1.5 text-xs"
          >
            <span className="min-w-0 truncate text-muted-foreground">{label}</span>
            {!terminal ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="h-6 shrink-0 gap-1 text-2xs"
                disabled={busy}
                onClick={() => void extras.cancelQueuedPrompt(action.promptId)}
                aria-label={`Cancel queued prompt ${action.promptId}`}
                title={action.disabledReason ?? "Cancel queued prompt"}
              >
                <X className="size-3" />
                {busy ? "Cancelling…" : "Cancel"}
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
