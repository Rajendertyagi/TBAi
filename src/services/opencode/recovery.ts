/**
 * Managed OpenCode restart recovery service.
 *
 * One backend-owned, best-effort path that re-submits unfinished work after a
 * managed child restart or a backend restart. It is triggered by the existing
 * `subscribeRuntimeTargetChanges()` seam; `serverManager.ts` and
 * `connectionState.ts` are untouched. All classification is pure (see
 * `recoveryClassifier.ts`); this module owns scanning, grace, retries, and
 * acting through the official pinned client.
 *
 * Safety: no new persistent state, no polling loop, no second framework. Every
 * delayed or network step re-checks target identity and shutdown state. Async
 * listener failures are caught explicitly because the connection-state listener
 * only protects synchronous exceptions.
 */

import { OPENCODE_RECOVERY_CONFIG, RECOVERY_NOTICE } from "../../config/opencode-recovery";
import { logger, normalizeError } from "../../lib/logger";
import { conversationService } from "../storage";
import { createOpenCodeClient, type OpenCodeClient } from "./client";
import {
  readConnectionState,
  readRuntimeTargetChange,
  readShutdownState,
  subscribeRuntimeTargetChanges,
  type OpenCodeRuntimeTargetChange,
} from "./connectionState";
import {
  classifyRecovery,
  type InboxEntry,
  type RecoveryAction,
  type TimelineMessage,
} from "./recoveryClassifier";
import { resolveOpenCodeRuntimeTarget } from "./runtimeTarget";

/** A conversation eligible for recovery. */
interface RecoveryCandidate {
  readonly id: string;
  readonly opencodeSessionId: string;
  readonly opencodeDirectory: string | null;
  readonly opencodeServiceOwner: string | null;
}

/** Injectable seams so the service is testable without real I/O. */
export interface RecoveryDeps {
  readonly subscribe: (listener: (change: OpenCodeRuntimeTargetChange) => void) => () => void;
  readonly snapshot: () => OpenCodeRuntimeTargetChange;
  readonly isShutdown: () => boolean;
  readonly isManagedInstalled: () => boolean;
  readonly listCandidates: () => Promise<RecoveryCandidate[]>;
  readonly makeClient: (baseUrl: string, directory: string | null) => Promise<OpenCodeClient>;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
  /** Test seam: override grace durations (e.g. all zero) to avoid real waits. */
  readonly graceMs?: {
    readonly shutdownInterruption: number;
    readonly incompleteAssistant: number;
    readonly pendingInput: number;
    readonly projectedUser: number;
  };
}

const productionDeps: RecoveryDeps = {
  subscribe: subscribeRuntimeTargetChanges,
  snapshot: readRuntimeTargetChange,
  isShutdown: () => readShutdownState().shutdownStarted,
  isManagedInstalled: () => readConnectionState().target.mode === "managed",
  listCandidates: () => conversationService.listOpenCodeRecoveryCandidates(),
  makeClient: async (baseUrl, directory) => {
    const target = await resolveOpenCodeRuntimeTarget();
    return createOpenCodeClient(target.baseUrl || baseUrl, {
      transport: target.transport,
      directory,
    });
  },
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  now: Date.now,
};

let deps: RecoveryDeps = productionDeps;
let unsubscribe: (() => void) | null = null;
let started = false;

/** Processed target identities, deduplicated by backend instance + target id. */
const processedTargets = new Set<string>();

/** One controller per (targetId, sessionId) so a session has at most one in-flight recovery. */
const sessionControllers = new Map<string, AbortController>();

/** Grace timers, cancelled on target replacement or shutdown. */
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** In-flight pass promises, drained on shutdown. */
const inflight = new Set<Promise<void>>();

function targetKey(change: OpenCodeRuntimeTargetChange): string {
  return `${change.backendInstanceId}:${change.targetId}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Map an action to its state-specific grace duration. */
function graceFor(action: RecoveryAction, sessionBusyNoIdle: boolean): number {
  const g = deps.graceMs ?? OPENCODE_RECOVERY_CONFIG.graceMs;
  if (action.kind === "indeterminate" || action.kind === "none") return 0;
  if (sessionBusyNoIdle) return g.shutdownInterruption;
  if (action.kind === "repost-synthetic" && action.reuseFromHistory) return g.incompleteAssistant;
  if (action.kind === "resubmit-user") return g.projectedUser;
  return g.pendingInput;
}

/** Convert a projected message to the classifier's reduced shape. */
function toTimelineMessage(message: {
  readonly id: string;
  readonly type: string;
  readonly time?: { readonly created?: number; readonly completed?: number };
  readonly metadata?: Record<string, unknown>;
  readonly status?: string;
  readonly text?: string;
  readonly description?: string;
}): TimelineMessage | null {
  const type = message.type;
  const known =
    type === "user" ||
    type === "synthetic" ||
    type === "assistant" ||
    type === "idle" ||
    type === "compaction";
  if (!known) return null;
  const metadata = message.metadata ?? {};
  const time = message.time ?? {};
  return {
    id: message.id,
    type: type as TimelineMessage["type"],
    timeCreated: typeof time.created === "number" ? time.created : 0,
    metadata,
    completed: type === "assistant" && time.completed !== undefined ? true : undefined,
    needsContinuation: metadata.needsContinuation === true,
    compactionStatus: type === "compaction" ? message.status : undefined,
    text: typeof message.text === "string" ? message.text : undefined,
    description: typeof message.description === "string" ? message.description : undefined,
  };
}

/** Convert a pending inbox item to the classifier's reduced shape. */
function toInboxEntry(item: {
  readonly id: string;
  readonly type: string;
  readonly delivery: string;
  readonly payload?: { readonly metadata?: Record<string, unknown> };
  readonly time?: { readonly created?: number };
}): InboxEntry | null {
  if (
    item.type !== "user" &&
    item.type !== "synthetic" &&
    item.type !== "compaction" &&
    item.type !== "move"
  ) {
    return null;
  }
  return {
    id: item.id,
    type: item.type as InboxEntry["type"],
    delivery: item.delivery === "queue" ? "queue" : "steer",
    metadata: item.payload?.metadata,
    timeCreated: typeof item.time?.created === "number" ? item.time.created : 0,
  };
}

/**
 * Newest-first, unfiltered history scan. Reconstructs chronological order and
 * reports whether the scan budget was exhausted before the boundary was proven.
 */
async function scanHistory(
  client: OpenCodeClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<{ messages: TimelineMessage[]; truncated: boolean }> {
  const cfg = OPENCODE_RECOVERY_CONFIG.scan;
  const collected: TimelineMessage[] = [];
  let cursor: string | undefined;
  let order: "desc" | undefined = "desc";
  let foundInput = false;
  let truncated = false;

  for (let page = 0; page < cfg.maxPages; page += 1) {
    const response = await client.message.list(
      { sessionID: sessionId, order, limit: cfg.pageSize, cursor },
      { signal },
    );
    for (const raw of response.data) {
      const message = toTimelineMessage(raw as never);
      if (!message) continue;
      collected.push(message);
      if (!foundInput && (message.type === "user" || message.type === "synthetic")) {
        foundInput = true;
      }
    }
    if (foundInput) break; // latest work-bearing input and its idle status are established
    const next = response.cursor?.next;
    if (!next) break;
    cursor = next;
    order = undefined; // never combine cursor with order
    if (collected.length >= cfg.maxMessages) {
      truncated = true;
      break;
    }
  }
  if (!foundInput && collected.length >= cfg.maxMessages) truncated = true;
  // Descending pages → chronological order for the classifier.
  collected.reverse();
  return { messages: collected, truncated };
}

/** Read the pending inbox in enqueue order. */
async function readInbox(
  client: OpenCodeClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<InboxEntry[]> {
  const items = await client.session.inbox.list({ sessionID: sessionId }, { signal });
  return items
    .map((item) => toInboxEntry(item as never))
    .filter((item): item is InboxEntry => item !== null);
}

/** Re-check that the target we started for is still the installed one. */
function targetStillValid(change: OpenCodeRuntimeTargetChange): boolean {
  if (deps.isShutdown()) return false;
  const current = deps.snapshot();
  return (
    current.mode === "managed" &&
    current.targetId === change.targetId &&
    current.backendInstanceId === change.backendInstanceId
  );
}

/** Perform one resume action with bounded retries. Returns a short outcome label. */
async function performAction(
  client: OpenCodeClient,
  candidate: RecoveryCandidate,
  action: RecoveryAction,
  signal: AbortSignal,
): Promise<"recovered" | "conflict" | "absent" | "permanent" | "failed"> {
  const cfg = OPENCODE_RECOVERY_CONFIG;
  const sessionID = candidate.opencodeSessionId;

  const attempt = async (): Promise<"ok" | "conflict" | "absent" | "permanent" | "transient"> => {
    try {
      if (action.kind === "resubmit-user" || action.kind === "cancel-and-resubmit-user") {
        if (action.kind === "cancel-and-resubmit-user") {
          await client.session.inbox.cancel({ sessionID, inboxID: action.cancelId }, { signal });
        }
        const userId = action.kind === "resubmit-user" ? action.id : action.userId;
        await client.session.prompt(
          {
            sessionID,
            id: userId,
            text: "Continue from where you left off without repeating completed work.",
            delivery: action.delivery,
            resume: true,
          },
          { signal },
        );
      } else if (action.kind === "repost-synthetic") {
        const metadata = (action.metadata ?? { notice: RECOVERY_NOTICE }) as Record<
          string,
          string | number | boolean | null
        >;
        await client.session.synthetic(
          {
            sessionID,
            id: action.id,
            text:
              action.text ??
              "The server restarted while you were working. Continue from where you left off.",
            description: action.description,
            metadata,
            delivery: "steer",
            resume: true,
          },
          { signal },
        );
      }
      return "ok";
    } catch (error) {
      if (isAbort(error)) throw error;
      const status = (error as { status?: number })?.status;
      if (status === 409) return "conflict";
      if (status === 404) return "absent";
      if (status === 408 || status === 429 || (status !== undefined && status >= 500))
        return "transient";
      if (status !== undefined && status >= 400 && status < 500) return "permanent"; // permanent 4xx: stop
      return "transient"; // network failure / timeout
    }
  };

  for (let call = 0; call < cfg.maxHttpCalls; call += 1) {
    if (call > 0) {
      const backoff = cfg.backoffMs[call - 1] ?? cfg.backoffMs[cfg.backoffMs.length - 1]!;
      await deps.sleep(backoff, signal);
    }
    const result = await attempt();
    if (result === "ok") return "recovered";
    if (result === "conflict") return "conflict";
    if (result === "absent") return "absent";
    if (result === "permanent") return "permanent";
    // transient → retry within the cap
  }
  return "failed";
}

/** Recover one candidate for one target. */
async function recoverCandidate(
  change: OpenCodeRuntimeTargetChange,
  candidate: RecoveryCandidate,
  client: OpenCodeClient,
): Promise<void> {
  const key = `${change.targetId}:${candidate.id}`;
  if (sessionControllers.has(key)) return; // at most one in-flight per session
  const controller = new AbortController();
  sessionControllers.set(key, controller);
  const signal = controller.signal;
  try {
    if (!targetStillValid(change)) return;
    const { messages, truncated } = await scanHistory(client, candidate.opencodeSessionId, signal);
    if (!targetStillValid(change)) return;
    const inbox = await readInbox(client, candidate.opencodeSessionId, signal);
    if (!targetStillValid(change)) return;

    const action = classifyRecovery({ messages, inbox, truncated });
    if (action.kind === "none" || action.kind === "indeterminate") {
      logger.info("opencode", "opencode.recovery.skip", {
        targetId: change.targetId,
        sessionId: candidate.id,
        reason: action.reason,
      });
      return;
    }

    // Reuse a recovery synthetic id from durable history when requested.
    if (action.kind === "repost-synthetic" && action.reuseFromHistory) {
      const prior = [...messages]
        .reverse()
        .find((m) => m.type === "synthetic" && m.metadata?.notice === RECOVERY_NOTICE);
      if (prior) {
        return await actWithGrace(change, candidate, client, signal, {
          ...action,
          id: prior.id,
          text: typeof prior.metadata?.text === "string" ? prior.metadata.text : action.text,
          metadata: prior.metadata ?? action.metadata,
        });
      }
    }

    const busyNoIdle = false; // session projection is supporting only; grace by action kind
    await actWithGrace(change, candidate, client, signal, action, busyNoIdle);
  } finally {
    sessionControllers.delete(key);
  }
}

async function actWithGrace(
  change: OpenCodeRuntimeTargetChange,
  candidate: RecoveryCandidate,
  client: OpenCodeClient,
  signal: AbortSignal,
  action: RecoveryAction,
  busyNoIdle = false,
): Promise<void> {
  const grace = graceFor(action, busyNoIdle);
  if (grace > 0) {
    const timerKey = `${change.targetId}:${candidate.id}`;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        graceTimers.delete(timerKey);
        resolve();
      }, grace);
      graceTimers.set(timerKey, timer);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          graceTimers.delete(timerKey);
          resolve();
        },
        { once: true },
      );
    });
  }
  if (!targetStillValid(change) || signal.aborted) return;

  // Re-check history and inbox at grace expiry before acting.
  const recheck = await scanHistory(client, candidate.opencodeSessionId, signal);
  if (!targetStillValid(change) || signal.aborted) return;
  const recheckInbox = await readInbox(client, candidate.opencodeSessionId, signal);
  if (!targetStillValid(change) || signal.aborted) return;
  const finalAction = classifyRecovery({ ...recheck, inbox: recheckInbox });
  if (finalAction.kind === "none" || finalAction.kind === "indeterminate") {
    logger.info("opencode", "opencode.recovery.cancelled_at_grace", {
      targetId: change.targetId,
      sessionId: candidate.id,
      reason: finalAction.reason,
    });
    return;
  }

  const outcome = await performAction(client, candidate, finalAction, signal);
  logger.info("opencode", "opencode.recovery.attempt", {
    targetId: change.targetId,
    sessionId: candidate.id,
    action: finalAction.kind,
    outcome,
  });
}

/** Run one full recovery pass for a published managed target. */
async function runPass(change: OpenCodeRuntimeTargetChange): Promise<void> {
  if (!targetStillValid(change) || !deps.isManagedInstalled()) return;
  const startedAt = deps.now();
  try {
    const candidates = await deps.listCandidates();
    const budget = candidates.slice(0, OPENCODE_RECOVERY_CONFIG.maxCandidatesPerPass);
    // Concurrency is bounded by a simple sequential loop; the cap keeps boot cheap.
    for (const candidate of budget) {
      if (!targetStillValid(change)) break;
      if (deps.now() - startedAt > OPENCODE_RECOVERY_CONFIG.passBudgetMs) break;
      // Each session is directory-scoped: build a client with that session's
      // directory so the x-opencode-directory header addresses the right one.
      const client = await deps.makeClient("", candidate.opencodeDirectory);
      await recoverCandidate(change, candidate, client);
    }
  } catch (error) {
    if (!isAbort(error)) {
      logger.warn("opencode", "opencode.recovery.pass_failed", {
        targetId: change.targetId,
        ...normalizeError(error),
      });
    }
  }
}

/** Handle a target change. Async work is fire-and-forget with explicit failure capture. */
function onTargetChange(change: OpenCodeRuntimeTargetChange): void {
  try {
    if (change.mode !== "managed" || change.targetId === null) {
      cancelForTarget(change.targetId);
      return;
    }
    const key = targetKey(change);
    if (processedTargets.has(key)) return;
    processedTargets.add(key);
    const pass = runPass(change).catch((error) => {
      if (!isAbort(error)) {
        logger.warn("opencode", "opencode.recovery.listener_failed", {
          targetId: change.targetId,
          ...normalizeError(error),
        });
      }
    });
    inflight.add(pass);
    void pass.finally(() => inflight.delete(pass));
  } catch (error) {
    // The connection-state listener only protects synchronous exceptions; this
    // catch is explicit so a listener failure can never break state publication.
    logger.warn("opencode", "opencode.recovery.listener_sync_failed", {
      ...normalizeError(error),
    });
  }
}

/** Cancel grace timers and in-flight work for one target (or all when null). */
function cancelForTarget(targetId: number | null): void {
  for (const [key, controller] of sessionControllers) {
    if (targetId === null || key.startsWith(`${targetId}:`)) controller.abort();
  }
  for (const [key, timer] of graceTimers) {
    if (targetId === null || key.startsWith(`${targetId}:`)) {
      clearTimeout(timer);
      graceTimers.delete(key);
    }
  }
}

/**
 * Start the recovery service. Idempotent. Subscribes before the caller starts
 * the managed runtime, then handles an already-installed target via a snapshot.
 */
export function startOpenCodeRecovery(overrides: Partial<RecoveryDeps> = {}): { started: boolean } {
  if (started) return { started: false };
  deps = { ...productionDeps, ...overrides };
  unsubscribe = deps.subscribe(onTargetChange);
  started = true;
  // Late-subscriber snapshot: handle a target published before we subscribed.
  onTargetChange(deps.snapshot());
  return { started: true };
}

/** Stop new work, cancel timers and in-flight calls. Safe when not started. */
export function stopOpenCodeRecovery(): boolean {
  if (!started) return false;
  started = false;
  unsubscribe?.();
  unsubscribe = null;
  cancelForTarget(null);
  processedTargets.clear();
  return true;
}

/** Await in-flight recovery passes within a bounded drain. */
export async function drainOpenCodeRecovery(): Promise<void> {
  const tasks = [...inflight];
  if (tasks.length === 0) return;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, OPENCODE_RECOVERY_CONFIG.drainTimeoutMs);
  });
  await Promise.race([Promise.allSettled(tasks).then(() => undefined), timeout]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
}

/** Test-only state inspection. */
export function getOpenCodeRecoveryState(): {
  started: boolean;
  processedTargets: number;
  inFlight: number;
  graceTimers: number;
} {
  return {
    started,
    processedTargets: processedTargets.size,
    inFlight: sessionControllers.size,
    graceTimers: graceTimers.size,
  };
}
