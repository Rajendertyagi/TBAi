import { useMemo, useSyncExternalStore } from "react";
import { useAui } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { sidebarConfig } from "@/config/sidebar";

/**
 * Live generation indicator for a sidebar conversation row.
 *
 * Derived from assistant-ui runtime state (`threadListItem.isRunning`) —
 * never persisted. A conversation's persistent status is binary
 * (regular/archived); whether it is generating right now is runtime
 * activity and must not touch the database.
 */
export function useThreadListItemRunning(remoteId: string): boolean {
  const aui = useAui();
  // The item runtime (when bound) notifies on run-state changes; the public
  // methods snapshot carries `isRunning`. Both are vendor API; either may be
  // absent for unknown ids, in which case the thread reads as not running.
  const runtime = useMemo(() => {
    try {
      const items = aui.threads.getState().threadItems;
      const match =
        items.find((t) => t.remoteId === remoteId) ??
        items.find((t) => t.id === remoteId);
      const methods = aui.threads.item({ id: match?.id ?? remoteId });
      return methods.__internal_getRuntime?.() ?? null;
    } catch {
      return null;
    }
  }, [aui, remoteId]);
  const subscribe = useMemo(
    () => (onChange: () => void) => runtime?.subscribe(onChange) ?? (() => {}),
    [runtime],
  );
  const getSnapshot = useMemo(() => {
    const read = () => {
      try {
        const items = aui.threads.getState().threadItems;
        const match =
          items.find((t) => t.remoteId === remoteId) ??
          items.find((t) => t.id === remoteId);
        return (
          aui.threads.item({ id: match?.id ?? remoteId }).getState()
            .isRunning ?? false
        );
      } catch {
        return false;
      }
    };
    return read;
  }, [aui, remoteId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function ThreadRunningDot({
  remoteId,
  size = "sm",
  className,
}: {
  remoteId: string;
  size?: "xs" | "sm";
  className?: string;
}) {
  const running = useThreadListItemRunning(remoteId);
  if (!running) return null;
  return (
    <span
      role="status"
      aria-label={sidebarConfig.copy.threadRunning}
      title={sidebarConfig.copy.threadRunning}
      className={cn(
        "inline-block shrink-0 animate-pulse rounded-full bg-green-500",
        size === "xs" ? "size-1" : "size-1.5",
        className,
      )}
    />
  );
}
