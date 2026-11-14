import { resolveApiUrl } from "../../lib/platform";
import { logger } from "../../lib/logger";
import { publishRuntimeTargetIdentity } from "./runtimeStatus";

let source: EventSource | null = null;
let refCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5000;

function parseTargetIdentity(data: string): {
  backendInstanceId: string;
  targetRevision: number;
  targetId: number | null;
  mode: "unresolved" | "managed" | "adopted";
} | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const mode = parsed.mode;
    if (mode !== "unresolved" && mode !== "managed" && mode !== "adopted") return null;
    const backendInstanceId =
      typeof parsed.backendInstanceId === "string" ? parsed.backendInstanceId : "";
    const targetRevision =
      typeof parsed.targetRevision === "number" && Number.isFinite(parsed.targetRevision)
        ? Math.max(0, Math.floor(parsed.targetRevision))
        : 0;
    const targetId =
      typeof parsed.targetId === "number" && Number.isFinite(parsed.targetId)
        ? Math.floor(parsed.targetId)
        : null;
    return { backendInstanceId, mode, targetRevision, targetId };
  } catch {
    return null;
  }
}

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function resetRetryState(): void {
  retryAttempt = 0;
  clearRetryTimer();
}

function scheduleReconnect(): void {
  if (refCount <= 0) return;
  if (retryTimer !== null) return;
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retryAttempt);
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (refCount <= 0) return;
    connect();
  }, delay);
}

function closeSource(es: EventSource | null): void {
  if (!es) return;
  try {
    es.close();
  } catch {
    /* ignore */
  }
}

function connect(): void {
  if (refCount <= 0) return;
  if (source && source.readyState !== EventSource.CLOSED) return;
  if (source && source.readyState === EventSource.CLOSED) {
    source = null;
  }
  clearRetryTimer();
  try {
    const url = resolveApiUrl("/api/opencode/runtime/events");
    const es = new EventSource(url);
    source = es;
    es.onopen = () => {
      if (source !== es) return;
      resetRetryState();
    };
    es.addEventListener("opencode.runtime_target", (event) => {
      if (source !== es) return;
      const identity = parseTargetIdentity((event as MessageEvent).data);
      if (!identity) return;
      publishRuntimeTargetIdentity(identity);
    });
    es.onerror = () => {
      if (source !== es) return;
      // Browser-native retry is preferred while CONNECTING. Only take over when
      // the connection is CLOSED or cannot be established while consumers remain.
      if (es.readyState === EventSource.CONNECTING) return;
      if (es.readyState === EventSource.CLOSED) {
        closeSource(es);
        source = null;
        scheduleReconnect();
      }
    };
  } catch (err) {
    source = null;
    logger.debug("opencode", "opencode.runtime_events_connect_failed", {
      errorType: err instanceof Error ? err.name : typeof err,
    });
    scheduleReconnect();
  }
}

function disconnect(): void {
  resetRetryState();
  const es = source;
  source = null;
  closeSource(es);
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
