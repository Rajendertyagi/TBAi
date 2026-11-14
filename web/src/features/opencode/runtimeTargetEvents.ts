import { resolveApiUrl } from "../../lib/platform";
import { logger } from "../../lib/logger";
import { publishRuntimeTargetIdentity } from "./runtimeStatus";

let source: EventSource | null = null;
let refCount = 0;

function parseTargetIdentity(data: string): {
  targetRevision: number;
  targetId: number | null;
  mode: "unresolved" | "managed" | "adopted";
} | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const mode = parsed.mode;
    if (mode !== "unresolved" && mode !== "managed" && mode !== "adopted") return null;
    const targetRevision =
      typeof parsed.targetRevision === "number" && Number.isFinite(parsed.targetRevision)
        ? Math.max(0, Math.floor(parsed.targetRevision))
        : 0;
    const targetId =
      typeof parsed.targetId === "number" && Number.isFinite(parsed.targetId)
        ? Math.floor(parsed.targetId)
        : null;
    return { mode, targetRevision, targetId };
  } catch {
    return null;
  }
}

function connect(): void {
  if (source) return;
  try {
    const url = resolveApiUrl("/api/opencode/runtime/events");
    const es = new EventSource(url);
    source = es;
    es.addEventListener("opencode.runtime_target", (event) => {
      const identity = parseTargetIdentity((event as MessageEvent).data);
      if (!identity) return;
      publishRuntimeTargetIdentity(identity);
    });
    es.onerror = () => {
      // Browser EventSource will retry automatically; keep subscription while
      // consumers remain interested. If closed externally, drop reference.
      if (source === es && es.readyState === EventSource.CLOSED) {
        source = null;
        if (refCount > 0) connect();
      }
    };
  } catch (err) {
    logger.debug("opencode", "opencode.runtime_events_connect_failed", {
      errorType: err instanceof Error ? err.name : typeof err,
    });
  }
}

function disconnect(): void {
  if (!source) return;
  source.close();
  source = null;
}

/** Acquires the shared OpenCode runtime target event subscription. */
export function acquireRuntimeTargetEvents(): void {
  refCount += 1;
  if (refCount === 1) connect();
}

/** Releases the shared OpenCode runtime target event subscription. */
export function releaseRuntimeTargetEvents(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) disconnect();
}

/** Test-only reset for the shared runtime target event subscription. */
export function resetRuntimeTargetEventsForTests(): void {
  refCount = 0;
  disconnect();
}
