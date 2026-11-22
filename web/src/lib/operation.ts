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

/** Fallback scope key when a thread-list item has neither a remote nor local id. */
export const UNKNOWN_THREAD_KEY = "unknown";

/**
 * Canonical operation-scope key for a thread-list item. Every send boundary
 * (begin/attach/settle/finish/error) must derive the key this way, or a thread
 * missing both ids would be registered under one key and ended under another —
 * leaking the operation and dropping its correlation header.
 */
export function operationThreadKey(item: { remoteId?: string; id?: string } | undefined): string {
  return item?.remoteId ?? item?.id ?? UNKNOWN_THREAD_KEY;
}

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
  scopeKey?: string;
}

let current: ActiveOperation | null = null;
/** Enclosing operations, so nesting restores correctly instead of clearing. */
const enclosing: (ActiveOperation | null)[] = [];
/**
 * Scope-keyed operations. Concurrent chats (Direct threads, OpenCode sessions)
 * each own one entry, keyed by conversation/thread/session id. This is the
 * source of truth for concurrent requests — the single global `current` above
 * is retained only for unscoped callers (tests, the logger fallback) and must
 * never be relied on to correlate a concurrent send.
 */
const operationsByScope = new Map<string, OperationHandle>();

/**
 * Start a meaningful user operation. When `scopeKey` is supplied the operation
 * is registered under that key and is independent of every other scope; its
 * `end()` removes only its own entry. Without a scope the legacy global
 * current/nesting behavior is preserved.
 */
export function startOperation(name: string, scopeKey?: string, id?: string): OperationHandle {
  const op: ActiveOperation = {
    id: (id ?? newOperationId()).slice(0, MAX_OPERATION_ID_LEN),
    name,
    startedAt: Date.now(),
    ended: false,
    scopeKey,
  };
  const handle: OperationHandle = {
    id: op.id,
    name: op.name,
    startedAt: op.startedAt,
    end(outcome?: string) {
      void outcome;
      if (op.ended) return;
      op.ended = true;
      if (scopeKey) {
        // Only remove this scope's entry if it is still the one registered —
        // a stale handle ending late must not remove a newer operation.
        if (operationsByScope.get(scopeKey) === handle) operationsByScope.delete(scopeKey);
        return;
      }
      // Legacy unscoped unwind (unchanged).
      if (current === op) {
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
  if (scopeKey) {
    operationsByScope.set(scopeKey, handle);
  } else {
    const previous = current;
    enclosing.push(previous);
    current = op;
  }
  return handle;
}

/**
 * The active operation id for a scope, or the unscoped global id when no scope
 * is given. Concurrent callers MUST pass their scope key.
 */
export function currentOperationId(scopeKey?: string): string | undefined {
  if (scopeKey) return operationsByScope.get(scopeKey)?.id;
  return current?.id;
}

/**
 * End the operation registered for `scopeKey`. Returns the ended id (so callers
 * can log it) or undefined when nothing matched. `expectedId` guards a late
 * settle from ending a newer operation in the same scope.
 */
export function endOperation(
  scopeKey: string,
  outcome?: string,
  expectedId?: string,
): string | undefined {
  const op = operationsByScope.get(scopeKey);
  if (!op) return undefined;
  if (expectedId !== undefined && op.id !== expectedId) return undefined;
  operationsByScope.delete(scopeKey);
  op.end(outcome);
  return op.id;
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
  operationsByScope.clear();
}

/** Resolve a fetch input to a URL, or null when it cannot be parsed. Pure. */
export function resolveRequestUrl(input: URL | RequestInfo, origin: string): URL | null {
  try {
    if (typeof input === "string") return new URL(input, origin);
    if (input instanceof URL) return input;
    return new URL((input as Request).url, origin);
  } catch {
    return null;
  }
}

/**
 * Same-origin or verified-backend `/api/*` calls are the ones the backend can correlate;
 * anything else (assets, third-party, dev-server modules) is left byte-identical. Pure.
 */
export function isCorrelatableRequest(url: URL, origin: string, apiOrigin?: string): boolean {
  const matchesOrigin = url.origin === origin || (apiOrigin ? url.origin === apiOrigin : false);
  return matchesOrigin && url.pathname.startsWith("/api/");
}

/**
 * The init to send for a request made as part of the active operation.
 *
 * Pure, and returns `undefined` when nothing should change — no operation, a
 * non-correlatable target, an unparseable URL, or a header the caller already
 * set. Each request boundary (Direct `diagnosticFetch`, OpenCode session client)
 * calls this with its captured, scope-keyed id — there is deliberately no global
 * fetch wrapper, which would mis-correlate concurrent chats.
 */
export function operationInitFor(
  input: URL | RequestInfo,
  init: RequestInit | undefined,
  id: string | undefined,
  origin: string,
  apiOrigin?: string,
): RequestInit | undefined {
  if (!id) return undefined;
  const url = resolveRequestUrl(input, origin);
  if (!url || !isCorrelatableRequest(url, origin, apiOrigin)) return undefined;
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (headers.has(OPERATION_ID_HEADER)) return undefined;
  headers.set(OPERATION_ID_HEADER, id);
  return { ...(init ?? {}), headers };
}
