import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";
import { createGatedTransport, type OpenCodeTransport } from "./http";
import { isOpenCodeVersionAtLeast, isStableReleaseVersion, parseOpenCodeVersion } from "./runtime";

/**
 * B7 — stable-version and capability compatibility.
 *
 * There is no upper version bound anywhere (B7, owner-approved 2026-10-31): a
 * newer STABLE release is not refused for being newer. What a build must
 * actually provide is proven on the live service, not assumed from its number:
 *
 *  - the build must be a stable release at or above the oldest build whose
 *    essential API TBAi has checked (below it the surface is unknown, not new);
 *  - the essential capabilities are PROBED on the live service;
 *  - a missing OPTIONAL capability degrades that feature and never blocks chat.
 *
 * An adopted service is somebody else's process, so its caller supplies the
 * attempt-bound transport and the probe stays a read. A managed child is this
 * manager's own process, started only after its binary passed the preflight;
 * {@link readManagedCapabilities} re-checks the same routes through the same
 * gated transport before the start is handed out, so a build that reports an
 * acceptable version but does not serve the API is refused rather than
 * handed to callers.
 *
 * This module is the one place a version-dependent decision may live. Callers
 * read a capability snapshot, never a version string, so a future stable
 * release changes behaviour in one file.
 *
 * What this cannot establish is compatibility END TO END — that a prompt round
 * trip works on a given build. That remains E1/B5 evidence, which is still
 * open.
 */

/** A server-wide capability TBAi reads without creating or mutating a session. */
export type OpenCodeCapabilityId = "session" | "events" | "config" | "agent" | "model" | "command";

/** What was learned about one installed adopted service. */
export interface OpenCodeServiceCapabilities {
  /** The build's own reported version, unchanged. */
  readonly version: string;
  /** Per capability, whether the service answered its route. */
  readonly supported: Readonly<Record<OpenCodeCapabilityId, boolean>>;
}

/** The result of reading one route: presence must be proven, absence is 404/405. */
export type OpenCodeCapabilityProbeOutcome = "present" | "missing" | "unknown";

/**
 * The routes probed after the readiness check.
 *
 * `session` and `events` are ESSENTIAL: without them a conversation cannot be
 * created, resumed or streamed, so their absence refuses adoption.
 *
 * `config`, `agent`, `model` and `command` are OPTIONAL: each backs a picker or
 * settings surface that already degrades on its own, so their absence is
 * recorded (and the feature can be hidden) instead of blocking adoption.
 *
 * Every probe is a GET of a server-wide route. None creates or mutates
 * anything on the adopted service, which is what keeps adoption a read of
 * somebody else's process rather than a write to it.
 */
export const OPENCODE_CAPABILITY_PROBES: readonly Readonly<{
  id: OpenCodeCapabilityId;
  path: string;
  essential: boolean;
  expectsEventStream?: boolean;
}>[] = Object.freeze([
  Object.freeze({ id: "session", path: "/api/session", essential: true }),
  Object.freeze({ id: "events", path: "/api/event", essential: true, expectsEventStream: true }),
  Object.freeze({ id: "config", path: "/api/config", essential: false }),
  Object.freeze({ id: "agent", path: "/api/agent", essential: false }),
  Object.freeze({ id: "model", path: "/api/model", essential: false }),
  Object.freeze({ id: "command", path: "/api/command", essential: false }),
] as const);

const ESSENTIAL_CAPABILITIES: readonly OpenCodeCapabilityId[] = Object.freeze(
  OPENCODE_CAPABILITY_PROBES.filter((probe) => probe.essential).map((probe) => probe.id),
);

const SSE_CONTENT_TYPE = "text/event-stream";
const STATUS_OK_MIN = 200;
const STATUS_OK_MAX_EXCLUSIVE = 300;
const STATUS_UNAVAILABLE: readonly number[] = [404, 405];

/** The version classes an adoption attempt can reach. */
export type OpenCodeVersionVerdict =
  | Readonly<{ status: "adoptable"; version: string; belowCheckedFloor: boolean }>
  | Readonly<{ status: "malformed"; version: string }>
  | Readonly<{ status: "unstable"; version: string }>;

/**
 * Classifies a build for ADOPTION (D2 + B7).
 *
 * Neither bound of the managed gate refuses a build here. The ceiling is a
 * managed-release pin, and the `minimumVersion` floor is an **evidence**
 * boundary: it names the oldest build whose essential API TBAi has checked, not
 * a build proven to lack that API. Nothing in this repository has measured a
 * build at or below it (B5 is open), so refusing on it would be arbitrary - the
 * B7 decision says a service is refused only when its essential functionality
 * is actually incompatible or a safety condition fails.
 *
 * The live capability read decides that ({@link assessOpenCodeCompatibility}).
 * `belowCheckedFloor` records that an adoption rests on the probe alone rather
 * than on prior evidence, so the status can report it without changing the
 * verdict.
 *
 * D2 stable-only remains: a malformed or prerelease version is refused before
 * any capability request is made.
 */
export function classifyAdoptionVersion(
  version: string,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): OpenCodeVersionVerdict {
  if (parseOpenCodeVersion(version) === null)
    return Object.freeze({ status: "malformed", version });
  if (!isStableReleaseVersion(version)) return Object.freeze({ status: "unstable", version });
  return Object.freeze({
    status: "adoptable",
    version,
    belowCheckedFloor: !isOpenCodeVersionAtLeast(version, config.minimumVersion),
  });
}

/**
 * Reads every capability route once, in table order.
 *
 * Sequential on purpose: adoption must stay a light read of a service TBAi does
 * not own. A 3xx is refused by the transport before this sees it. Bodies are
 * cancelled immediately — the answers are statuses, not payloads.
 *
 * A transport failure is `unknown`, not `missing`: silence is not evidence of
 * absence, and the caller decides whether that is fatal (essential) or merely
 * uninformative (optional).
 *
 * @param input - The attempt-bound origin and transport, plus its abort signal.
 * @returns One outcome per probed capability.
 * @throws When the transport refuses the request itself (origin, redirect,
 *   superseded attempt, shutdown); that is an attempt outcome, not a probe one.
 */
export async function probeOpenCodeCapabilities(input: {
  origin: string;
  transport: OpenCodeTransport;
  signal?: AbortSignal;
}): Promise<Record<OpenCodeCapabilityId, OpenCodeCapabilityProbeOutcome>> {
  const outcomes = {} as Record<OpenCodeCapabilityId, OpenCodeCapabilityProbeOutcome>;
  for (const probe of OPENCODE_CAPABILITY_PROBES) {
    outcomes[probe.id] = await probeOne(input, probe);
  }
  return outcomes;
}

async function probeOne(
  input: { origin: string; transport: OpenCodeTransport; signal?: AbortSignal },
  probe: (typeof OPENCODE_CAPABILITY_PROBES)[number],
): Promise<OpenCodeCapabilityProbeOutcome> {
  let response: Response;
  try {
    response = await input.transport(`${input.origin}${probe.path}`, {
      method: "GET",
      headers: { Accept: probe.expectsEventStream ? SSE_CONTENT_TYPE : "application/json" },
      signal: input.signal,
    });
  } catch (error) {
    if (isAbortError(error) || isAttemptRefusal(error)) throw error;
    return "unknown";
  }
  try {
    if (response.status >= STATUS_OK_MIN && response.status < STATUS_OK_MAX_EXCLUSIVE) {
      if (probe.expectsEventStream) {
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith(SSE_CONTENT_TYPE)) return "unknown";
      }
      return "present";
    }
    return STATUS_UNAVAILABLE.includes(response.status) ? "missing" : "unknown";
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/** The compatibility verdict for one adopted candidate. */
export type OpenCodeCompatibilityAssessment =
  | Readonly<{ status: "compatible"; capabilities: OpenCodeServiceCapabilities }>
  | Readonly<{
      status: "degraded";
      capabilities: OpenCodeServiceCapabilities;
      missingOptional: readonly OpenCodeCapabilityId[];
    }>
  | Readonly<{
      status: "incompatible";
      capabilities: OpenCodeServiceCapabilities;
      missingEssential: readonly OpenCodeCapabilityId[];
    }>
  | Readonly<{
      status: "indeterminate";
      capabilities: OpenCodeServiceCapabilities;
      unknownEssential: readonly OpenCodeCapabilityId[];
    }>;

/**
 * Turns probe outcomes into an adoption decision.
 *
 * - any essential route answered 404/405 -> `incompatible` (refuse; the managed
 *   path handles the conversation instead);
 * - an essential route could not be read -> `indeterminate` (refuse this
 *   attempt, exactly like a failed readiness probe: silence proves nothing);
 * - only optional routes absent -> `degraded` (adopt; record what is missing);
 * - everything answered -> `compatible`.
 *
 * `unknown` optional outcomes are recorded as supported: absence was not
 * proven, and hiding a feature the service may well have is worse than letting
 * that feature's own request report the truth.
 */
export function assessOpenCodeCompatibility(input: {
  version: string;
  probes: Record<OpenCodeCapabilityId, OpenCodeCapabilityProbeOutcome>;
}): OpenCodeCompatibilityAssessment {
  const supported = {} as Record<OpenCodeCapabilityId, boolean>;
  const missingEssential: OpenCodeCapabilityId[] = [];
  const unknownEssential: OpenCodeCapabilityId[] = [];
  const missingOptional: OpenCodeCapabilityId[] = [];

  for (const probe of OPENCODE_CAPABILITY_PROBES) {
    const outcome = input.probes[probe.id] ?? "unknown";
    supported[probe.id] = outcome !== "missing";
    if (probe.essential) {
      if (outcome === "missing") missingEssential.push(probe.id);
      else if (outcome === "unknown") unknownEssential.push(probe.id);
    } else if (outcome === "missing") {
      missingOptional.push(probe.id);
    }
  }

  const capabilities: OpenCodeServiceCapabilities = Object.freeze({
    version: input.version,
    supported: Object.freeze(supported),
  });

  if (missingEssential.length > 0) {
    return Object.freeze({
      status: "incompatible",
      capabilities,
      missingEssential: Object.freeze(missingEssential),
    });
  }
  if (unknownEssential.length > 0) {
    return Object.freeze({
      status: "indeterminate",
      capabilities,
      unknownEssential: Object.freeze(unknownEssential),
    });
  }
  if (missingOptional.length > 0) {
    return Object.freeze({
      status: "degraded",
      capabilities,
      missingOptional: Object.freeze(missingOptional),
    });
  }
  return Object.freeze({ status: "compatible", capabilities });
}

/** Thrown when a managed build does not serve an essential capability route. */
export class OpenCodeCapabilityRefusedError extends Error {
  readonly code = "OPENCODE_CAPABILITY_REFUSED";

  constructor(
    readonly version: string,
    readonly missingEssential: readonly OpenCodeCapabilityId[],
  ) {
    super(
      `OpenCode ${version} does not serve the required API (${missingEssential.join(", ")}); ` +
        "refusing to start against an incompatible build",
    );
    this.name = "OpenCodeCapabilityRefusedError";
  }
}

const REPORTED_VERSION_PATH = "/api/info";
const REPORTED_VERSION_UNKNOWN = "unknown";

/**
 * Reads a managed child's capability routes through the gated transport.
 *
 * The managed child is this process's own spawn, so the credential is the
 * managed password and the transport's initiation gate is a no-op — there is no
 * attempt to supersede. The origin check and redirect refusal still apply.
 *
 * The whole read is bounded by one `timeoutMs` signal. The reported version is
 * read here only for the verdict's diagnostics; readiness has already proven it
 * acceptable. An unreadable `/api/info` becomes `"unknown"` rather than a
 * guessed version.
 *
 * @throws When the transport rejects the request itself (origin, redirect,
 *   abort). That is a start outcome, not a capability verdict.
 */
export async function readManagedCapabilities(input: {
  origin: string;
  password: string;
  timeoutMs: number;
}): Promise<OpenCodeCompatibilityAssessment> {
  const transport = createGatedTransport(
    { origin: input.origin, credential: { password: input.password } },
    () => undefined,
  );
  const signal = AbortSignal.timeout(input.timeoutMs);
  const version = await readReportedVersion(transport, input.origin, signal);
  const probes = await probeOpenCodeCapabilities({
    origin: input.origin,
    transport,
    signal,
  });
  return assessOpenCodeCompatibility({ version, probes });
}

/** Reads `/api/info` for the reported version, or `"unknown"` when unavailable. */
async function readReportedVersion(
  transport: OpenCodeTransport,
  origin: string,
  signal: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await transport(`${origin}${REPORTED_VERSION_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (isAbortError(error) || isAttemptRefusal(error)) throw error;
    return REPORTED_VERSION_UNKNOWN;
  }
  try {
    if (response.status < STATUS_OK_MIN || response.status >= STATUS_OK_MAX_EXCLUSIVE) {
      return REPORTED_VERSION_UNKNOWN;
    }
    const payload: unknown = await response.json();
    const version =
      payload !== null && typeof payload === "object" ? Reflect.get(payload, "version") : null;
    return typeof version === "string" && version.length > 0 ? version : REPORTED_VERSION_UNKNOWN;
  } catch {
    return REPORTED_VERSION_UNKNOWN;
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/** True when the recorded snapshot says the capability is usable. */
export function isCapabilitySupported(
  capabilities: OpenCodeServiceCapabilities | null,
  id: OpenCodeCapabilityId,
): boolean {
  return capabilities === null || capabilities.supported[id] !== false;
}

/** The essential capability ids, exposed for refusal reporting and tests. */
export function essentialCapabilities(): readonly OpenCodeCapabilityId[] {
  return ESSENTIAL_CAPABILITIES;
}

/** Every probed capability id, in probe order. */
export function opencodeCapabilityIds(): readonly OpenCodeCapabilityId[] {
  return OPENCODE_CAPABILITY_PROBES.map((probe) => probe.id);
}

/** True when losing this capability blocks adoption rather than one feature. */
export function isEssentialCapability(id: OpenCodeCapabilityId): boolean {
  return ESSENTIAL_CAPABILITIES.includes(id);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && Reflect.get(error, "name") === "AbortError")
  );
}

/** Attempt-level refusals already carry their meaning; they are not probe data. */
function isAttemptRefusal(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
  return (
    code === "OPENCODE_ATTEMPT_SUPERSEDED" ||
    code === "OPENCODE_CONTEXT_INVALIDATED" ||
    code === "OPENCODE_REDIRECT_REFUSED" ||
    code === "OPENCODE_ORIGIN_MISMATCH"
  );
}

// ============================================================================
// Priority 1 — Session and message response structure validation
// ============================================================================

export interface OpenCodeSessionDescriptor {
  readonly id: string;
  readonly title?: string;
  readonly directory?: string;
  readonly projectID?: string;
  readonly time?: { created?: number; updated?: number };
}

export interface OpenCodeMessageDescriptor {
  readonly id: string;
  readonly sessionID?: string;
  readonly role?: string;
  readonly parts?: readonly unknown[];
}

export interface OpenCodeSessionMessagesPayload {
  readonly data: readonly OpenCodeMessageDescriptor[];
  readonly cursor?: { previous?: string | null; next?: string | null };
}

/** Extracts a session id from a bare session or { data: Session } envelope. */
export function extractSessionId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const target =
    "data" in data &&
    typeof (data as { data: unknown }).data === "object" &&
    (data as { data: unknown }).data !== null
      ? (data as { data: unknown }).data
      : data;
  if (!target || typeof target !== "object") return null;
  const id = Reflect.get(target, "id");
  return typeof id === "string" && id.trim().length > 0 ? id : null;
}

/** Validates that an individual session object contains required fields (bare or { data: Session } envelope). */
export function validateSessionStructure(data: unknown): data is OpenCodeSessionDescriptor {
  return extractSessionId(data) !== null;
}

/** Validates that a GET /api/session response is a valid list of session objects (bare array or { data: [...] }). */
export function validateSessionListResponse(
  payload: unknown,
): payload is
  | readonly OpenCodeSessionDescriptor[]
  | { readonly data: readonly OpenCodeSessionDescriptor[] } {
  if (Array.isArray(payload)) {
    return payload.every(validateSessionStructure);
  }
  if (!payload || typeof payload !== "object") return false;
  const data = Reflect.get(payload, "data");
  if (!Array.isArray(data)) return false;
  return data.every(validateSessionStructure);
}

/** Validates an individual message record structure. */
export function validateMessageStructure(data: unknown): data is OpenCodeMessageDescriptor {
  if (!data || typeof data !== "object") return false;
  const id = Reflect.get(data, "id");
  const role = Reflect.get(data, "role");
  if (typeof id !== "string" || id.trim().length === 0) return false;
  if (role !== undefined && typeof role !== "string") return false;
  return true;
}

/** Validates a session message list response (either direct array or { data: [...] } envelope). */
export function validateMessagesResponse(
  payload: unknown,
): payload is OpenCodeSessionMessagesPayload | readonly OpenCodeMessageDescriptor[] {
  if (Array.isArray(payload)) {
    return payload.every(validateMessageStructure);
  }
  if (!payload || typeof payload !== "object") return false;
  const data = Reflect.get(payload, "data");
  if (!Array.isArray(data)) return false;
  return data.every(validateMessageStructure);
}

// ============================================================================
// Priority 2 — SSE framing and parsing (fragmented chunks & malformed events)
// ============================================================================

export interface SseRawEvent {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

export interface OpenCodeWireEvent {
  readonly type: string;
  readonly id?: string;
  readonly created?: number;
  readonly data?: Record<string, unknown>;
  readonly durable?: { aggregateID: string; seq: number };
}

/**
 * Standard W3C Server-Sent Events stream parser.
 * Handles:
 *  - Arbitrary chunk boundaries (including multi-byte characters and split newlines)
 *  - CRLF (\r\n), LF (\n), and standalone CR (\r) newlines
 *  - Comment / keep-alive lines starting with `:`
 *  - Multi-line `data:` concatenation with newline
 *  - Event dispatch on empty line delimiter
 */
export class SseStreamParser {
  private buffer = "";
  private currentEvent?: string;
  private currentData: string[] = [];
  private currentId?: string;
  private currentRetry?: number;

  /** Feeds a text chunk into the parser and returns all newly framed events. */
  public feed(chunk: string): SseRawEvent[] {
    this.buffer += chunk;
    const events: SseRawEvent[] = [];

    while (true) {
      const newlineIdx = this.findNewline(this.buffer);
      if (newlineIdx === -1) break;
      const line = this.buffer.slice(0, newlineIdx);
      const isCrlf = this.buffer.startsWith("\r\n", newlineIdx);
      const advance = isCrlf ? 2 : 1;
      this.buffer = this.buffer.slice(newlineIdx + advance);

      if (line.length === 0) {
        // Empty line dispatches the buffered event
        if (
          this.currentData.length > 0 ||
          this.currentEvent !== undefined ||
          this.currentId !== undefined
        ) {
          events.push({
            event: this.currentEvent,
            data: this.currentData.join("\n"),
            id: this.currentId,
            retry: this.currentRetry,
          });
          this.currentEvent = undefined;
          this.currentData = [];
          this.currentId = undefined;
          this.currentRetry = undefined;
        }
        continue;
      }

      if (line.startsWith(":")) {
        // Comment or keepalive — ignore
        continue;
      }

      const colonIdx = line.indexOf(":");
      let field: string;
      let value: string;
      if (colonIdx === -1) {
        field = line;
        value = "";
      } else {
        field = line.slice(0, colonIdx);
        value = line.slice(colonIdx + 1);
        if (value.startsWith(" ")) {
          value = value.slice(1);
        }
      }

      switch (field) {
        case "event":
          this.currentEvent = value;
          break;
        case "data":
          this.currentData.push(value);
          break;
        case "id":
          this.currentId = value;
          break;
        case "retry": {
          const parsed = parseInt(value, 10);
          if (!Number.isNaN(parsed)) this.currentRetry = parsed;
          break;
        }
      }
    }

    return events;
  }

  private findNewline(str: string): number {
    for (let i = 0; i < str.length; i++) {
      if (str[i] === "\n") return i;
      if (str[i] === "\r") {
        if (i === str.length - 1) {
          // \r at the very end of chunk might be part of \r\n across chunks; hold
          return -1;
        }
        return i;
      }
    }
    return -1;
  }

  /** Resets internal parser state. */
  /** Flushes any trailing buffered state when the stream ends. */
  public flush(): SseRawEvent[] {
    const events: SseRawEvent[] = [];
    if (this.buffer === "\r" || this.buffer === "\n") {
      this.buffer = "";
      if (
        this.currentData.length > 0 ||
        this.currentEvent !== undefined ||
        this.currentId !== undefined
      ) {
        events.push({
          event: this.currentEvent,
          data: this.currentData.join("\n"),
          id: this.currentId,
          retry: this.currentRetry,
        });
        this.currentEvent = undefined;
        this.currentData = [];
        this.currentId = undefined;
        this.currentRetry = undefined;
      }
    } else {
      // Discard incomplete trailing frame per W3C SSE standard
      this.buffer = "";
      this.currentEvent = undefined;
      this.currentData = [];
      this.currentId = undefined;
      this.currentRetry = undefined;
    }
    return events;
  }

  public reset(): void {
    this.buffer = "";
    this.currentEvent = undefined;
    this.currentData = [];
    this.currentId = undefined;
    this.currentRetry = undefined;
  }

  /** Unparsed trailing buffer remainder. */
  public get pendingRemainder(): string {
    return this.buffer;
  }
}

/** Parses raw SSE event data into a typed OpenCode V2 wire event, or null if malformed. */
export function parseOpenCodeWireEvent(raw: SseRawEvent): OpenCodeWireEvent | null {
  if (!raw.data || raw.data.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw.data);
    if (!parsed || typeof parsed !== "object") return null;
    const type = Reflect.get(parsed, "type");
    if (typeof type !== "string" || type.trim().length === 0) return null;
    return {
      type,
      id: typeof parsed.id === "string" ? parsed.id : raw.id,
      created: typeof parsed.created === "number" ? parsed.created : undefined,
      data: typeof parsed.data === "object" && parsed.data !== null ? parsed.data : undefined,
      durable:
        typeof parsed.durable === "object" && parsed.durable !== null ? parsed.durable : undefined,
    };
  } catch {
    return null; // Malformed JSON
  }
}

// ============================================================================
// Priority 4 — Tool-call and permission event validation
// ============================================================================

export function isToolCallEventType(type: string): boolean {
  return (
    type === "session.tool.called" ||
    type === "session.tool.progress" ||
    type === "session.tool.success" ||
    type === "session.tool.failed" ||
    type === "session.tool.input.started" ||
    type === "session.tool.input.delta" ||
    type === "session.tool.input.ended"
  );
}

/**
 * Validates tool call event payload structure.
 * Supports both top-level fields and envelope data fields.
 */
export function validateToolCallEvent(event: OpenCodeWireEvent): boolean {
  if (!isToolCallEventType(event.type)) return false;
  const source = event.data ?? (event as unknown as Record<string, unknown>);
  const callID = Reflect.get(source, "callID") ?? Reflect.get(source, "callId");
  if (typeof callID !== "string" || callID.trim().length === 0) return false;
  if (event.type === "session.tool.called") {
    const tool = Reflect.get(source, "tool") ?? Reflect.get(source, "name");
    if (typeof tool !== "string" || tool.trim().length === 0) return false;
  }
  return true;
}

export function isPermissionEventType(type: string): boolean {
  return type === "permission.asked" || type === "permission.replied";
}

/** Validates permission request/reply event payload structure. */
export function validatePermissionEvent(event: OpenCodeWireEvent): boolean {
  if (!isPermissionEventType(event.type)) return false;
  const source = event.data ?? (event as unknown as Record<string, unknown>);
  const id = Reflect.get(source, "id");
  if (typeof id !== "string" || id.trim().length === 0) return false;
  if (event.type === "permission.replied") {
    const decision = Reflect.get(source, "decision");
    if (decision !== "granted" && decision !== "denied") return false;
  }
  return true;
}

// ============================================================================
// Priority 3 — Stream termination and reconnection behavior
// ============================================================================

export interface StreamReconnectionOptions {
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export type StreamEventConsumer = (event: OpenCodeWireEvent) => void;

/**
 * Consumes an OpenCode SSE stream with automatic reconnection upon termination.
 * Yields parsed wire events, handles fragmented chunks, and respects AbortSignals.
 */
export async function consumeEventStreamWithReconnection(
  fetchStream: (signal: AbortSignal) => Promise<Response>,
  onEvent: StreamEventConsumer,
  options: {
    readonly signal: AbortSignal;
    readonly reconnectOptions?: StreamReconnectionOptions;
    readonly onReconnect?: (attempt: number) => void;
  },
): Promise<{ completedCleanly: boolean; disconnectCount: number }> {
  const maxAttempts = options.reconnectOptions?.maxAttempts ?? 3;
  const initialDelay = options.reconnectOptions?.initialDelayMs ?? 10;
  const maxDelay = options.reconnectOptions?.maxDelayMs ?? 200;
  let disconnectCount = 0;
  let currentDelay = initialDelay;

  while (!options.signal.aborted) {
    const parser = new SseStreamParser();
    try {
      const response = await fetchStream(options.signal);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const stream = response.body;
      if (!stream) return { completedCleanly: true, disconnectCount };

      const reader = stream.getReader();
      const decoder = new TextDecoder();

      try {
        while (!options.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const rawEvents = parser.feed(chunk);
          for (const raw of rawEvents) {
            const wireEvent = parseOpenCodeWireEvent(raw);
            if (wireEvent) {
              onEvent(wireEvent);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      const trailing = parser.flush();
      for (const raw of trailing) {
        const wireEvent = parseOpenCodeWireEvent(raw);
        if (wireEvent) {
          onEvent(wireEvent);
        }
      }

      if (options.signal.aborted) {
        return { completedCleanly: true, disconnectCount };
      }

      disconnectCount++;
      if (disconnectCount >= maxAttempts) {
        return { completedCleanly: false, disconnectCount };
      }
    } catch {
      if (options.signal.aborted) {
        return { completedCleanly: true, disconnectCount };
      }
      disconnectCount++;
      if (disconnectCount >= maxAttempts) {
        return { completedCleanly: false, disconnectCount };
      }
    }

    options.onReconnect?.(disconnectCount);
    const aborted = await new Promise<boolean>((resolve) => {
      if (options.signal.aborted) return resolve(true);
      const onAbort = () => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        resolve(true);
      };
      const timer = setTimeout(() => {
        options.signal.removeEventListener("abort", onAbort);
        resolve(false);
      }, currentDelay);
      options.signal.addEventListener("abort", onAbort);
    });
    if (aborted) {
      return { completedCleanly: true, disconnectCount };
    }
    currentDelay = Math.min(currentDelay * 2, maxDelay);
  }

  return { completedCleanly: true, disconnectCount };
}

// ============================================================================
// Priority 7 — Lazy capability detection
// ============================================================================

export type OpenCodeLazyCapability =
  | "session.create"
  | "session.message.list"
  | "session.prompt"
  | "session.delete"
  | "permission.reply"
  | "command.execute";

/**
 * Registry for on-demand / lazy capability verification.
 * Avoids executing any mutations or active prompts during startup or adoption.
 */
export class LazyCapabilityRegistry {
  private readonly statusCache = new Map<OpenCodeLazyCapability, boolean>();
  private readonly inFlight = new Map<OpenCodeLazyCapability, Promise<boolean>>();
  private currentIdentity: string | null = null;

  constructor(initialIdentity?: string) {
    this.currentIdentity = initialIdentity ?? null;
  }

  public get serviceIdentity(): string | null {
    return this.currentIdentity;
  }

  /**
   * Binds this registry to a specific service identity (e.g. server origin, version, or instance key).
   * If the identity changes, all cached capabilities are automatically cleared.
   */
  public bindToService(identity: string): void {
    if (this.currentIdentity !== null && this.currentIdentity !== identity) {
      this.clear();
    }
    this.currentIdentity = identity;
  }

  public isCached(cap: OpenCodeLazyCapability): boolean {
    return this.statusCache.has(cap);
  }

  public getCached(cap: OpenCodeLazyCapability): boolean | undefined {
    return this.statusCache.get(cap);
  }

  public recordCapability(cap: OpenCodeLazyCapability, supported: boolean): void {
    this.statusCache.set(cap, supported);
  }

  public clear(): void {
    this.statusCache.clear();
    this.inFlight.clear();
  }

  /**
   * Lazily checks or confirms a capability on first demand with concurrent single-flight deduplication.
   * If already known, returns the cached result without invoking probeFn.
   * If a probe for the same capability is already in flight, reuses the in-flight Promise.
   */
  public async detectLazily(
    cap: OpenCodeLazyCapability,
    probeFn: () => Promise<boolean>,
  ): Promise<boolean> {
    const cached = this.statusCache.get(cap);
    if (cached !== undefined) return cached;

    const existingPromise = this.inFlight.get(cap);
    if (existingPromise !== undefined) return existingPromise;

    const probePromise = (async () => {
      try {
        const supported = await probeFn();
        this.statusCache.set(cap, supported);
        return supported;
      } catch {
        this.statusCache.set(cap, false);
        return false;
      } finally {
        this.inFlight.delete(cap);
      }
    })();

    this.inFlight.set(cap, probePromise);
    return probePromise;
  }
}

/** Canonical singleton lazy capability registry for the active OpenCode service. */
export const lazyCapabilityRegistry = new LazyCapabilityRegistry();
