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

import { randomUUID } from "node:crypto";
import { OPENCODE_RECOVERY_CONFIG, RECOVERY_NOTICE } from "../../config/opencode-recovery";
import { logger, normalizeError } from "../../lib/logger";
import { conversationService } from "../storage";
import { createOpenCodeClient, type OpenCodeClient } from "./client";
import {
  LOCAL_OWNER,
  readConversationHistoryOwner,
  sameHistoryOwner,
  type OpenCodeHistoryOwner,
} from "./historyBoundary";
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
  /** Mint one stable `msg_` id per recovery-synthetic lineage. */
  readonly newId: () => string;
  /** Durable session-projection presence flags (never a timestamp comparison). */
  readonly readSessionSignal: (
    client: OpenCodeClient,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<{ busy: boolean; idle: boolean }>;
  /** Grace wait: resolves on timeout OR abort (never rejects). Test seam. */
  readonly waitGrace: (ms: number, signal: AbortSignal) => Promise<void>;
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
  newId: () => `msg_${randomUUID()}`,
  readSessionSignal: async (client, sessionId, signal) => {
    try {
      const info = await client.session.get({ sessionID: sessionId }, { signal });
      return {
        busy: typeof info.time?.busy === "number",
        idle: typeof info.time?.idle === "number",
      };
    } catch {
      // A failed probe is not evidence of shutdown; fall back to no signal.
      return { busy: false, idle: false };
    }
  },
  waitGrace: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

let deps: RecoveryDeps = productionDeps;
let unsubscribe: (() => void) | null = null;
let started = false;

/** Processed target identities, deduplicated by backend instance + target id. */
const processedTargets = new Set<string>();

/** One controller per (targetId, sessionId) so a session has at most one in-flight recovery. */
const sessionControllers = new Map<string, AbortController>();

/** In-flight pass promises, drained on shutdown. */
const inflight = new Set<Promise<void>>();

function targetKey(change: OpenCodeRuntimeTargetChange): string {
  return `${change.backendInstanceId}:${change.targetId}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function lastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i]!)) return i;
  }
  return -1;
}

/**
 * Filter recovery candidates through the existing OpenCode history ownership
 * rules. Only conversations whose recorded owner is compatible with the active
 * managed (local) owner may be sent to the managed client. Remote-owned,
 * incompatible, and unreadable owner records are skipped — never probed.
 */
export function filterRecoveryCandidatesByOwner(
  candidates: readonly RecoveryCandidate[],
  activeOwner: OpenCodeHistoryOwner = LOCAL_OWNER,
): RecoveryCandidate[] {
  return candidates.filter((candidate) => {
    try {
      const owner = readConversationHistoryOwner(candidate);
      return owner !== null && sameHistoryOwner(owner, activeOwner);
    } catch {
      // Unreadable owner record → fail closed, never send to managed client.
      return false;
    }
  });
}

/** Map an action to its state-specific grace duration. */
function graceFor(action: RecoveryAction): number {
  const g = deps.graceMs ?? OPENCODE_RECOVERY_CONFIG.graceMs;
  if (action.kind === "indeterminate" || action.kind === "none") return 0;
  // Presence-based shutdown signal (busy set, idle absent) — never a timestamp
  // comparison. This is the only path to the longer shutdown grace.
  if (action.shutdownInterruption) return g.shutdownInterruption;
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

type CallResult = "ok" | "conflict" | "absent" | "permanent" | "transient" | "budget";

/**
 * Perform one resume action with a SHARED HTTP budget across every call the
 * action makes (cancel + prompt, or synthetic). A cancel and its prompt are
 * separate calls; both count against `maxHttpCalls`. A synthetic's id is
 * minted ONCE before the first attempt and reused on every retry, so a lost
 * response can never create a second synthetic.
 */
async function performAction(
  client: OpenCodeClient,
  candidate: RecoveryCandidate,
  action: RecoveryAction,
  signal: AbortSignal,
): Promise<"recovered" | "conflict" | "absent" | "permanent" | "failed"> {
  const cfg = OPENCODE_RECOVERY_CONFIG;
  const sessionID = candidate.opencodeSessionId;
  let callsUsed = 0;

  // Mint one stable id for the whole synthetic lineage before any attempt.
  const stableSyntheticId =
    action.kind === "repost-synthetic" ? (action.id ?? deps.newId()) : undefined;

  const call = async (run: () => Promise<unknown>): Promise<CallResult> => {
    if (callsUsed >= cfg.maxHttpCalls) return "budget";
    callsUsed += 1;
    try {
      await run();
      return "ok";
    } catch (error) {
      if (isAbort(error)) throw error;
      const status = (error as { status?: number })?.status;
      if (status === 409) return "conflict";
      if (status === 404) return "absent";
      if (status === 408 || status === 429 || (status !== undefined && status >= 500))
        return "transient";
      if (status !== undefined && status >= 400 && status < 500) return "permanent";
      return "transient"; // network failure / timeout
    }
  };

  /** Retry one logical step on transient failures within the shared budget. */
  const runStep = async (run: () => Promise<unknown>): Promise<CallResult> => {
    let result: CallResult = "budget";
    for (let attempt = 0; attempt < cfg.maxHttpCalls; attempt += 1) {
      if (attempt > 0) {
        const backoff = cfg.backoffMs[attempt - 1] ?? cfg.backoffMs[cfg.backoffMs.length - 1]!;
        await deps.sleep(backoff, signal);
      }
      result = await call(run);
      if (result !== "transient") return result;
    }
    return result;
  };

  const terminal = (result: CallResult): result is "conflict" | "absent" | "permanent" | "budget" =>
    result === "conflict" || result === "absent" || result === "permanent" || result === "budget";

  if (action.kind === "resubmit-user" || action.kind === "cancel-and-resubmit-user") {
    const cancelId = action.kind === "cancel-and-resubmit-user" ? action.cancelId : undefined;
    const userId = action.kind === "resubmit-user" ? action.id : action.userId;
    const delivery = action.delivery;
    if (cancelId !== undefined) {
      const cancelResult = await runStep(() =>
        client.session.inbox.cancel({ sessionID, inboxID: cancelId }, { signal }),
      );
      if (terminal(cancelResult)) {
        return cancelResult === "budget" ? "failed" : cancelResult;
      }
    }
    const promptResult = await runStep(() =>
      client.session.prompt(
        {
          sessionID,
          id: userId,
          text: "Continue from where you left off without repeating completed work.",
          delivery,
          resume: true,
        },
        { signal },
      ),
    );
    if (terminal(promptResult)) {
      return promptResult === "budget" ? "failed" : promptResult;
    }
    return "recovered";
  }

  // repost-synthetic: one stable id on every attempt.
  if (action.kind !== "repost-synthetic") return "failed";
  const metadata = (action.metadata ?? { notice: RECOVERY_NOTICE }) as Record<
    string,
    string | number | boolean | null
  >;
  const syntheticText =
    action.text ?? "The server restarted while you were working. Continue from where you left off.";
  const syntheticDescription = action.description;
  const syntheticResult = await runStep(() =>
    client.session.synthetic(
      {
        sessionID,
        id: stableSyntheticId,
        text: syntheticText,
        description: syntheticDescription,
        metadata,
        delivery: "steer",
        resume: true,
      },
      { signal },
    ),
  );
  if (terminal(syntheticResult)) {
    return syntheticResult === "budget" ? "failed" : syntheticResult;
  }
  return "recovered";
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

    const sessionSignal = await deps.readSessionSignal(client, candidate.opencodeSessionId, signal);
    if (!targetStillValid(change)) return;

    const action = classifyRecovery({ messages, inbox, truncated, sessionSignal });
    if (action.kind === "none" || action.kind === "indeterminate") {
      logger.info("opencode", "opencode.recovery.skip", {
        targetId: change.targetId,
        sessionId: candidate.id,
        reason: action.reason,
      });
      return;
    }

    // Reuse a recovery synthetic id from durable history ONLY when it belongs
    // to the current unfinished lineage — i.e. it appears AFTER the latest
    // user intent. A marker from an older, already-superseded lineage must not
    // be reused.
    if (action.kind === "repost-synthetic" && action.reuseFromHistory) {
      const lastUserIdx = lastIndex(messages, (m) => m.type === "user");
      const prior = [...messages]
        .map((m, i) => ({ m, i }))
        .reverse()
        .find(
          ({ m, i }) =>
            m.type === "synthetic" &&
            m.metadata?.notice === RECOVERY_NOTICE &&
            (lastUserIdx < 0 || i > lastUserIdx),
        )?.m;
      if (prior) {
        return await actWithGrace(change, candidate, client, signal, {
          ...action,
          id: prior.id,
          text: typeof prior.metadata?.text === "string" ? prior.metadata.text : action.text,
          metadata: prior.metadata ?? action.metadata,
        });
      }
    }

    await actWithGrace(change, candidate, client, signal, action);
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
): Promise<void> {
  const grace = graceFor(action);
  if (grace > 0) {
    await deps.waitGrace(grace, signal);
  }
  if (!targetStillValid(change) || signal.aborted) return;

  // Re-check history and inbox at grace expiry before acting.
  const recheck = await scanHistory(client, candidate.opencodeSessionId, signal);
  if (!targetStillValid(change) || signal.aborted) return;
  const recheckInbox = await readInbox(client, candidate.opencodeSessionId, signal);
  if (!targetStillValid(change) || signal.aborted) return;
  const recheckSignal = await deps.readSessionSignal(client, candidate.opencodeSessionId, signal);
  if (!targetStillValid(change) || signal.aborted) return;
  const finalAction = classifyRecovery({
    ...recheck,
    inbox: recheckInbox,
    sessionSignal: recheckSignal,
  });
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
    const listed = await deps.listCandidates();
    // Fail closed: never send a remote-owned, incompatible, or unreadable
    // conversation to the managed client.
    const candidates = filterRecoveryCandidatesByOwner(listed);
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

/** Cancel grace waits and in-flight work for one target (or all when null). */
function cancelForTarget(targetId: number | null): void {
  for (const [key, controller] of sessionControllers) {
    if (targetId === null || key.startsWith(`${targetId}:`)) controller.abort();
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
} {
  return {
    started,
    processedTargets: processedTargets.size,
    inFlight: sessionControllers.size,
  };
}
