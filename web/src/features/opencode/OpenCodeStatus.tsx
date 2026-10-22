"use client";

import { HeartCrack, HeartHandshake, HeartOff, HeartPulse } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { OPENCODE_V2_MAX_RECONNECT_ATTEMPTS } from "./config";
import { pendingSetNotice } from "./auxiliaryNotice";
import { statusView, type StatusPresentation } from "./statusView";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

const HEARTS: Record<StatusPresentation, { Icon: typeof HeartHandshake; className: string }> = {
  error: { Icon: HeartCrack, className: "text-destructive" },
  off: { Icon: HeartOff, className: "text-muted-foreground/60" },
  working: { Icon: HeartPulse, className: "text-amber-500 animate-pulse" },
  idle: { Icon: HeartHandshake, className: "text-muted-foreground" },
};

/** Heart-chip status for the native Code runtime. */
export function OpenCodeStatus({
  compact = false,
  onReconnect,
}: {
  compact?: boolean;
  onReconnect?: () => void;
}) {
  const extras = useOptionalV2RuntimeExtras();
  if (!extras) return null;
  const { state } = extras;
  const recoveryBlocked = state.revertRecovery.type === "blocked";
  // The RUNTIME's connection state is the fact: it is set by the component
  // that schedules the retry, and it carries the attempt number. A local
  // "the reader pressed Reconnect" flag cannot tell an automatic reconnect
  // from a terminal failure, and the runtime sets `load: error` while it waits
  // for its next attempt - which is why the old chip showed a red Error for a
  // reconnect that was about to succeed.
  const view = statusView({
    connection: state.connection,
    load: state.load,
    running: state.execution.type === "streaming" || state.execution.type === "executing",
    cancelled: state.execution.type === "cancelling",
    recoveryBlocked,
    maxAttempts: OPENCODE_V2_MAX_RECONNECT_ATTEMPTS,
  });
  const { Icon, className } = HEARTS[view.presentation];
  const errorDetail =
    state.load.type === "error"
      ? state.load.error.message
      : state.execution.type === "error"
        ? state.execution.error.message
        : recoveryBlocked
          ? state.revertRecovery.error.message
          : null;
  const retry = () => {
    if (recoveryBlocked) void extras.reconcileStagedRevert();
    // The controller's own `retry()` is the manual recovery path: it replaces
    // the failed attempt and starts a fresh one, even after the automatic
    // budget is spent. The `onReconnect` prop is the heavier fallback that
    // rebuilds the whole client, and it stays for the case where there is no
    // controller to ask.
    else if (onReconnect) onReconnect();
    else void extras.retry();
  };
  // Only once the load is ready: before the first read finishes, "unavailable"
  // means "not read yet", which is the loading state and not news.
  const pendingNotice = state.load.type === "ready" ? pendingSetNotice(state.auxiliary) : null;
  const heartNode = (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`OpenCode status: ${view.label}`}
          className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon aria-hidden="true" className={cn("size-3.5", className)} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <div className="flex items-center gap-2">
          <Icon aria-hidden="true" className={cn("size-3.5", className)} />
          <span className="text-sm font-medium">{view.label}</span>
        </div>
        <dl className="mt-2 space-y-1.5">
          <div>
            <dt className="text-xs text-muted-foreground">Working directory</dt>
            <dd className="break-all font-mono text-xs">
              {state.session?.location.directory ?? "–"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Session id</dt>
            <dd className="break-all font-mono text-xs">{state.session?.id ?? extras.sessionId}</dd>
          </div>
        </dl>
        {pendingNotice && <p className="mt-2 text-xs text-muted-foreground">{pendingNotice}</p>}
        {errorDetail && !view.failed && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {errorDetail}
          </p>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-3"
          disabled={!recoveryBlocked && state.connection.type === "closed"}
          onClick={retry}
        >
          {recoveryBlocked ? "Retry recovery" : "Reconnect"}
        </Button>
      </PopoverContent>
    </Popover>
  );
  return compact ? heartNode : <div className="flex items-center px-3 py-1">{heartNode}</div>;
}
