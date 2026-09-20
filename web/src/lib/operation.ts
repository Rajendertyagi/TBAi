/**
 * Operation-scoped correlation for the browser.
 *
 * `requestId` is minted server-side per HTTP request, so it cannot answer
 * "what did this ONE user action do?" — a single action (send a prompt, open a
 * Code session) fans out into several requests. This module owns the other id:
 *
 *   operationId — one meaningful user action, stable for its whole lifetime,
 *                 propagated on `X-TBAI-Operation-ID` so every request it
 *                 causes shares it while each keeps its own requestId.
 *
 * Deliberately dependency-free (no logger import): the log transport reads
 * `currentOperationId()`, so the direction is logger → transport → operation.
 * Importing the logger here would close a cycle.
 *
 * Ids are opaque and locally generated — never derived from user data, so
 * nothing sensitive can ride in one.
 */

/** Header carrying the operation id to the backend. */
export const OPERATION_ID_HEADER = "X-TBAI-Operation-ID";

/** Longest id the backend accepts (`CORRELATION_ID_RE`). */
const MAX_OPERATION_ID_LEN = 64;

/** Mint an operation id: `op_` + UUID (39 chars, URL-safe, opaque). */
export function newOperationId(): string {
  try {
    return `op_${crypto.randomUUID()}`;
  } catch {
    // No crypto (very old webview): still unique enough to correlate locally.
    return `op_${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

export interface OperationHandle {
  readonly id: string;
  readonly name: string;
  readonly startedAt: number;
  /** End this operation and restore the one it was nested inside (if any). */
  end(outcome?: string): void;
}

interface ActiveOperation {
  id: string;
  name: string;
  startedAt: number;
  ended: boolean;
}

let current: ActiveOperation | null = null;
/** Enclosing operations, so nesting restores correctly instead of clearing. */
const enclosing: (ActiveOperation | null)[] = [];

/**
 * Start a meaningful user operation. Returns a handle whose `end()` restores
 * the previously active operation, so nested operations (a session bootstrap
 * inside a send) never leave the outer one uncorrelated.
 */
export function startOperation(name: string, id?: string): OperationHandle {
  const previous = current;
  const op: ActiveOperation = {
    id: (id ?? newOperationId()).slice(0, MAX_OPERATION_ID_LEN),
    name,
    startedAt: Date.now(),
    ended: false,
  };
  enclosing.push(previous);
  current = op;
  return {
    id: op.id,
    name: op.name,
    startedAt: op.startedAt,
    end(outcome?: string) {
      void outcome;
      if (op.ended) return;
      op.ended = true;
      // Only unwind if this operation is still the active one; a stale handle
      // ending late must not clobber a newer operation.
      if (current === op) {
        // Restore the nearest ENCLOSING operation that is still live. An
        // already-ended one is never restored: resurrecting it would put a
        // finished operation back in scope and leak its id into every later
        // event, which is the opposite of what this stack is for.
        current = null;
        while (enclosing.length > 0) {
          const candidate = enclosing.pop() ?? null;
          if (candidate === null) break;
          if (!candidate.ended) {
            current = candidate;
            break;
          }
        }
      } else {
        const idx = enclosing.lastIndexOf(op);
        if (idx !== -1) enclosing.splice(idx, 1);
      }
    },
  };
}

/** The active operation id, or undefined when no operation is in flight. */
export function currentOperationId(): string | undefined {
  return current?.id;
}

/** The active operation's name (diagnostics only). */
export function currentOperationName(): string | undefined {
  return current?.name;
}

/** Header object for a request made as part of the active operation. */
export function operationHeaders(): Record<string, string> {
  const id = currentOperationId();
  return id ? { [OPERATION_ID_HEADER]: id } : {};
}

/** Test-only reset. */
export function resetOperationsForTests(): void {
  current = null;
  enclosing.length = 0;
}

/** Resolve a fetch input to a URL, or null when it cannot be parsed. Pure. */
export function resolveRequestUrl(
  input: URL | RequestInfo,
  origin: string,
): URL | null {
  try {
    if (typeof input === "string") return new URL(input, origin);
    if (input instanceof URL) return input;
    return new URL((input as Request).url, origin);
  } catch {
    return null;
  }
}

/**
 * Same-origin `/api/*` calls are the ones the backend can correlate; anything
 * else (assets, third-party, dev-server modules) is left byte-identical. Pure.
 */
export function isCorrelatableRequest(url: URL, origin: string): boolean {
  return url.origin === origin && url.pathname.startsWith("/api/");
}

/**
 * The init to send for a request made as part of the active operation.
 *
 * Pure, and returns `undefined` when nothing should change — no operation, a
 * non-correlatable target, an unparseable URL, or a header the caller already
 * set. The wrapper below is a two-line delegation, so the decision itself is
 * directly unit-testable without touching the global `fetch`.
 */
export function operationInitFor(
  input: URL | RequestInfo,
  init: RequestInit | undefined,
  id: string | undefined,
  origin: string,
): RequestInit | undefined {
  if (!id) return undefined;
  const url = resolveRequestUrl(input, origin);
  if (!url || !isCorrelatableRequest(url, origin)) return undefined;
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (headers.has(OPERATION_ID_HEADER)) return undefined;
  headers.set(OPERATION_ID_HEADER, id);
  return { ...(init ?? {}), headers };
}

let fetchInstalled = false;

/**
 * Install the operation-id header application-wide by wrapping `fetch` ONCE,
 * instead of editing every call site (which would silently miss new ones).
 *
 * Only same-origin `/api/*` requests are touched, and only when an operation is
 * actually active — so probes, asset loads, and requests made outside any user
 * action keep their exact previous behavior. An explicit header already set by
 * a caller always wins.
 */
export function installOperationHeaderFetch(): void {
  if (fetchInstalled || typeof window === "undefined") return;
  fetchInstalled = true;
  const base = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    const next = operationInitFor(
      input,
      init,
      currentOperationId(),
      window.location.origin,
    );
    return next ? base(input, next) : base(input, init);
  }) as typeof globalThis.fetch;
}
