"use client";

import { useEffect, useState } from "react";
import {
  useOpenCodeSession,
  useOpenCodeThreadState,
} from "@assistant-ui/react-opencode";
import {
  HeartCrack,
  HeartHandshake,
  HeartOff,
  HeartPulse,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type HeartState = "error" | "off" | "working" | "idle";

interface HeartVisual {
  Icon: typeof HeartHandshake;
  className: string;
  label: string;
}

const HEARTS: Record<HeartState, HeartVisual> = {
  error: {
    Icon: HeartCrack,
    className: "text-destructive",
    label: "Error",
  },
  off: {
    Icon: HeartOff,
    className: "text-muted-foreground/60",
    label: "Disconnected",
  },
  working: {
    Icon: HeartPulse,
    className: "text-amber-500 animate-pulse",
    label: "Working",
  },
  idle: {
    Icon: HeartHandshake,
    className: "text-muted-foreground",
    label: "Connected",
  },
};

/**
 * OpenCode session directory from the attached session record.
 * Reads the V2 `location.directory` first, then the top-level `directory
 * the 1.18.x server reports — the same two shapes `ensureOpenCodeSession`
 * already handles. Never throws on unexpected shapes.
 */
function sessionDirectory(session: unknown): string | null {
  if (session == null || typeof session !== "object") return null;
  const record = session as {
    directory?: unknown;
    location?: { directory?: unknown } | null;
  };
  const scoped =
    record.location != null && typeof record.location === "object"
      ? record.location.directory
      : undefined;
  const dir = typeof scoped === "string" ? scoped : record.directory;
  return typeof dir === "string" && dir.length > 0 ? dir : null;
}

/**
 * Heart-chip connection status for Code mode. A presentation of existing
 * OpenCode runtime/session state — no new endpoints, stores, or connections.
 *
 * Precedence (exact): error → no session/detached/cancelling → streaming or
 * loading → idle + attached. Mounts inside the OpenCode runtime provider, but
 * the extras read is still guarded the same way `useToolLinkedQuestion`
 * guards it, so a temporarily unavailable runtime degrades to a disabled
 * control instead of crashing the view.
 *
 * `compact` renders just the heart button + popover (no row container) for
 * inline placement, e.g. the composer folder row in Code mode.
 *
 * `onReconnect` re-establishes the event connection for the same session
 * (fresh subscription + normal hydration/reconcile). It is deliberately NOT
 * the history `refresh()` — reconnecting is a transport lifecycle action
 * with its own pending state, tracked here with plain component state.
 */
export function OpenCodeStatus({
  compact = false,
  onReconnect,
}: {
  compact?: boolean;
  onReconnect?: () => void;
}) {
  const session = useOpenCodeSession();
  const state = useOpenCodeThreadState();

  const runState = state.runState.type;
  const loadState = state.loadState.type;

  // Reconnect progress: armed on click, confirmed once the fresh load cycle
  // has been observed settling. Derived from the real loadState, so a failed
  // reconnect surfaces as the error heart instead of a stuck spinner.
  const [armed, setArmed] = useState(false);
  const [sawLoading, setSawLoading] = useState(false);
  useEffect(() => {
    if (!armed) return;
    if (loadState === "loading") {
      setSawLoading(true);
    } else if (sawLoading) {
      setArmed(false);
      setSawLoading(false);
    }
  }, [armed, sawLoading, loadState]);
  const reconnecting = armed && (loadState === "loading" || !sawLoading);

  let heart: HeartState = "idle";
  if (runState === "error" || loadState === "error") {
    heart = "error";
  } else if (session == null || runState === "cancelling") {
    heart = "off";
  } else if (runState === "streaming" || loadState === "loading") {
    heart = "working";
  }

  const { Icon, className, label } = HEARTS[heart];
  const directory = sessionDirectory(session);
  const sessionId =
    typeof session?.id === "string" && session.id.length > 0
      ? session.id
      : null;
  const errorDetail =
    heart === "error" && runState === "error"
      ? String(
          (state.runState as { error?: unknown }).error ?? "Unknown error",
        )
      : null;
  const reconnectDisabled =
    onReconnect == null || session == null || reconnecting;

  const heartNode = (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`OpenCode status: ${label}`}
          className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon aria-hidden="true" className={cn("size-3.5", className)} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <div className="flex items-center gap-2">
          <Icon aria-hidden="true" className={cn("size-3.5", className)} />
          <span className="text-sm font-medium">{label}</span>
        </div>
        <dl className="mt-2 space-y-1.5">
          <div>
            <dt className="text-xs text-muted-foreground">
              Working directory
            </dt>
            <dd className="break-all font-mono text-xs">
              {directory ?? (
                <span className="text-muted-foreground/60">–</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Session id</dt>
            <dd className="break-all font-mono text-xs">
              {sessionId ?? (
                <span className="text-muted-foreground/60">–</span>
              )}
            </dd>
          </div>
        </dl>
        {errorDetail != null && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {errorDetail}
          </p>
        )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={reconnectDisabled}
            onClick={() => {
              if (reconnectDisabled) return;
              onReconnect?.();
              setArmed(true);
              setSawLoading(false);
            }}
          >
            {reconnecting ? "Reconnecting…" : "Reconnect"}
          </Button>
      </PopoverContent>
    </Popover>
  );

  if (compact) return heartNode;
  return <div className="flex items-center px-3 py-1">{heartNode}</div>;
}
