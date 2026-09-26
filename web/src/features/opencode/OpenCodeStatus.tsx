"use client";

import { useEffect, useState } from "react";
import { HeartCrack, HeartHandshake, HeartOff, HeartPulse } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

type HeartState = "error" | "off" | "working" | "idle";
const HEARTS: Record<HeartState, { Icon: typeof HeartHandshake; className: string; label: string }> = {
  error: { Icon: HeartCrack, className: "text-destructive", label: "Error" },
  off: { Icon: HeartOff, className: "text-muted-foreground/60", label: "Disconnected" },
  working: { Icon: HeartPulse, className: "text-amber-500 animate-pulse", label: "Working" },
  idle: { Icon: HeartHandshake, className: "text-muted-foreground", label: "Connected" },
};

/** Heart-chip status for the native Code runtime. */
export function OpenCodeStatus({ compact = false, onReconnect }: { compact?: boolean; onReconnect?: () => void }) {
  const extras = useOptionalV2RuntimeExtras();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (armed && extras?.state.load.type !== "loading" && extras?.state.load.type !== "reconciling") setArmed(false);
  }, [armed, extras?.state.load.type]);
  if (!extras) return null;
  const { state } = extras;
  const loadState = state.load.type;
  const runState = state.execution.type;
  const reconnecting = armed && (loadState === "loading" || loadState === "reconciling");
  let heart: HeartState = "idle";
  if (state.load.type === "error" || state.execution.type === "error" || state.revertRecovery.type === "blocked") heart = "error";
  else if (state.connection.type !== "connected" || runState === "cancelling") heart = "off";
  else if (loadState === "loading" || loadState === "reconciling" || runState === "streaming" || runState === "executing") heart = "working";
  const { Icon, className, label } = HEARTS[heart];
  const recoveryBlocked = state.revertRecovery.type === "blocked";
  const errorDetail = state.load.type === "error" ? state.load.error.message : state.execution.type === "error" ? state.execution.error.message : recoveryBlocked ? state.revertRecovery.error.message : null;
  const retry = () => {
    if (recoveryBlocked) void extras.reconcileStagedRevert();
    else { onReconnect?.(); setArmed(true); }
  };
  const heartNode = <Popover>
    <PopoverTrigger asChild><button type="button" aria-label={`OpenCode status: ${label}`} className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Icon aria-hidden="true" className={cn("size-3.5", className)} /></button></PopoverTrigger>
    <PopoverContent align="start">
      <div className="flex items-center gap-2"><Icon aria-hidden="true" className={cn("size-3.5", className)} /><span className="text-sm font-medium">{label}</span></div>
      <dl className="mt-2 space-y-1.5"><div><dt className="text-xs text-muted-foreground">Working directory</dt><dd className="break-all font-mono text-xs">{state.session?.location.directory ?? "–"}</dd></div><div><dt className="text-xs text-muted-foreground">Session id</dt><dd className="break-all font-mono text-xs">{state.session?.id ?? extras.sessionId}</dd></div></dl>
      {errorDetail && <p role="alert" className="mt-2 text-xs text-destructive">{errorDetail}</p>}
      <Button type="button" size="sm" variant="outline" className="mt-3" disabled={!recoveryBlocked && (onReconnect == null || state.connection.type === "closed")} onClick={retry}>{reconnecting ? "Reconnecting…" : recoveryBlocked ? "Retry recovery" : "Reconnect"}</Button>
    </PopoverContent>
  </Popover>;
  return compact ? heartNode : <div className="flex items-center px-3 py-1">{heartNode}</div>;
}
