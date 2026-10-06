/**
 * THE conversation-existence contract.
 *
 * Five surfaces probe `GET /api/conversations/:id` (the tab strip, the
 * route-to-tab validator, the chat header, and the two OpenCode row/config
 * hooks). Before this module they each classified the outcome independently, and
 * three of them used `r.ok ? r.json() : null` — an expression that collapses
 * "this row is gone" and "the server is broken" into the same value. That
 * collapse is the whole reason a client cannot tell a stale tab from a
 * transient outage, and it is why one of them destroyed tabs on 404 while the
 * others kept them.
 *
 * The rule, stated once:
 *
 *     2xx     -> "exists"    the row is there; `data` is populated
 *     404     -> "gone"      proven missing; the ONLY state that may evict a tab
 *     other   -> "unknown"   existence is undetermined; never evict
 *     network / abort / unreadable body -> "unknown"
 *
 * `unknown` is never `gone`. A 5xx or a dropped connection is evidence about the
 * server, not about the row, and treating it as absence is how a UI destroys a
 * user's tabs because a laptop lid closed.
 *
 * Two properties this module guarantees to its callers:
 *
 * 1. ONE request per probe. The row data travels with the verdict, so a consumer
 *    that needs `title` / `workspaceMode` / `opencodeAgent` never issues a
 *    second fetch to get it. There is deliberately no existence-only single-id
 *    API — see the note above `probeConversation`.
 * 2. No throws. Every failure mode resolves to a verdict, so no call site can
 *    forget the `unknown` branch.
 */

import { logger } from "../../../lib/logger";

/**
 * Three-valued existence verdict. `unknown` is a first-class outcome, not an
 * error: it means "this probe could not determine existence", and it is the
 * state that forbids eviction.
 */
export type ConversationExistence = "exists" | "gone" | "unknown";

/**
 * Result of a single-id probe: the verdict, plus the conversation row when the
 * row was actually read. A discriminated union rather than
 * `{ existence, data }` so a consumer cannot read `data` without first proving
 * it is present — the compiler rejects it, not a runtime guard.
 */
export type ConversationProbe =
  | { status: "exists"; data: ConversationRow }
  | { status: "gone"; data: null }
  | { status: "unknown"; data: null };

/**
 * The conversation fields a client may read: the server's
 * `GET /api/conversations/:id` response body (a mapped `Conversation`, with
 * `createdAt`/`updatedAt` serialized to ISO strings).
 *
 * Declared structurally rather than imported from the server so this module
 * keeps no dependency on backend types. The narrow unions are not a
 * convenience — they are what the server actually sends: `mapConversation`
 * coalesces `engine` and `workspace_mode` to a default, so neither is ever
 * null on the wire. Typing them as `string | null` (as an untyped `.json()`
 * previously implied) would push a bogus null-handling obligation onto every
 * consumer.
 */
export interface ConversationRow {
  id: string;
  title: string;
  status: string;
  engine: "direct" | "opencode";
  workspaceMode: "simple" | "project";
  workspaceFolderId: string | null;
  opencodeAgent: string | null;
  opencodeModel: string | null;
  opencodeVariant: string | null;
  opencodeAutoApprove: boolean;
  /** ISO-8601. `Date` fields are serialized by `c.json()`. */
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** Server verdict vocabulary. Shared by the batch request and its response. */
const RECONCILE_STATUSES = ["exists", "gone"] as const;
export type ReconcileStatus = (typeof RECONCILE_STATUSES)[number];

/**
 * The ONLY classifier of a conversation-by-id HTTP outcome.
 *
 * Total by construction: it takes a status, it cannot throw, and no input maps
 * to `gone` except 404. Note what is deliberately NOT `gone`:
 *   - other 4xx (400/401/403/409/422) — the request was refused, which says
 *     nothing about whether the row exists
 *   - 3xx — only reachable under `redirect: "manual"`; a followed redirect
 *     surfaces as its final 2xx
 *   - 5xx — the server is unhealthy, not the row absent
 *
 * @param status - HTTP status code from the conversation read.
 * @returns `"exists"`, `"gone"`, or `"unknown"` — never throws.
 */
export function classifyExistence(status: number): ConversationExistence {
  if (status >= 200 && status < 300) return "exists";
  if (status === 404) return "gone";
  return "unknown";
}

/** A JSON object we can read fields off. Arrays and null are rejected. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Probe one conversation: one request, verdict plus row data.
 *
 * Resolves; never throws. A 2xx whose body is not a readable object resolves to
 * `unknown`, not `exists` — a response we cannot parse is not evidence that the
 * conversation is there, and reporting it as `exists` would be the mirror image
 * of the same mistake in the other direction.
 *
 * There is intentionally no existence-only variant of this function. The only
 * existence-only need in the app is boot reconciliation, and the batch endpoint
 * serves that in a single request; an existence-only single-id API would invite
 * exactly the bug this module exists to prevent — a consumer that needs a field
 * issuing a second fetch to obtain it.
 *
 * @param id - Conversation id (remoteId).
 * @returns The verdict and, when `exists`, the conversation row.
 */
export async function probeConversation(id: string): Promise<ConversationProbe> {
  let res: Response;
  try {
    res = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
  } catch (err) {
    // Network throw or abort: the request never produced a status, so
    // existence is undetermined. No per-probe diagnostics — the browser already
    // reports transport failures, and a title read is not worth a log line.
    logger.debug("chat", "conversation_probe_unknown", {
      conversationId: id,
      errorType: err instanceof Error ? err.name : typeof err,
    });
    return { status: "unknown", data: null };
  }

  const status = classifyExistence(res.status);
  if (status === "gone") return { status: "gone", data: null };
  if (status === "unknown") return { status: "unknown", data: null };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: "unknown", data: null };
  }
  if (!isRecord(body)) return { status: "unknown", data: null };
  return { status: "exists", data: body as ConversationRow };
}

/**
 * Reconcile a caller-supplied set of conversation ids in ONE request.
 *
 * The client owns the complete id set here (it is the tab mirror), which is what
 * makes absence provable — the response is keyed by the ids we asked about, not
 * by a server-side filter, so an id reported `gone` is genuinely missing.
 *
 * Fail-safe by construction: if the whole request fails, or the body is
 * unreadable, or the server omits ANY requested id, then EVERY id resolves to
 * `unknown` and nothing may be evicted. A partial or malformed response can
 * therefore never cause a mass eviction.
 *
 * @param ids - The exact ids to check. Callers deduplicate and must not include
 *   draft ids (a draft has no server row and would always read as gone).
 * @returns Map of id to verdict. Never throws.
 */
export async function reconcileConversations(
  ids: string[],
): Promise<Map<string, ConversationExistence>> {
  const verdicts = new Map<string, ConversationExistence>();
  for (const id of ids) verdicts.set(id, "unknown");
  if (ids.length === 0) return verdicts;

  let body: unknown;
  try {
    const res = await fetch("/api/conversations/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) return verdicts;
    body = await res.json();
  } catch {
    return verdicts;
  }

  if (!isRecord(body) || !Array.isArray(body.results)) return verdicts;
  const seen = new Set<string>();
  for (const entry of body.results) {
    if (!isRecord(entry)) continue;
    const id = entry.id;
    // Only ids we asked about may contribute, and a duplicate id cannot flip a
    // verdict that was already established.
    if (typeof id !== "string" || !verdicts.has(id) || seen.has(id)) continue;
    if (entry.status === "exists" || entry.status === "gone") {
      seen.add(id);
      verdicts.set(id, entry.status);
    }
  }
  // Completeness gate: one missing answer invalidates the whole response, so a
  // server bug degrades to "retain everything" rather than "evict the rest".
  if (seen.size !== new Set(ids).size) {
    logger.warn("chat", "conversation_reconcile_incomplete", {
      requested: ids.length,
      answered: seen.size,
    });
    return new Map(ids.map((id) => [id, "unknown" as const]));
  }
  return verdicts;
}

/**
 * Confirmed server evidence that a conversation does not exist (HTTP 404).
 *
 * Thrown only by callers that must preserve a throwing contract — the
 * assistant-ui adapter's `fetch`. Anything that can express a verdict should use
 * `probeConversation` instead; this class exists so the adapter boundary keeps
 * its established error-based API without re-implementing the classification.
 */
export class ConversationNotFoundError extends Error {
  readonly threadId: string;

  constructor(threadId: string) {
    super(`Thread not found: ${threadId}`);
    this.name = "ConversationNotFoundError";
    this.threadId = threadId;
  }
}
