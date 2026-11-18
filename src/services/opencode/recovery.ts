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
  /** Test seam: override the per-call timeout (defaults to config). */
  readonly perCallTimeoutMs?: number;
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
      const info = await withTimeout(
        (callSignal) => client.session.get({ sessionID: sessionId }, { signal: callSignal }),
        signal,
        OPENCODE_RECOVERY_CONFIG.perCallTimeoutMs,
      );
      return {
        busy: typeof info.time?.busy === "number",
        idle: typeof info.time?.idle === "number",
      };
    } catch (error) {
      // A timeout means durable state is unproven — propagate so the candidate
      // is skipped this pass. Other probe failures are not evidence of shutdown
      // and fall back to no signal rather than guessing.
      if (error instanceof RecoveryTimeoutError) throw error;
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

/** Last performAction outcome, recorded for test-only inspection. */
let lastOutcome: string | null = null;

function targetKey(change: OpenCodeRuntimeTargetChange): string {
  return `${change.backendInstanceId}:${change.targetId}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Combine two abort signals: either one aborts the returned signal. */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  const onAbort = () => {
    a.removeEventListener("abort", onAbort);
    b.removeEventListener("abort", onAbort);
    controller.abort();
  };
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

/** A per-call timeout fired (distinct from a lifecycle abort). */
class RecoveryTimeoutError extends Error {
  constructor() {
    super("recovery call timed out");
    this.name = "RecoveryTimeoutError";
  }
}

/**
 * Enforce a real per-call timeout. The work receives a signal that aborts on
 * either the lifecycle signal (shutdown / target replacement) or the timeout.
 * A timeout throws {@link RecoveryTimeoutError}; a lifecycle abort propagates
 * the original error. Callers decide the policy: resume operations retry a
 * timeout as transient within the shared budget, while read operations skip
 * the candidate for this pass (no retry) because durable state is unproven.
 */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  outer: AbortSignal,
  ms: number,
): Promise<T> {
  const timeout = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeout.abort();
  }, ms);
  const combined = combineSignals(outer, timeout.signal);
  try {
    return await work(combined);
  } catch (error) {
    if (timedOut && !outer.aborted) throw new RecoveryTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function timeoutMs(): number {
  return deps.perCallTimeoutMs ?? OPENCODE_RECOVERY_CONFIG.perCallTimeoutMs;
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
    const response = await withTimeout(
      (callSignal) =>
        client.message.list(
          { sessionID: sessionId, order, limit: cfg.pageSize, cursor },
          { signal: callSignal },
        ),
      signal,
      timeoutMs(),
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
  const items = await withTimeout(
    (callSignal) => client.session.inbox.list({ sessionID: sessionId }, { signal: callSignal }),
    signal,
    timeoutMs(),
  );
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
 * The result of one logical step after its retry loop. `"transient"` and
 * `"budget"` never escape `runStep`: an exhausted retry sequence becomes the
 * explicit terminal `"exhausted"` outcome, so a failed step can never be
 * mistaken for success or silently allow the next step to proceed.
 */
type StepResult = "ok" | "conflict" | "absent" | "permanent" | "exhausted";

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

  const call = async (run: (callSignal: AbortSignal) => Promise<unknown>): Promise<CallResult> => {
    if (callsUsed >= cfg.maxHttpCalls) return "budget";
    callsUsed += 1;
    try {
      await withTimeout(run, signal, timeoutMs());
      return "ok";
    } catch (error) {
      // Resume operations retry a timeout as transient within the shared budget.
      if (error instanceof RecoveryTimeoutError) return "transient";
      if (isAbort(error)) {
        // A lifecycle abort (shutdown / target replacement) must propagate.
        if (signal.aborted) throw error;
        return "transient";
      }
      const status = (error as { status?: number })?.status;
      if (status === 409) return "conflict";
      if (status === 404) return "absent";
      if (status === 408 || status === 429 || (status !== undefined && status >= 500))
        return "transient";
      if (status !== undefined && status >= 400 && status < 500) return "permanent";
      return "transient"; // network failure / timeout
    }
  };

  /**
   * Retry one logical step on transient failures within the shared budget.
   * `reserveCalls` guarantees that many calls remain for later steps — the
   * cancel step reserves one for the prompt so a successful cancellation can
   * never leave the user input unwoken because cancellation used the budget.
   * When all attempts are exhausted (transient failures or no budget left),
   * this returns the explicit terminal `"exhausted"` — never `"transient"`.
   */
  const runStep = async (
    run: (callSignal: AbortSignal) => Promise<unknown>,
    reserveCalls = 0,
  ): Promise<StepResult> => {
    const maxAttempts = Math.max(1, cfg.maxHttpCalls - reserveCalls);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        const backoff = cfg.backoffMs[attempt - 1] ?? cfg.backoffMs[cfg.backoffMs.length - 1]!;
        await deps.sleep(backoff, signal);
      }
      const result = await call(run);
      if (
        result === "ok" ||
        result === "conflict" ||
        result === "absent" ||
        result === "permanent"
      ) {
        return result;
      }
      // "transient" → retry; "budget" → no calls left, stop immediately.
      if (result === "budget") return "exhausted";
    }
    return "exhausted";
  };

  /** Map a non-ok step result to the action outcome. Exhaustion is a failure. */
  const failureOutcome = (
    result: Exclude<StepResult, "ok">,
  ): "conflict" | "absent" | "permanent" | "failed" => (result === "exhausted" ? "failed" : result);

  if (action.kind === "resubmit-user" || action.kind === "cancel-and-resubmit-user") {
    const cancelId = action.kind === "cancel-and-resubmit-user" ? action.cancelId : undefined;
    const userId = action.kind === "resubmit-user" ? action.id : action.userId;
    const delivery = action.delivery;
    if (cancelId !== undefined) {
      // Reserve one call for the prompt: cancellation may use at most
      // maxHttpCalls - 1 attempts, so a successful cancel always leaves a call
      // to wake the user input.
      const cancelResult = await runStep(
        (callSignal) =>
          client.session.inbox.cancel({ sessionID, inboxID: cancelId }, { signal: callSignal }),
        1,
      );
      // Proceed to the prompt ONLY after cancellation actually succeeded. An
      // exhausted/failed cancellation stops the action — never wake the user
      // as though a stale synthetic had been cancelled.
      if (cancelResult !== "ok") return failureOutcome(cancelResult);
    }
    const promptResult = await runStep((callSignal) =>
      client.session.prompt(
        {
          sessionID,
          id: userId,
          text: "Continue from where you left off without repeating completed work.",
          delivery,
          resume: true,
        },
        { signal: callSignal },
      ),
    );
    // "recovered" only when session.prompt actually succeeded.
    if (promptResult !== "ok") return failureOutcome(promptResult);
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
  const syntheticResult = await runStep((callSignal) =>
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
      { signal: callSignal },
    ),
  );
  // "recovered" only when session.synthetic actually succeeded; the same
  // stable id was reused on every attempt.
  if (syntheticResult !== "ok") return failureOutcome(syntheticResult);
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
  } catch (error) {
    if (error instanceof RecoveryTimeoutError) {
      // A read timeout means durable state could not be established. Skip this
      // candidate for the pass (no retry here); a later target publication may
      // retry. Never auto-resume on unproven state.
      logger.info("opencode", "opencode.recovery.read_timeout", {
        targetId: change.targetId,
        sessionId: candidate.id,
      });
      return;
    }
    throw error;
  } finally {
    sessionControllers.delete(key);
  }
}

/** Bound grace re-evaluation so a rapidly changing session cannot loop forever. */
const MAX_GRACE_CYCLES = 3;

async function actWithGrace(
  change: OpenCodeRuntimeTargetChange,
  candidate: RecoveryCandidate,
  client: OpenCodeClient,
  signal: AbortSignal,
  initialAction: RecoveryAction,
): Promise<void> {
  let action = initialAction;
  let waited = 0;
  let stable = false;

  for (let cycle = 0; cycle < MAX_GRACE_CYCLES; cycle += 1) {
    // Wait for the grace the CURRENT classification requires. If a previous
    // cycle already waited for a shorter grace, only wait the difference.
    const required = graceFor(action);
    if (required > waited) {
      await deps.waitGrace(required - waited, signal);
      waited = required;
    }
    if (!targetStillValid(change) || signal.aborted) return;

    // Re-check history, inbox and session at grace expiry before acting.
    const recheck = await scanHistory(client, candidate.opencodeSessionId, signal);
    if (!targetStillValid(change) || signal.aborted) return;
    const recheckInbox = await readInbox(client, candidate.opencodeSessionId, signal);
    if (!targetStillValid(change) || signal.aborted) return;
    const recheckSignal = await deps.readSessionSignal(client, candidate.opencodeSessionId, signal);
    if (!targetStillValid(change) || signal.aborted) return;
    const next = classifyRecovery({
      ...recheck,
      inbox: recheckInbox,
      sessionSignal: recheckSignal,
    });
    if (next.kind === "none" || next.kind === "indeterminate") {
      logger.info("opencode", "opencode.recovery.cancelled_at_grace", {
        targetId: change.targetId,
        sessionId: candidate.id,
        reason: next.reason,
      });
      return;
    }

    // If the reclassified state needs a LONGER grace than we have waited, the
    // new state (e.g. an incomplete assistant that just appeared) has not had
    // its required settle window — loop and wait the remainder before acting.
    if (graceFor(next) > waited) {
      action = next;
      continue;
    }
    action = next;
    stable = true;
    break;
  }

  if (!stable) {
    // State kept escalating past the cycle bound: fail conservative rather
    // than act on a grace we never fully honoured.
    logger.info("opencode", "opencode.recovery.grace_unstable", {
      targetId: change.targetId,
      sessionId: candidate.id,
    });
    return;
  }

  const outcome = await performAction(client, candidate, action, signal);
  lastOutcome = outcome;
  logger.info("opencode", "opencode.recovery.attempt", {
    targetId: change.targetId,
    sessionId: candidate.id,
    action: action.kind,
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
      // Isolate each candidate: one candidate's unexpected failure must not end
      // the pass and starve the remaining candidates. A lifecycle abort is the
      // exception — it means the target was replaced or the backend is shutting
      // down, so stop the pass rather than start work for an obsolete target.
      try {
        // Each session is directory-scoped: build a client with that session's
        // directory so the x-opencode-directory header addresses the right one.
        const client = await deps.makeClient("", candidate.opencodeDirectory);
        await recoverCandidate(change, candidate, client);
      } catch (error) {
        if (isAbort(error)) break;
        logger.warn("opencode", "opencode.recovery.candidate_failed", {
          targetId: change.targetId,
          sessionId: candidate.id,
          ...normalizeError(error),
        });
      }
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
    // A new managed target can be published directly (installManagedTarget does
    // not require an intervening unresolved state). Abort work belonging to any
    // other target so an obsolete target's recovery cannot act on the new one.
    cancelOtherTargets(change.targetId);
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

/** Cancel in-flight work for every target EXCEPT the one being kept. */
function cancelOtherTargets(keepTargetId: number): void {
  const prefix = `${keepTargetId}:`;
  for (const [key, controller] of sessionControllers) {
    if (!key.startsWith(prefix)) controller.abort();
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
  lastOutcome = null;
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
  lastOutcome: string | null;
} {
  return {
    started,
    processedTargets: processedTargets.size,
    inFlight: sessionControllers.size,
    lastOutcome,
  };
}
