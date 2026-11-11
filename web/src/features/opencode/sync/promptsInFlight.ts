/**
 * The registry of prompts this client has sent and the server has not
 * answered.
 *
 * Sole mutable admission authority. It owns prompt identity/session association,
 * submission/admission phases, admission verdict, field-level admission metadata,
 * evidence provenance/conflict history, admission and outcome waiters,
 * independent retention protections, and bounded retention/capacity policy.
 *
 * Verdict settlement is separate from metadata enrichment: a verdict settles once
 * (with ambiguous resolvable by later valid evidence), while metadata may be
 * enriched monotonically after admission without notifying admission waiters
 * twice or regressing the verdict.
 */

import {
  OPENCODE_V2_RETENTION_CAP,
  OPENCODE_V2_RETENTION_TTL_MS,
} from "@/features/opencode/config";

export type V2PromptAdmissionResult = "admitted" | "definitive-failure" | "ambiguous" | "disposed";

export type V2PromptPhase = "submitting" | "admitted" | "reconciling" | "terminal";

export type V2PromptSubmission = {
  readonly messageId: string;
  /** Null when admission is proven from history but inbox metadata is unavailable. */
  readonly inboxId: string | null;
  /** Null when admission is proven from history but delivery is unknown. */
  readonly delivery: "steer" | "queue" | null;
};

export type V2AdmissionField = "inboxId" | "delivery" | "serverMessageId" | "admissionMode";

export type V2AdmissionEvidenceSource =
  | "http-response"
  | "inbox-event"
  | "history"
  | "inbox-list"
  | "local-observation"
  | "reconciliation";

export interface V2AdmissionEvidenceIdentity {
  readonly source: V2AdmissionEvidenceSource;
  readonly strength: number;
  readonly sessionId: string;
  readonly promptId: string;
  readonly requestId: string | null;
  readonly serverEventId: string | null;
  readonly inboxId: string | null;
  readonly at: number;
}

export interface V2AdmissionFieldState<T> {
  readonly value: T;
  readonly evidence: V2AdmissionEvidenceIdentity | null;
  readonly conflicted: boolean;
  readonly history: readonly V2AdmissionEvidenceIdentity[];
}

export interface V2PromptAdmissionRecordSnapshot {
  readonly promptId: string;
  readonly sessionId: string;
  readonly phase: V2PromptPhase;
  readonly verdict: V2PromptAdmissionResult | null;
  readonly terminal: V2PromptAdmissionResult | null;
  readonly inboxId: V2AdmissionFieldState<string | null>;
  readonly delivery: V2AdmissionFieldState<"steer" | "queue" | null>;
  readonly serverMessageId: V2AdmissionFieldState<string | null>;
  readonly admissionMode: V2AdmissionFieldState<string | null>;
  readonly protectedOwners: readonly string[];
  readonly touchedAt: number;
}

/**
 * What the admission registry can accept right now.
 *
 * The caps are policy, the counts are measured, and `backpressure` is the single
 * answer to "would `create` refuse?". It is derived on every snapshot so a
 * capacity notice can never disagree with the admission decision it describes.
 */
export interface V2PromptCapacitySnapshot {
  readonly size: number;
  readonly softCap: number;
  readonly protectedCap: number;
  readonly hardCap: number;
  readonly protectedCount: number;
  readonly evictableCount: number;
  readonly atSoftCap: boolean;
  readonly atProtectedCap: boolean;
  readonly atHardCap: boolean;
  readonly backpressure: boolean;
}

export interface PromptsInFlightSnapshot {
  readonly records: readonly V2PromptAdmissionRecordSnapshot[];
  readonly size: number;
  readonly protectedCount: number;
  readonly capacity: V2PromptCapacitySnapshot;
}

/**
 * One record as it stood before a lifecycle transition.
 *
 * Protection TOKENS are captured, not just owners: a rollback must leave the
 * exact capabilities a caller already holds intact, or the later
 * `releaseProtection(token)` would silently release nothing.
 */
export interface V2PromptAdmissionRestoreRecord extends V2PromptAdmissionRecordSnapshot {
  readonly protectedTokens: readonly (readonly [string, V2PromptProtectionOwner])[];
}

export interface PromptsInFlightRestorePoint {
  readonly records: readonly V2PromptAdmissionRestoreRecord[];
}

export type V2PromptProtectionOwner =
  | "admission-waiter"
  | "outcome-waiter"
  | "cancellation-intent"
  | "controller-binding"
  | string;

export interface V2PromptCapacityPolicy {
  readonly softCap: number;
  readonly protectedCap: number;
  readonly hardCap: number;
  readonly ttlMs: number;
}

export type V2PromptCreateResult =
  | {
      readonly ok: true;
      readonly record: V2PromptAdmissionRecordSnapshot;
      readonly capacity: V2PromptCapacitySnapshot;
    }
  | {
      readonly ok: false;
      readonly reason: "capacity-backpressure";
      readonly message: string;
      readonly capacity: V2PromptCapacitySnapshot;
    };

export interface V2AdmissionEvidenceInput {
  readonly sessionId: string;
  readonly promptId: string;
  readonly source: V2AdmissionEvidenceSource;
  readonly requestId?: string | null;
  readonly serverEventId?: string | null;
  readonly inboxId?: string | null;
  readonly delivery?: "steer" | "queue" | null;
  readonly serverMessageId?: string | null;
  readonly admissionMode?: string | null;
  readonly at?: number;
  /** Exact inbox-event correlation proof established by the caller/controller. */
  readonly exactCorrelation?: boolean;
  /** HTTP request-to-inbox correlation already established for same operation/prompt. */
  readonly establishedRequestCorrelation?: boolean;
}

export interface PromptsInFlight {
  create(sessionId: string, promptId: string): V2PromptCreateResult;
  get(promptId: string): V2PromptAdmissionRecordSnapshot | undefined;
  getSnapshot(): PromptsInFlightSnapshot;
  /** Settles verdict once; ambiguous may later resolve to admitted. */
  settleVerdict(
    promptId: string,
    verdict: V2PromptAdmissionResult,
    evidence?: V2AdmissionEvidenceInput,
  ): V2PromptAdmissionRecordSnapshot | undefined;
  /** Monotonic field-level enrichment; never notifies admission waiters twice. */
  enrich(
    promptId: string,
    evidence: V2AdmissionEvidenceInput,
  ): V2PromptAdmissionRecordSnapshot | undefined;
  markAmbiguous(
    promptId: string,
    evidence?: V2AdmissionEvidenceInput,
  ): V2PromptAdmissionRecordSnapshot | undefined;
  /** Current admission verdict/result snapshot (non-waiting). */
  getAdmissionResult(promptId: string): V2PromptAdmissionResult | null;
  /** Waits for any admission verdict (including ambiguous). */
  awaitAdmissionObserved(promptId: string): Promise<V2PromptAdmissionResult>;
  /** Waits for definitive admission resolution; remains eligible across ambiguity. */
  awaitAdmission(promptId: string): Promise<V2PromptAdmissionResult>;
  awaitAdmissionWithDeadline(promptId: string, timeoutMs: number): Promise<V2PromptAdmissionResult>;
  awaitOutcome(promptId: string): Promise<V2PromptAdmissionResult>;
  acquireProtection(
    promptId: string,
    owner: V2PromptProtectionOwner,
    token?: string,
  ): string | null;
  releaseProtection(promptId: string, ownerToken: string): void;
  /**
   * Captures every record so a failed multi-fact transition can be rolled back.
   *
   * Deliberately excludes waiter callbacks: they belong to live callers, not to
   * the facts being restored.
   */
  captureRestorePoint(): PromptsInFlightRestorePoint;
  restoreRestorePoint(point: PromptsInFlightRestorePoint): void;
  /** Defers admission/outcome waiter callbacks until flush or discard. */
  beginNotificationDeferral(): void;
  flushNotificationDeferral(): void;
  discardNotificationDeferral(): void;
  disposeAll(): void;
  sweep(now?: number): "none" | "protected";
  readonly size: number;
  readonly protectedCount: number;
}

type Waiter = (result: V2PromptAdmissionResult) => void;

type FieldRecord<T> = {
  value: T;
  evidence: V2AdmissionEvidenceIdentity | null;
  conflicted: boolean;
  history: V2AdmissionEvidenceIdentity[];
};

type AdmissionRecord = {
  promptId: string;
  sessionId: string;
  phase: V2PromptPhase;
  verdict: V2PromptAdmissionResult | null;
  terminal: V2PromptAdmissionResult | null;
  inboxId: FieldRecord<string | null>;
  delivery: FieldRecord<"steer" | "queue" | null>;
  serverMessageId: FieldRecord<string | null>;
  admissionMode: FieldRecord<string | null>;
  /** Definitive admission waiters: remain eligible across ambiguity. */
  admissionWaiters: Set<Waiter>;
  /** Deadline/caller waiters: may resolve on ambiguity for that caller. */
  admissionDeadlineWaiters: Set<Waiter>;
  outcomeWaiters: Set<Waiter>;
  protections: Map<string, V2PromptProtectionOwner>;
  touchedAt: number;
};

const DEFAULT_POLICY: V2PromptCapacityPolicy = {
  softCap: OPENCODE_V2_RETENTION_CAP,
  protectedCap: Math.max(OPENCODE_V2_RETENTION_CAP, OPENCODE_V2_RETENTION_CAP * 2),
  hardCap: Math.max(OPENCODE_V2_RETENTION_CAP * 4, 1024),
  ttlMs: OPENCODE_V2_RETENTION_TTL_MS,
};

function sourceStrength(source: V2AdmissionEvidenceSource): number {
  switch (source) {
    case "http-response":
      return 4;
    case "inbox-event":
      return 4;
    case "history":
      return 3;
    case "inbox-list":
      return 3;
    case "reconciliation":
      return 2;
    case "local-observation":
      return 1;
    default:
      return 0;
  }
}

function evidenceIdentity(input: V2AdmissionEvidenceInput): V2AdmissionEvidenceIdentity {
  return {
    source: input.source,
    strength: sourceStrength(input.source),
    sessionId: input.sessionId,
    promptId: input.promptId,
    requestId: input.requestId ?? null,
    serverEventId: input.serverEventId ?? null,
    inboxId: input.inboxId ?? null,
    at: input.at ?? Date.now(),
  };
}

function isExactInboxCorrelation(
  input: V2AdmissionEvidenceInput,
  record: AdmissionRecord,
): boolean {
  if (input.source !== "inbox-event") return true;
  if (input.sessionId !== record.sessionId) return false;
  if (input.exactCorrelation === true) return true;
  if (
    input.establishedRequestCorrelation === true &&
    input.inboxId !== null &&
    input.inboxId !== undefined
  ) {
    return true;
  }
  // Direct equality between event inbox ID and local prompt ID is the only other
  // allowed proof. Never correlate by text/order/adjacency/active-send/only-pending.
  return input.inboxId === record.promptId;
}

function emptyField<T>(value: T): FieldRecord<T> {
  return { value, evidence: null, conflicted: false, history: [] };
}

function snapshotField<T>(field: FieldRecord<T>): V2AdmissionFieldState<T> {
  return {
    value: field.value,
    evidence: field.evidence,
    conflicted: field.conflicted,
    history: [...field.history],
  };
}

function restoreField<T>(field: V2AdmissionFieldState<T>): FieldRecord<T> {
  return {
    value: field.value,
    evidence: field.evidence,
    conflicted: field.conflicted,
    history: [...field.history],
  };
}

function snapshotRecord(record: AdmissionRecord): V2PromptAdmissionRecordSnapshot {
  return {
    promptId: record.promptId,
    sessionId: record.sessionId,
    phase: record.phase,
    verdict: record.verdict,
    terminal: record.terminal,
    inboxId: snapshotField(record.inboxId),
    delivery: snapshotField(record.delivery),
    serverMessageId: snapshotField(record.serverMessageId),
    admissionMode: snapshotField(record.admissionMode),
    protectedOwners: [...record.protections.keys()],
    touchedAt: record.touchedAt,
  };
}

function canEvict(record: AdmissionRecord): boolean {
  if (record.protections.size > 0) return false;
  if (record.terminal !== null) return true;
  // Admitted prompts are settled for admission purposes and evictable once no
  // protections remain (metadata may have been enriched monotonically).
  return record.verdict === "admitted";
}

function mergeField<T>(
  field: FieldRecord<T>,
  nextValue: T | null | undefined,
  evidence: V2AdmissionEvidenceIdentity,
): void {
  if (nextValue === undefined) return;
  const value = nextValue as T;
  if (field.evidence === null) {
    field.value = value;
    field.evidence = evidence;
    field.history.push(evidence);
    return;
  }
  if (Object.is(field.value, value)) {
    if (evidence.strength >= field.evidence.strength) field.evidence = evidence;
    field.history.push(evidence);
    return;
  }
  if (evidence.strength > field.evidence.strength) {
    field.value = value;
    field.evidence = evidence;
    field.conflicted = false;
    field.history.push(evidence);
    return;
  }
  if (evidence.strength === field.evidence.strength) {
    field.conflicted = true;
    field.history.push(evidence);
    return;
  }
  // Weaker or missing evidence cannot erase stronger known values.
  field.history.push(evidence);
}

export function createPromptsInFlight(
  policy: V2PromptCapacityPolicy = DEFAULT_POLICY,
): PromptsInFlight {
  const records = new Map<string, AdmissionRecord>();
  let protectionSeq = 0;
  let deferralDepth = 0;
  const deferredNotifications: Array<
    | {
        readonly kind: "admission";
        readonly record: AdmissionRecord;
        readonly result: V2PromptAdmissionResult;
      }
    | { readonly kind: "admission-ambiguous"; readonly record: AdmissionRecord }
    | {
        readonly kind: "outcome";
        readonly record: AdmissionRecord;
        readonly result: V2PromptAdmissionResult;
      }
  > = [];

  function touch(record: AdmissionRecord, now = Date.now()): void {
    record.touchedAt = now;
  }

  function sweep(now = Date.now()): "none" | "protected" {
    for (const [id, record] of [...records]) {
      if (!canEvict(record)) continue;
      if (now - record.touchedAt < policy.ttlMs) continue;
      records.delete(id);
    }
    if (records.size <= policy.softCap) return "none";
    const evictable = [...records.values()]
      .filter(canEvict)
      .sort((a, b) => a.touchedAt - b.touchedAt);
    const toEvict = records.size - policy.softCap;
    if (evictable.length < toEvict) {
      for (const record of evictable) records.delete(record.promptId);
      return records.size > policy.softCap ? "protected" : "none";
    }
    for (let i = 0; i < toEvict; i++) records.delete(evictable[i].promptId);
    return records.size > policy.softCap ? "protected" : "none";
  }

  function ensureRecord(sessionId: string, promptId: string): AdmissionRecord {
    const existing = records.get(promptId);
    if (existing) {
      touch(existing);
      return existing;
    }
    const record: AdmissionRecord = {
      promptId,
      sessionId,
      phase: "submitting",
      verdict: null,
      terminal: null,
      inboxId: emptyField<string | null>(null),
      delivery: emptyField<"steer" | "queue" | null>(null),
      serverMessageId: emptyField<string | null>(null),
      admissionMode: emptyField<string | null>(null),
      admissionWaiters: new Set(),
      admissionDeadlineWaiters: new Set(),
      outcomeWaiters: new Set(),
      protections: new Map(),
      touchedAt: Date.now(),
    };
    records.set(promptId, record);
    return record;
  }

  function notifyAdmission(record: AdmissionRecord, result: V2PromptAdmissionResult): void {
    if (deferralDepth > 0) {
      deferredNotifications.push({ kind: "admission", record, result });
      return;
    }
    for (const waiter of record.admissionWaiters) waiter(result);
    record.admissionWaiters.clear();
    for (const waiter of record.admissionDeadlineWaiters) waiter(result);
    record.admissionDeadlineWaiters.clear();
  }

  function deliverAdmission(record: AdmissionRecord, result: V2PromptAdmissionResult): void {
    for (const waiter of record.admissionWaiters) waiter(result);
    record.admissionWaiters.clear();
    for (const waiter of record.admissionDeadlineWaiters) waiter(result);
    record.admissionDeadlineWaiters.clear();
  }

  function notifyAdmissionAmbiguous(record: AdmissionRecord): void {
    if (deferralDepth > 0) {
      deferredNotifications.push({ kind: "admission-ambiguous", record });
      return;
    }
    // Deadline/caller waiters may observe ambiguity; definitive waiters remain eligible.
    for (const waiter of record.admissionDeadlineWaiters) waiter("ambiguous");
    record.admissionDeadlineWaiters.clear();
  }

  function notifyOutcome(record: AdmissionRecord, result: V2PromptAdmissionResult): void {
    if (deferralDepth > 0) {
      deferredNotifications.push({ kind: "outcome", record, result });
      return;
    }
    for (const waiter of record.outcomeWaiters) waiter(result);
    record.outcomeWaiters.clear();
  }

  function applyEvidence(record: AdmissionRecord, input: V2AdmissionEvidenceInput): void {
    if (input.sessionId !== record.sessionId) return;
    if (!isExactInboxCorrelation(input, record)) return;
    const identity = evidenceIdentity(input);
    mergeField(record.inboxId, input.inboxId, identity);
    mergeField(record.delivery, input.delivery, identity);
    mergeField(record.serverMessageId, input.serverMessageId, identity);
    mergeField(record.admissionMode, input.admissionMode, identity);
    touch(record);
  }

  function setPhaseFromVerdict(record: AdmissionRecord): void {
    if (record.terminal !== null && record.terminal !== "ambiguous") {
      record.phase = "terminal";
      return;
    }
    if (record.verdict === "admitted") {
      record.phase = "admitted";
      return;
    }
    if (record.verdict === "ambiguous") {
      record.phase = "reconciling";
      return;
    }
    record.phase = "submitting";
  }

  function settleVerdict(
    promptId: string,
    verdict: V2PromptAdmissionResult,
    evidence?: V2AdmissionEvidenceInput,
  ): V2PromptAdmissionRecordSnapshot | undefined {
    const record = records.get(promptId);
    if (!record) return undefined;
    if (evidence) applyEvidence(record, evidence);

    if (record.terminal !== null && record.terminal !== "ambiguous") {
      return snapshotRecord(record);
    }

    if (verdict === "admitted") {
      if (record.verdict !== "admitted") {
        record.verdict = "admitted";
        record.terminal = "admitted";
        setPhaseFromVerdict(record);
        notifyAdmission(record, "admitted");
      } else if (record.terminal === null) {
        record.terminal = "admitted";
      }
      // Metadata enrichment after admission is allowed; verdict does not regress.
      touch(record);
      sweep();
      return snapshotRecord(record);
    }

    if (verdict === "ambiguous") {
      // Ambiguity is a lifecycle/projection state. Definitive admission waiters
      // remain eligible for later admitted/definitive evidence; deadline/caller
      // waiters may observe ambiguity. Outcome waiters retain their semantics.
      if (record.verdict === null || record.verdict === "ambiguous") {
        record.verdict = "ambiguous";
        record.terminal = "ambiguous";
        setPhaseFromVerdict(record);
        notifyAdmissionAmbiguous(record);
      }
      touch(record);
      sweep();
      return snapshotRecord(record);
    }

    // definitive-failure or disposed
    if (record.verdict === "admitted") {
      // Never regress an admitted verdict.
      touch(record);
      return snapshotRecord(record);
    }
    if (record.verdict === null || record.verdict === "ambiguous") {
      record.verdict = verdict;
      record.terminal = verdict;
      setPhaseFromVerdict(record);
      notifyAdmission(record, verdict);
      notifyOutcome(record, verdict);
    }
    touch(record);
    sweep();
    return snapshotRecord(record);
  }

  function markAmbiguous(promptId: string, evidence?: V2AdmissionEvidenceInput) {
    return settleVerdict(promptId, "ambiguous", evidence);
  }

  function enrich(promptId: string, evidence: V2AdmissionEvidenceInput) {
    const record = records.get(promptId);
    if (!record) return undefined;
    applyEvidence(record, evidence);
    // Enrichment must never notify admission waiters twice or regress verdict.
    if (record.verdict === "admitted") record.phase = "admitted";
    sweep();
    return snapshotRecord(record);
  }

  function acquireProtection(
    promptId: string,
    owner: V2PromptProtectionOwner,
    token?: string,
  ): string | null {
    const record = records.get(promptId);
    if (!record) return null;
    const ownerToken = token ?? `${owner}:${promptId}:${++protectionSeq}`;
    record.protections.set(ownerToken, owner);
    touch(record);
    return ownerToken;
  }

  function releaseProtection(promptId: string, ownerToken: string): void {
    const record = records.get(promptId);
    if (!record) return;
    record.protections.delete(ownerToken);
    touch(record);
    sweep();
  }

  function capacitySnapshot(): V2PromptCapacitySnapshot {
    const protectedCount = [...records.values()].filter((r) => r.protections.size > 0).length;
    const evictableCount = [...records.values()].filter(canEvict).length;
    const atSoftCap = records.size >= policy.softCap;
    const atProtectedCap = protectedCount >= policy.protectedCap;
    const atHardCap = records.size >= policy.hardCap;
    return {
      size: records.size,
      softCap: policy.softCap,
      protectedCap: policy.protectedCap,
      hardCap: policy.hardCap,
      protectedCount,
      evictableCount,
      atSoftCap,
      atProtectedCap,
      atHardCap,
      // A full registry with evictable entries is not backpressure: `create`
      // sweeps down to the soft cap before deciding. Only an unmakeable space
      // (every entry live or protected) refuses admission.
      backpressure: atProtectedCap || (atHardCap && evictableCount === 0),
    };
  }

  function create(sessionId: string, promptId: string): V2PromptCreateResult {
    const existing = records.get(promptId);
    if (existing) {
      touch(existing);
      return { ok: true, record: snapshotRecord(existing), capacity: capacitySnapshot() };
    }
    // Honouring the soft cap is what makes backpressure recoverable: settled
    // entries are evicted here rather than waiting for a TTL sweep that may not
    // run until the registry is already full.
    if (records.size >= policy.softCap) sweep();
    const capacity = capacitySnapshot();
    if (capacity.backpressure) {
      return {
        ok: false,
        reason: "capacity-backpressure",
        message: "Prompt admission capacity is exhausted; retry after in-flight prompts settle.",
        capacity,
      };
    }
    const record = ensureRecord(sessionId, promptId);
    sweep();
    return { ok: true, record: snapshotRecord(record), capacity: capacitySnapshot() };
  }

  function awaitAdmissionObserved(promptId: string): Promise<V2PromptAdmissionResult> {
    const record = records.get(promptId) ?? ensureRecord("", promptId);
    const current = getAdmissionResult(promptId);
    if (current !== null) return Promise.resolve(current);
    const token = acquireProtection(promptId, "admission-waiter");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: V2PromptAdmissionResult) => {
        if (settled) return;
        settled = true;
        record.admissionDeadlineWaiters.delete(waiter);
        if (token) releaseProtection(promptId, token);
        resolve(result);
      };
      const waiter: Waiter = (result) => finish(result);
      record.admissionDeadlineWaiters.add(waiter);
    });
  }

  function awaitAdmission(promptId: string): Promise<V2PromptAdmissionResult> {
    const record = records.get(promptId) ?? ensureRecord("", promptId);
    if (record.verdict === "admitted") return Promise.resolve("admitted");
    if (record.terminal === "definitive-failure" || record.terminal === "disposed") {
      return Promise.resolve(record.terminal);
    }
    // Ambiguous verdict is not a definitive admission resolution for waiters;
    // remain eligible for later admitted/definitive evidence.
    const token = acquireProtection(promptId, "admission-waiter");
    return new Promise((resolve) => {
      record.admissionWaiters.add((result) => {
        if (token) releaseProtection(promptId, token);
        resolve(result);
      });
    });
  }

  function awaitOutcome(promptId: string): Promise<V2PromptAdmissionResult> {
    const record = records.get(promptId) ?? ensureRecord("", promptId);
    if (
      record.terminal === "admitted" ||
      record.terminal === "definitive-failure" ||
      record.terminal === "disposed"
    ) {
      return Promise.resolve(record.terminal);
    }
    // Ambiguous is not a terminal outcome; outcome waiters remain eligible.
    const token = acquireProtection(promptId, "outcome-waiter");
    return new Promise((resolve) => {
      record.outcomeWaiters.add((result) => {
        if (token) releaseProtection(promptId, token);
        resolve(result);
      });
    });
  }

  function awaitAdmissionWithDeadline(
    promptId: string,
    timeoutMs: number,
  ): Promise<V2PromptAdmissionResult> {
    const record = records.get(promptId) ?? ensureRecord("", promptId);
    if (record.verdict === "admitted") return Promise.resolve("admitted");
    if (record.terminal === "definitive-failure" || record.terminal === "disposed") {
      return Promise.resolve(record.terminal);
    }
    if (record.verdict === "ambiguous") return Promise.resolve("ambiguous");
    const token = acquireProtection(promptId, "admission-waiter");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: V2PromptAdmissionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.admissionDeadlineWaiters.delete(waiter);
        if (token) releaseProtection(promptId, token);
        resolve(result);
      };
      const waiter: Waiter = (result) => {
        finish(result);
      };
      const timer = setTimeout(() => {
        // Caller-specific deadline: return ambiguous to this caller only.
        finish("ambiguous");
      }, timeoutMs);
      record.admissionDeadlineWaiters.add(waiter);
    });
  }

  function get(promptId: string): V2PromptAdmissionRecordSnapshot | undefined {
    const record = records.get(promptId);
    return record ? snapshotRecord(record) : undefined;
  }

  function getAdmissionResult(promptId: string): V2PromptAdmissionResult | null {
    const record = records.get(promptId);
    if (!record) return null;
    if (record.verdict === "admitted") return "admitted";
    if (record.terminal === "definitive-failure" || record.terminal === "disposed")
      return record.terminal;
    if (record.verdict === "ambiguous") return "ambiguous";
    return null;
  }

  function captureRestorePoint(): PromptsInFlightRestorePoint {
    return {
      records: [...records.values()].map((record) => ({
        ...snapshotRecord(record),
        protectedTokens: [...record.protections.entries()],
      })),
    };
  }

  function restoreRestorePoint(point: PromptsInFlightRestorePoint): void {
    const captured = new Set(point.records.map((record) => record.promptId));
    for (const promptId of [...records.keys()]) {
      if (captured.has(promptId)) continue;
      const record = records.get(promptId);
      // A record created by the failed transition is not part of last-known-good.
      // It is kept only when a live caller waits on it: deleting it would strand
      // that promise, and reconciliation can still settle it honestly.
      if (!record) continue;
      if (
        record.admissionWaiters.size === 0 &&
        record.admissionDeadlineWaiters.size === 0 &&
        record.outcomeWaiters.size === 0
      ) {
        records.delete(promptId);
      }
    }
    for (const snapshot of point.records) {
      const existing = records.get(snapshot.promptId);
      const restored: AdmissionRecord = {
        promptId: snapshot.promptId,
        sessionId: snapshot.sessionId,
        phase: snapshot.phase,
        verdict: snapshot.verdict,
        terminal: snapshot.terminal,
        inboxId: restoreField(snapshot.inboxId),
        delivery: restoreField(snapshot.delivery),
        serverMessageId: restoreField(snapshot.serverMessageId),
        admissionMode: restoreField(snapshot.admissionMode),
        admissionWaiters: existing?.admissionWaiters ?? new Set(),
        admissionDeadlineWaiters: existing?.admissionDeadlineWaiters ?? new Set(),
        outcomeWaiters: existing?.outcomeWaiters ?? new Set(),
        protections: new Map(snapshot.protectedTokens),
        touchedAt: snapshot.touchedAt,
      };
      records.set(snapshot.promptId, restored);
    }
  }

  function beginNotificationDeferral(): void {
    deferralDepth += 1;
  }

  function flushNotificationDeferral(): void {
    if (deferralDepth === 0) return;
    deferralDepth -= 1;
    if (deferralDepth > 0) return;
    const pending = deferredNotifications.splice(0);
    for (const notification of pending) {
      switch (notification.kind) {
        case "admission":
          deliverAdmission(notification.record, notification.result);
          break;
        case "admission-ambiguous":
          for (const waiter of notification.record.admissionDeadlineWaiters) waiter("ambiguous");
          notification.record.admissionDeadlineWaiters.clear();
          break;
        case "outcome":
          for (const waiter of notification.record.outcomeWaiters) waiter(notification.result);
          notification.record.outcomeWaiters.clear();
          break;
      }
    }
  }

  function discardNotificationDeferral(): void {
    if (deferralDepth === 0) return;
    deferralDepth -= 1;
    if (deferralDepth > 0) return;
    // Waiters were never told: the facts they were told about were rolled back.
    deferredNotifications.length = 0;
  }

  function getSnapshot(): PromptsInFlightSnapshot {
    const all = [...records.values()].map(snapshotRecord);
    return {
      records: all,
      size: records.size,
      protectedCount: all.filter((r) => r.protectedOwners.length > 0).length,
      capacity: capacitySnapshot(),
    };
  }

  function disposeAll(): void {
    for (const promptId of [...records.keys()]) settleVerdict(promptId, "disposed");
  }

  return {
    create,
    get,
    getSnapshot,
    settleVerdict,
    enrich,
    markAmbiguous,
    getAdmissionResult,
    awaitAdmissionObserved,
    awaitAdmission,
    awaitAdmissionWithDeadline,
    awaitOutcome,
    acquireProtection,
    releaseProtection,
    captureRestorePoint,
    restoreRestorePoint,
    beginNotificationDeferral,
    flushNotificationDeferral,
    discardNotificationDeferral,
    disposeAll,
    sweep,
    get size() {
      return records.size;
    },
    get protectedCount() {
      return [...records.values()].filter((r) => r.protections.size > 0).length;
    },
  };
}
