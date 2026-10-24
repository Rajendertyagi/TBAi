import { createOpenCodeClient, lastStatusForSessionLookup, type OpenCodeClient } from "./client";
import { OpenCodeError, toOpenCodeError } from "./errors";
import { conversationService } from "../storage";
import { opencodeOrphanService } from "../storage/opencodeSessionOrphans";
import { resolveConversationWorkspace } from "../workspace";
import { openCodeServerManager } from "./serverManager";
import { resolveOpenCodeModelRef } from "./capabilities";
import { fetchServerDefaultModel, pickSessionModel, resolveStoredModel } from "./sessionModel";
import { logger } from "../../lib/logger";
import { classifyError } from "../../lib/errors";
import { generateId } from "../../lib/utils";

/** OpenCode `ModelRef` shape accepted by `session.create` / `defaultModel`. */
type ModelRef = { id: string; providerID: string; variant?: string };

/** Mutable form of the official `SessionCreateInput` (whose fields are readonly). */
type SessionCreateParams = {
  /**
   * Caller-supplied session id. OpenCode honours it and treats a repeat create
   * for the same id as idempotent, which is what makes it a durable
   * correlation key across a process crash (RT-001).
   */
  id: string;
  location: { directory: string };
  agent?: string;
  model?: ModelRef;
};

/** Prefix every TBAi-minted OpenCode session id carries. */
const SESSION_ID_PREFIX = "ses_";

/**
 * Caller error: the conversation row is not an OpenCode row. The row is
 * authoritative — a Direct (or legacy pre-engine) conversation must never
 * gain an OpenCode session pointer. Carries a stable code so the route maps
 * it to 422 instead of the generic 500; the message names only engine kinds
 * (safe to surface). Canonical home of the ENGINE_MISMATCH code — the chat
 * route's mirror guard cites this class rather than redefining the code.
 */
export class EngineMismatchError extends Error {
  readonly code = "ENGINE_MISMATCH";
  constructor(
    readonly conversationId: string,
    readonly engine: string,
  ) {
    super(`Conversation ${conversationId} uses the ${engine} engine, not OpenCode`);
    this.name = "EngineMismatchError";
  }
}

/**
 * Caller error: the requested conversation does not own the requested OpenCode
 * session. Carries a stable code so the route maps it to 404 instead of the
 * generic 500. The message names no transcript data — it only states that the
 * pair is not a binding TBAi knows about.
 */
export class OpenCodeSessionMismatchError extends Error {
  readonly code = "SESSION_MISMATCH";
  constructor(
    readonly conversationId: string,
    readonly sessionId: string,
  ) {
    super(`Conversation ${conversationId} is not bound to session ${sessionId}`);
    this.name = "OpenCodeSessionMismatchError";
  }
}

/**
 * The remote session was created but its pointer could not be bound to the
 * conversation (RT-001). Carries enough state for diagnosis and recovery:
 *
 *  - `cleanup` classifies what happened after the persistence failure:
 *    `confirmed_removed` (positive evidence of absence), `removal_failed`
 *    (the remove call itself failed and the session may still be live),
 *    `lookup_inconclusive` (the confirmation lookup could not establish
 *    absence), `verification_unknown` (the pointer state itself was
 *    unknown, so removal was refused and no claim about the session's
 *    current state is made).
 *  - `recorded` is true when a durable recovery record was actually written
 *    (or was already open) — the answer to "can a future reconciler act on
 *    this?". A false here means the journal write itself failed and the
 *    only record is the error-level log.
 *    `confirmed_removed` with `recorded: true` is a deliberate combination:
 *    the session is gone NOW, but a create attempt whose response was lost may
 *    still recreate the id, so the risk-bearing intent was kept for the
 *    reconciler rather than deleted.
 *
 * The class carries the session id on purpose: it is the handle the recovery
 * record needs, and it stays on the error object rather than in a log
 * message or the HTTP body. `cause` is the original persistence failure, so
 * diagnosis is not lost.
 */
export class OpenCodeSessionPersistError extends Error {
  readonly code = "OPENCODE_SESSION_PERSIST_FAILED";
  constructor(
    readonly conversationId: string,
    readonly sessionId: string,
    readonly cleanup:
      | "confirmed_removed"
      | "removal_failed"
      | "lookup_inconclusive"
      | "verification_unknown",
    readonly recorded: boolean,
    readonly cleanupError: unknown,
    options: ErrorOptions,
  ) {
    super(
      {
        confirmed_removed:
          "OpenCode session could not be persisted; the remote session was confirmed removed",
        removal_failed:
          "OpenCode session could not be persisted and remote removal could not complete",
        lookup_inconclusive:
          "OpenCode session could not be persisted; removal was attempted but the outcome is inconclusive",
        verification_unknown:
          "OpenCode session could not be persisted and its pointer state is unknown; no cleanup was attempted",
      }[cleanup],
      options,
    );
    this.name = "OpenCodeSessionPersistError";
  }
}

/**
 * The durable recovery journal could not establish the pre-create intent, so
 * no remote session was requested (RT-001, fail-closed).
 *
 * Creating the session first and hoping the journal write works afterwards is
 * exactly the untracked-creation window this design exists to close: if the
 * process dies (or the database closes) between the two, nothing durable names
 * the remote session. A journal outage therefore fails the operation instead
 * of proceeding without a recovery record.
 *
 * The message is safe to surface: it names no conversation, session id or
 * database detail. Those stay on the error object for diagnosis, and `cause`
 * carries the underlying failure.
 */
export class OpenCodeSessionIntentError extends Error {
  readonly code = "OPENCODE_SESSION_INTENT_FAILED";
  constructor(
    readonly conversationId: string,
    readonly sessionId: string,
    options: ErrorOptions,
  ) {
    super("OpenCode session recovery is unavailable; no session was created", options);
    this.name = "OpenCodeSessionIntentError";
  }
}

/**
 * A conversation's OpenCode session binding: the server-side session identity
 * plus the directory scope that identity is addressed by.
 *
 * Both halves are needed to talk to a session. `sessionId` names it; the
 * directory scopes it. OpenCode keys most routes on a directory, and the event
 * stream is the one that matters here: `GET /event` **without** a `directory`
 * answers with a stub carrying only `server.connected` + `server.heartbeat`, so
 * a client that subscribes unscoped receives no session events at all — the
 * completed reply then only appears after a history reload. Returning the two
 * together means a caller can never hold an id without its scope.
 */
export type OpenCodeSessionBinding = {
  /** The OpenCode session id: the server-side identity of this conversation. */
  sessionId: string;
  /**
   * The directory the server records for this session, or `null` when it could
   * not be read. `null` is not an error: the caller simply cannot scope
   * directory-keyed routes, and must not guess a path.
   */
  directory: string | null;
  /**
   * True only when an existing live session was verified and adopted. False
   * when a session was created or a stale pointer was replaced. This is a
   * **reuse** fact, not a restart fact: it says nothing about whether the
   * application was reloaded, crashed, or merely navigated back to.
   */
  reusedExistingSession: boolean;
};

/** Reads a non-empty string, or `undefined` for anything else. */
function asDirectory(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The status OpenCode returns for a session that does not exist.
 *
 * Named rather than inlined because it is load-bearing: it is the one signal that
 * authorises replacing a stale binding, so it must never be widened by accident.
 */
const SESSION_NOT_FOUND_STATUS = 404;

/**
 * Fetches the server's record for a session, or `null` when the server
 * definitively does not have it. Returns the session's **directory** as well,
 * because that value is the scope every directory-keyed OpenCode route needs
 * and the server's own record is its authoritative source — reading it from
 * TBAi's folder table instead would go stale the moment a workspace migrates.
 *
 * The directory is read from the V2 `location.directory` field exposed by the
 * official client. A missing location is reported as `null`; the seam does not
 * infer a path from fields outside the V2 contract.
 *
 * Liveness is decided by the HTTP status, read off the response the official
 * client itself received. A `404` means the session is definitively gone and a
 * replacement is safe. **Everything else propagates.** That asymmetry is the
 * whole point: minting a replacement for a session that may still exist would
 * break history continuity, so a transport failure, an auth failure, a
 * malformed body or a server fault must all surface as the real error rather than
 * be read as "gone". A session is only ever declared absent on positive evidence.
 *
 * Shared with the orphan reconciler rather than copied there: this is the one
 * implementation of "is this session present, and is the answer about THIS id?".
 *
 * @param client - Client bound to the managed server's base URL.
 * @param sessionId - The persisted OpenCode session id to look up.
 * @returns The session id + directory, or null when the server has no such session.
 * @throws {OpenCodeError} When absence could not be established either way.
 */
export async function fetchOpenCodeSession(
  client: OpenCodeClient,
  sessionId: string,
): Promise<{ id: string; directory: string | null; model: string | null } | null> {
  try {
    const session = await client.session.get({ sessionID: sessionId });
    if (typeof session?.id !== "string" || session.id.length === 0) {
      throw new OpenCodeError("malformed", "OpenCode session response carried no session id");
    }
    // Identity, not just existence: a server that answered for a different id
    // must never be read as evidence about THIS one. The reconciler depends on
    // this to decide whether a remote session is safe to remove.
    if (session.id !== sessionId) {
      throw new OpenCodeError("malformed", "OpenCode session lookup returned a different id");
    }
    return {
      id: session.id,
      directory: asDirectory(session.location?.directory) ?? null,
      // The session's current model, so adopting it can tell "already has one"
      // from "has none" without a second request. OpenCode reports an unset
      // model as an empty/absent field, so anything non-string is "none".
      model:
        typeof session.model?.id === "string" && session.model.id.length > 0
          ? session.model.id
          : null,
    };
  } catch (error) {
    // The status is the evidence, and it is checked BEFORE the thrown error is
    // interpreted: for the real missing-session response the client cannot
    // report the status at all, so the classification below would only ever say
    // "malformed" and the stale binding would never be detected.
    if (lastStatusForSessionLookup(client, sessionId) === SESSION_NOT_FOUND_STATUS) {
      return null;
    }
    // No 404 means absence was never established, whatever the client thought it
    // saw. `null` here would authorise a replacement on no evidence, so the real
    // failure is surfaced instead.
    const failure = toOpenCodeError(error);
    if (failure.kind === "session_not_found" || failure.statusCode === SESSION_NOT_FOUND_STATUS) {
      return null;
    }
    throw failure;
  }
}

/**
 * Gives an adopted session a model when it has none, and only then.
 *
 * Never throws and never blocks adoption: a session that cannot be given a
 * model is still returned, because refusing to hand back a live session would
 * be strictly worse than handing one back that will be repaired on the next
 * turn. The failure is logged, so it is never silent.
 */
async function assignSessionModelIfMissing(
  client: OpenCodeClient,
  conversationId: string,
  storedModelId: string | null | undefined,
  sessionId: string,
  boundModel: string | null,
): Promise<void> {
  try {
    const storedModel = await resolveStoredModel(storedModelId);
    const serverDefault = await fetchServerDefaultModel();
    const target = pickSessionModel({ boundModel, storedModel, serverDefault });
    if (!target) return;
    await client.session.switchModel({
      sessionID: sessionId,
      model: { id: target.id, providerID: target.providerID },
    });
    logger.info("opencode", "opencode.session_model_assigned", {
      conversationId,
      sessionId,
      source: storedModel ? "stored" : "server_default",
    });
  } catch (error) {
    logger.warn("opencode", "opencode.session_model_assign_failed", {
      conversationId,
      sessionId,
      ...classifyError(error),
    });
  }
}

/**
 * Liveness probe for a stored session id: does the managed server still know
 * this session? The id is only a pointer — the server restarts independently,
 * so a persisted id may reference a session that no longer exists.
 *
 * A thin predicate over `fetchOpenCodeSession`, so the V2 liveness rules live
 * in exactly one place.
 *
 * @param client - Client bound to the managed server's base URL.
 * @param sessionId - The persisted OpenCode session id to verify.
 * @returns True when the server still has the session.
 * @throws {OpenCodeError} When lookup fails for a reason other than missing session.
 */
export async function isOpenCodeSessionLive(
  client: OpenCodeClient,
  sessionId: string,
): Promise<boolean> {
  return (await fetchOpenCodeSession(client, sessionId)) !== null;
}

/**
 * Whether the session pointer is actually on the conversation row, in
 * **three outcomes** that the caller must not collapse.
 *
 * A thrown `conversationService.update` is not proof the pointer is absent:
 * the UPDATE may have committed and a later step (or a later read) failed.
 * Only a **successful** read that positively identifies the pointer (or proves
 * its absence) is evidence. A read that fails is NOT evidence of absence —
 * it is `unknown`, and the caller must refuse compensating cleanup and record
 * the unresolved state instead of guessing.
 *
 *  - `bound` — the read succeeded and the row carries exactly this session
 *    id. The remote session is TBAi's; keep it.
 *  - `unbound` — the read succeeded and the row has no pointer or a different
 *    one. No TBAi handle exists; a failed compensating removal may be
 *    recorded as an orphan.
 *  - `unknown` — the read failed. The caller may NOT delete the session.
 *
 * @returns The outcome; never throws.
 */
async function verifySessionPointer(
  conversationId: string,
  sessionId: string,
): Promise<{ outcome: "bound" | "unbound" | "unknown"; error?: unknown }> {
  try {
    const conversation = await conversationService.get(conversationId);
    if (conversation?.opencodeSessionId === sessionId) {
      return { outcome: "bound" };
    }
    return { outcome: "unbound" };
  } catch (error) {
    return { outcome: "unknown", error };
  }
}

/**
 * Compensating removal of a remote session whose pointer is known to be
 * absent (RT-001). Confirms the outcome instead of assuming the call
 * succeeded: `session.remove` is followed by a lookup, and a
 * `session_not_found` from removal itself counts as already-gone.
 *
 * The `lookupInconclusive` outcome is the conservative one: when the
 * confirmation lookup fails without positive evidence of absence, the caller
 * must NOT claim the session is gone.
 *
 * Shared with the orphan reconciler, which performs the same removal after it
 * has independently established that no conversation points at the session.
 *
 * @returns `"removed"` only when the server positively no longer has the
 *   session; `"unconfirmed"` when removal failed; `"inconclusive"` when the
 *   confirmation lookup itself could not establish absence.
 */
export async function removeUnboundSession(
  client: OpenCodeClient,
  sessionId: string,
): Promise<{
  outcome: "removed" | "unconfirmed" | "inconclusive";
  error: unknown;
}> {
  try {
    await client.session.remove({ sessionID: sessionId });
  } catch (error) {
    const failure = toOpenCodeError(error);
    // Already gone is success for this purpose: there is nothing to orphan.
    if (failure.kind === "session_not_found" || failure.statusCode === SESSION_NOT_FOUND_STATUS) {
      return { outcome: "removed", error: undefined };
    }
    return { outcome: "unconfirmed", error: failure };
  }
  try {
    // Confirmation, not assumption: a resolved remove is only proof the call
    // returned. The session must actually be gone from the server's record.
    const stillThere = await fetchOpenCodeSession(client, sessionId);
    return stillThere
      ? {
          outcome: "unconfirmed",
          error: new Error("session still present after remove"),
        }
      : { outcome: "removed", error: undefined };
  } catch (error) {
    return { outcome: "inconclusive", error };
  }
}

/**
 * Writes the durable pre-create intent for a caller-supplied session id.
 *
 * FAIL-CLOSED. The remote create is only safe once a durable record names the
 * id it is about to use, so a journal error, a closed database, or a `false`
 * (no open record) result all abort before `session.create` is reached. The
 * throw is a typed error the route maps to 503 with an id-free message.
 *
 * @throws {OpenCodeSessionIntentError} When no open durable intent exists.
 */
async function requireCreateIntent(
  conversationId: string,
  sessionId: string,
  locationDirectory: string,
): Promise<void> {
  let open: boolean;
  try {
    open = await opencodeOrphanService.recordCreateIntent({
      conversationId,
      sessionId,
      locationDirectory,
    });
  } catch (error) {
    logger.error("opencode", "opencode.session_intent_record_failed", {
      conversationId,
      ...classifyError(error),
    });
    throw new OpenCodeSessionIntentError(conversationId, sessionId, { cause: error });
  }
  if (!open) {
    // The store returned "no open record". The id is freshly minted, so this
    // is not an expected already-resolved case; treating it as anything other
    // than a refusal would issue a create with no durable handle.
    const cause = new Error("journal reported no open intent record");
    logger.error("opencode", "opencode.session_intent_not_open", {
      conversationId,
      ...classifyError(cause),
    });
    throw new OpenCodeSessionIntentError(conversationId, sessionId, { cause });
  }
}

/**
 * Whether a create failure is a DEFINITIVE rejection: the server answered the
 * request and refused it, so this request did not create a session.
 *
 * Only declared 4xx answers qualify. A transport fault, timeout, abort, 5xx,
 * or unparseable body proves nothing about whether the request committed — the
 * response may simply have been lost — so those stay ambiguous.
 */
function isDefinitiveCreateRejection(failure: OpenCodeError): boolean {
  if (failure.kind === "auth") return true;
  const status = failure.statusCode;
  return status !== undefined && status >= 400 && status < 500;
}

/**
 * Create attempts this process currently has in flight for one
 * `(conversation, session)` pair: from the intent write through the pointer
 * persistence and any compensating cleanup.
 *
 * The reconciler consults this so it can never remove a session whose create
 * is still being bound. The grace window remains defense in depth, but it is
 * not the guarantee: a slow create can outlive any fixed window, and a
 * background pass must not race a live binding.
 */
const sessionCreatesInFlight = new Set<string>();

function createInFlightKey(conversationId: string, sessionId: string): string {
  return `${conversationId}\u0000${sessionId}`;
}

/** True while this process is creating or binding the exact session. */
export function isOpenCodeSessionCreateInFlight(
  conversationId: string,
  sessionId: string,
): boolean {
  return sessionCreatesInFlight.has(createInFlightKey(conversationId, sessionId));
}

/**
 * Deletes a create-intent row once the session's outcome is proven (bound,
 * or definitively never created). Best-effort: a surviving row is harmless,
 * because the reconciler re-proves the same facts before acting.
 */
async function discardCreateIntent(conversationId: string, sessionId: string): Promise<void> {
  try {
    await opencodeOrphanService.deleteCreateIntent(conversationId, sessionId);
  } catch (error) {
    logger.warn("opencode", "opencode.session_intent_cleanup_failed", {
      conversationId,
      ...classifyError(error),
    });
  }
}

/**
 * Settles the journal after a successful pointer write.
 *
 * A single-attempt create has no request left that could recreate the id, so
 * its intent is released. A create that was RETRIED may still have the first
 * request in flight: binding proves ownership, not that the request finished.
 * The risk-bearing row is therefore KEPT, and the touch ends any absence epoch
 * so the next 404 starts a fresh one. A failed touch deletes nothing, so the
 * obligation survives even when the journal write does not.
 */
async function settleBoundIntent(
  conversationId: string,
  sessionId: string,
  duplicateCreatePossible: boolean,
): Promise<void> {
  if (!duplicateCreatePossible) {
    await discardCreateIntent(conversationId, sessionId);
    return;
  }
  try {
    const touched = await opencodeOrphanService.touchOrphanedSession(
      conversationId,
      sessionId,
      Date.now(),
    );
    logger.warn("opencode", "opencode.session_bound_risk_retained", {
      conversationId,
      touched,
    });
  } catch (error) {
    logger.error("opencode", "opencode.session_bound_risk_touch_failed", {
      conversationId,
      ...classifyError(error),
    });
  }
}

/**
 * Records one unresolved orphan in the durable journal. The journal is the
 * ONLY log-bearing record that can name the session id: the structured log
 * redacts `sessionId`-shaped fields by policy, and an in-memory buffer is not
 * durable.
 *
 * Best-effort: a failed record does not block the compensating flow (the
 * operation already has to fail), but it is surfaced as an error-level log
 * with enough context for diagnosis. A durable record is still open in every
 * case that reaches here: the create path runs only after a mandatory intent,
 * and that intent is only deleted once the session is provably bound or gone.
 * So `recorded` reports true rather than claiming every durable trace was lost.
 *
 * @returns True when a durable record is (still) open and actionable.
 */
async function recordOrphan(input: {
  conversationId: string;
  sessionId: string;
  locationDirectory?: string;
  persistError: unknown;
  cleanupError?: unknown;
  verificationError?: unknown;
  /**
   * Whether an earlier create attempt may still commit. Passing `false` says
   * the create path ruled it out; omitting it preserves whatever the intent
   * already knew.
   */
  duplicateCreatePossible?: boolean;
}): Promise<boolean> {
  const persistCategory = classifyError(input.persistError).category;
  const cleanupCategory =
    input.cleanupError !== undefined ? classifyError(input.cleanupError).category : undefined;
  try {
    const open = await opencodeOrphanService.recordOrphanedSession({
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      locationDirectory: input.locationDirectory,
      lateCreateRisk: input.duplicateCreatePossible,
      persistErrorCategory: persistCategory,
      cleanupErrorCategory: cleanupCategory,
    });
    logger.warn(
      "opencode",
      open ? "opencode.session_orphan_recorded" : "opencode.session_orphan_already_resolved",
      {
        conversationId: input.conversationId,
        persistErrorCategory: persistCategory,
        ...(cleanupCategory ? { cleanupErrorCategory: cleanupCategory } : {}),
        ...(input.verificationError !== undefined
          ? { verificationError: classifyError(input.verificationError) }
          : {}),
      },
    );
    return open;
  } catch (error) {
    // The journal itself failed (database unavailable / closed / locked).
    // The operation still fails with its original error; the mandatory
    // pre-create intent remains open, so recovery is not lost.
    logger.error("opencode", "opencode.session_orphan_record_failed", {
      conversationId: input.conversationId,
      persistErrorCategory: persistCategory,
      ...(cleanupCategory ? { cleanupErrorCategory: cleanupCategory } : {}),
      ...classifyError(error),
    });
    return true;
  }
}

/**
 * Ensures an OpenCode session exists for a conversation and returns its
 * **binding** — the session id plus the directory scope that id is addressed
 * by. Reuses the conversation's resolved workspace directory as the session
 * cwd, creating the session once and persisting the id on the conversation row.
 * Subsequent calls return the stored id (idempotent resume).
 *
 * The directory is read back from the server's own session record rather than
 * re-derived from the folder table, so callers always receive the scope the
 * server actually bound — including after the conversation's workspace has
 * been migrated out from under an existing session.
 *
 * @param conversationId - TBAi conversation whose workspace roots the session.
 * @returns The session id, its directory scope (`null` when unreadable), and
 *   whether an existing live session was adopted rather than created.
 * @throws {EngineMismatchError} When the conversation is not an OpenCode row.
 * @throws {OpenCodeError} When the server is unreachable or refuses the create.
 */
export async function ensureOpenCodeSession(
  conversationId: string,
): Promise<OpenCodeSessionBinding> {
  // Phase 4 singleflight: concurrent callers for one conversation share a
  // single ensure — no second session.create, no last-writer-wins orphan.
  // (The persisted pointer covers the sequential case; this covers overlap.)
  const inFlight = sessionEnsuresInFlight.get(conversationId);
  if (inFlight) return inFlight;
  const ensure = ensureOpenCodeSessionInner(conversationId);
  sessionEnsuresInFlight.set(conversationId, ensure);
  try {
    return await ensure;
  } finally {
    if (sessionEnsuresInFlight.get(conversationId) === ensure) {
      sessionEnsuresInFlight.delete(conversationId);
    }
  }
}

const sessionEnsuresInFlight = new Map<string, Promise<OpenCodeSessionBinding>>();

async function ensureOpenCodeSessionInner(conversationId: string): Promise<OpenCodeSessionBinding> {
  const conversation = await conversationService.get(conversationId);
  if (!conversation) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }
  // Row-authoritative engine guard: refuse before spawning anything (no
  // server, no session, no pointer write). Absent engine reads as Direct —
  // legacy conversations predate the engine column and are all Direct.
  if (conversation.engine !== "opencode") {
    throw new EngineMismatchError(conversationId, conversation.engine ?? "direct");
  }

  const resolved = await resolveConversationWorkspace(conversationId);
  const directory = resolved.dir;
  const baseUrl = await openCodeServerManager.ensureBaseUrl();
  const client = createOpenCodeClient(baseUrl, { directory });
  if (conversation.opencodeSessionId) {
    const live = await fetchOpenCodeSession(client, conversation.opencodeSessionId);
    if (live) {
      // A live session that carries no model cannot select one, and a turn sent
      // to it does nothing. This is reached by sessions bound before the server
      // default was ever consulted, so it is a real lifecycle state and not a
      // hypothetical. Adopting a session and creating one must obey the same
      // rule, so both go through `pickSessionModel`.
      await assignSessionModelIfMissing(
        client,
        conversationId,
        conversation.opencodeModel,
        live.id,
        live.model,
      );
      return { sessionId: live.id, directory: live.directory, reusedExistingSession: true };
    }
    // Stale pointer (e.g. server restarted since the session was stored):
    // fall through and recreate rather than handing out a dead id.
    logger.warn("opencode", "opencode.session_stale", {
      conversationId,
      sessionId: conversation.opencodeSessionId,
    });
  }

  // `session.create` posts to `POST /api/session` and accepts a flat
  // `{ id?, location: { directory }, agent?, model? }` body — `location.directory`
  // is what roots the session in the conversation's workspace (it is NOT a
  // query param).
  //
  // RT-001: the id is minted HERE, not read off the response. OpenCode honours
  // a caller-supplied `ses_...` id and treats a repeat create for that id as
  // idempotent (verified against 2.1.2: the second create returns the first
  // session unchanged). That makes the id a correlation key that exists in
  // TBAi's hands BEFORE the request, so a crash after the server commits the
  // session but before any response is durable is still recoverable.
  const sessionId = `${SESSION_ID_PREFIX}${generateId()}`;
  const params: SessionCreateParams = { id: sessionId, location: { directory } };

  if (conversation.opencodeAgent) {
    params.agent = conversation.opencodeAgent;
  }
  if (conversation.opencodeModel) {
    const modelRef = await resolveOpenCodeModelRef(conversation.opencodeModel);
    if (modelRef) {
      params.model = { id: modelRef.modelID, providerID: modelRef.providerID };
      // The thinking level (variant) is baked into the session's model config
      // at creation time. Changing the variant mid-session takes effect on
      // the next session creation (server restart / session expiry).
      if (conversation.opencodeVariant) {
        params.model.variant = conversation.opencodeVariant;
      }
    }
  }

  // A conversation with no stored choice still gets a model, from the server's
  // own default. Without this the session is created unbound, the composer sits
  // at "Select a model", and a turn sent to it does nothing at all. It is the
  // same rule the adopt path applies, so a session ends up bound however it came
  // into being — and it only runs when the stored branch above did not, so a
  // reader's explicit choice can never be overridden here.
  if (!params.model) {
    // M11: a catalogue-read failure DEGRADES, it does not abort. The session
    // is still created - unbound, with no model, and with the reason logged.
    //
    // The alternative was strictly worse: `session.create` never ran, so the
    // conversation had no session at all, and the reader was told the session
    // could not start because a model CATALOGUE could not be read. The
    // invariant this module documents - "tolerant by construction" - was not
    // true of the code, and the creation path is where it mattered most: an
    // unbound session is repaired on the next turn, while a session that was
    // never created is not.
    try {
      const target = pickSessionModel({
        storedModel: await resolveStoredModel(conversation.opencodeModel),
        serverDefault: await fetchServerDefaultModel(),
      });
      if (target) params.model = { id: target.id, providerID: target.providerID };
    } catch (error) {
      logger.warn("opencode", "opencode.session_model_unresolved", {
        conversationId,
        ...classifyError(error),
      });
    }
  }

  // RT-001: from here to the returned binding, this process owns this session.
  // The reconciler consults this registry so it can never remove a session
  // whose create is still being bound; the release runs on every outcome.
  const inFlightKey = createInFlightKey(conversationId, sessionId);
  sessionCreatesInFlight.add(inFlightKey);
  try {
    // Durable BEFORE the request, and MANDATORY: the intent row carries the id
    // the server will be asked to use, so the remote session can be found even
    // if this process dies before it ever sees a response. A journal failure
    // throws here, so `session.create` is never reached without a durable
    // handle (fail-closed).
    await requireCreateIntent(conversationId, sessionId, directory);

    const { directory: createdDirectory, duplicateCreatePossible } = await createOrAdoptSession();

    // RT-001: the remote session exists from here on, and the pointer write is
    // the only thing that binds it to TBAi. A failure here must never leave
    // the session orphaned with no handle, and must never report success.
    try {
      await conversationService.update(conversationId, { opencodeSessionId: sessionId });
      // Bound. A single-attempt intent has served its purpose; a retried one
      // keeps its risk because the first request may still commit.
      await settleBoundIntent(conversationId, sessionId, duplicateCreatePossible);
    } catch (persistError) {
      // A thrown update is not proof the pointer is absent — it may have
      // committed before a later step failed. Verify before acting.
      const verification = await verifySessionPointer(conversationId, sessionId);
      if (verification.outcome === "bound") {
        // The binding IS durable even though the write call rejected. The
        // session is TBAi's; keep it, return the established binding, and
        // surface the write failure without treating it as a session loss.
        await settleBoundIntent(conversationId, sessionId, duplicateCreatePossible);
        logger.warn("opencode", "opencode.session_persist_recovered", {
          conversationId,
          sessionId,
          ...classifyError(persistError),
        });
        return { sessionId, directory: createdDirectory, reusedExistingSession: false };
      }

      // No confirmed TBAi handle for this session.
      if (verification.outcome === "unknown") {
        // The read failed: the pointer may exist. Do NOT delete a possibly
        // valid session. Record the unresolved state durably and fail the
        // operation without claiming anything about the session.
        const recorded = await recordOrphan({
          conversationId,
          sessionId,
          locationDirectory: createdDirectory,
          persistError,
          verificationError: verification.error,
          duplicateCreatePossible,
        });
        logger.error("opencode", "opencode.session_persist_unresolved", {
          conversationId,
          ...classifyError(persistError),
          verificationError: classifyError(verification.error),
        });
        throw new OpenCodeSessionPersistError(
          conversationId,
          sessionId,
          "verification_unknown",
          recorded,
          verification.error,
          { cause: persistError },
        );
      }

      // Confirmed unbound: compensate by removing the remote session.
      const { outcome, error: cleanupError } = await removeUnboundSession(client, sessionId);
      const removed = outcome === "removed";
      let recorded = false;
      if (removed) {
        if (duplicateCreatePossible) {
          // An attempt whose response was lost may still be in flight and can
          // recreate this id after the confirmed removal. Dropping the intent
          // here would leave that recreation with no durable record, so the
          // risk-bearing intent is kept. Its absence epoch is still unstarted,
          // so the reconciler's next 404 begins the post-removal horizon.
          recorded = true;
          logger.warn("opencode", "opencode.session_persist_compensated_intent_retained", {
            conversationId,
            ...classifyError(persistError),
          });
        } else {
          // The create path ruled out any outstanding duplicate, so removal is
          // settlement and the intent has served its purpose.
          await discardCreateIntent(conversationId, sessionId);
          logger.warn("opencode", "opencode.session_persist_compensated", {
            conversationId,
            sessionId,
            ...classifyError(persistError),
          });
        }
      } else {
        recorded = await recordOrphan({
          conversationId,
          sessionId,
          locationDirectory: createdDirectory,
          persistError,
          cleanupError,
          duplicateCreatePossible,
        });
        logger.error("opencode", "opencode.session_orphaned", {
          conversationId,
          recorded,
          persistError: classifyError(persistError),
          cleanupError: classifyError(cleanupError),
          cleanupOutcome: outcome,
        });
      }
      const mappedOutcome: OpenCodeSessionPersistError["cleanup"] =
        outcome === "removed"
          ? "confirmed_removed"
          : outcome === "unconfirmed"
            ? "removal_failed"
            : "lookup_inconclusive";
      throw new OpenCodeSessionPersistError(
        conversationId,
        sessionId,
        mappedOutcome,
        recorded,
        cleanupError,
        { cause: persistError },
      );
    }
    logger.info("opencode", "opencode.session_create", { conversationId, sessionId });
    return { sessionId, directory: createdDirectory, reusedExistingSession: false };
  } finally {
    sessionCreatesInFlight.delete(inFlightKey);
  }

  /**
   * Creates the session, or recovers the exact id after an ambiguous failure.
   *
   * A thrown create is NOT proof the server did not create the session: an
   * aborted, truncated or lost response can hide a committed create. The
   * caller-supplied id is the correlation key, so the server's own record for
   * THAT id decides the outcome. Two outcomes are distinguished by the error:
   *
   *  - **Definitive rejection** (the server answered 4xx): this request did
   *    not create anything, so the intent has no obligation and is removed.
   *  - **Everything else** (transport, timeout, abort, 5xx, malformed/absent
   *    response body): ambiguous. The intent is kept, and a 404 does NOT
   *    authorise deleting it — absence at lookup time says nothing about a
   *    request whose response was lost.
   *
   * On a 404 the SAME id is retried once. That is safe only because upstream
   * is idempotent for a caller-supplied id: verified against OpenCode 2.1.2,
   * sequential and concurrent repeats return the first session unchanged and
   * never rebind it to another directory. So a retry can neither mint a second
   * identity nor overwrite an established binding; if the original request
   * also completes, both converge on one session.
   *
   * If the retry is also unresolved, the risk-bearing intent is left for the
   * reconciler, which never clears it on a bare 404.
   *
   * @returns The scope to hand the runtime, plus whether an earlier ambiguous
   *   attempt might STILL be in flight. That is true only on a retried path: a
   *   first attempt that returned (or that a probe proved had committed) leaves
   *   no second request outstanding. The flag matters after a compensating
   *   removal, because a request still in flight can recreate the freed id.
   */
  async function createOrAdoptSession(): Promise<{
    directory: string;
    duplicateCreatePossible: boolean;
  }> {
    let responseMismatch = false;

    const attempt = async (): Promise<string> => {
      responseMismatch = false;
      const session = await client.session.create(params);
      const responseId = typeof session?.id === "string" ? session.id : "";
      if (responseId.length === 0) {
        // The response proves the call returned, not what it created. Treat it
        // as ambiguous and let the exact-id probe decide.
        throw new OpenCodeError(
          "malformed",
          "OpenCode session create response carried no session id",
        );
      }
      if (responseId !== sessionId) {
        // Refuse to bind an id the request did not name: it would point at a
        // session TBAi cannot account for. The intent stays recoverable.
        responseMismatch = true;
        throw new OpenCodeError(
          "malformed",
          "OpenCode session create did not return the supplied session id",
        );
      }
      // Prefer the V2 response's authoritative location over the submitted path.
      return asDirectory(session.location?.directory) ?? directory;
    };

    try {
      return { directory: await attempt(), duplicateCreatePossible: false };
    } catch (createError) {
      const failure = toOpenCodeError(createError);
      if (responseMismatch) throw failure;

      if (isDefinitiveCreateRejection(failure)) {
        // The server processed and refused this request. No session exists to
        // recover, so the intent is no longer needed.
        await discardCreateIntent(conversationId, sessionId);
        throw failure;
      }

      let probe: Awaited<ReturnType<typeof fetchOpenCodeSession>>;
      try {
        probe = await fetchOpenCodeSession(client, sessionId);
      } catch (probeError) {
        // Neither presence nor absence established. Leave the intent durable
        // and surface the original failure; the reconciler settles it later.
        logger.error("opencode", "opencode.session_create_unresolved", {
          conversationId,
          persistErrorCategory: classifyError(failure).category,
          probeError: classifyError(probeError),
        });
        throw failure;
      }
      if (probe) {
        // The session exists despite the failed call. It carries the id TBAi
        // minted, so it is ours: adopt it and continue to the pointer write.
        // The id could only appear because that request committed, so it is
        // finished: no second request exists for this id in this process.
        logger.warn("opencode", "opencode.session_create_recovered", {
          conversationId,
          persistErrorCategory: classifyError(failure).category,
        });
        return {
          directory: probe.directory ?? directory,
          duplicateCreatePossible: false,
        };
      }

      // A 404 is NOT terminal: the failed request may still commit. Retry the
      // SAME id under the verified upstream idempotency guarantee.
      logger.warn("opencode", "opencode.session_create_retry", {
        conversationId,
        persistErrorCategory: classifyError(failure).category,
      });
      try {
        // The FIRST attempt's outcome is still unknown: it may commit even
        // though the retry returned. That is what the flag records.
        return { directory: await attempt(), duplicateCreatePossible: true };
      } catch (retryError) {
        const retryFailure = toOpenCodeError(retryError);
        if (responseMismatch) throw retryFailure;

        // The retry's outcome still does not settle the ORIGINAL request: a
        // definitive rejection now does not prove the earlier attempt failed.
        // Probe the exact id once more so a late commit is adopted now.
        let retryProbe: Awaited<ReturnType<typeof fetchOpenCodeSession>>;
        try {
          retryProbe = await fetchOpenCodeSession(client, sessionId);
        } catch (retryProbeError) {
          logger.error("opencode", "opencode.session_create_unresolved", {
            conversationId,
            persistErrorCategory: classifyError(retryFailure).category,
            probeError: classifyError(retryProbeError),
          });
          throw retryFailure;
        }
        if (retryProbe) {
          logger.warn("opencode", "opencode.session_create_recovered", {
            conversationId,
            persistErrorCategory: classifyError(retryFailure).category,
            attempt: "retry",
          });
          return {
            directory: retryProbe.directory ?? directory,
            // Either attempt may have produced the session; the first is not
            // provably finished, so a removal must not discard the intent.
            duplicateCreatePossible: true,
          };
        }
        // Still absent, still not terminal: the intent is retained. The
        // reconciler will not clear a risk-bearing intent on a bare 404.
        logger.error("opencode", "opencode.session_create_retry_failed", {
          conversationId,
          persistErrorCategory: classifyError(retryFailure).category,
        });
        throw retryFailure;
      }
    }
  }
}

/**
 * Process-local activity of one OpenCode session.
 *
 * - `running` — this OpenCode process currently holds an active drain for the
 *   session. It does **not** prove the engine is retrying; only retry events
 *   and status set the retry banner.
 * - `not-running` — the session is absent from this process's active map. It
 *   does **not** mean "no work exists": a durable execution claim, a queued
 *   inbox row, or an orphaned server can coexist with it.
 * - `unknown` — the read could not establish a result. Never treated as idle.
 */
export type OpenCodeSessionActivity = "running" | "not-running" | "unknown";

/**
 * Reads whether the managed OpenCode process currently owns an active drain for
 * one session of one conversation. Purely a read: it never creates a session,
 * never resumes one, and never returns the upstream active map.
 *
 * The conversation/session pair is verified **before** any OpenCode request, so
 * a caller cannot use this endpoint to probe a session it does not own. The
 * pairing guard throws; a failed activity read itself degrades to `unknown`.
 *
 * Note on server start: this path calls `ensureBaseUrl()` like every other
 * session read, so it may start the managed server. That side effect is
 * accepted and deliberate — the read has nothing to answer otherwise — and it
 * still never creates an OpenCode *session* (the P7 decision).
 *
 * @param conversationId - TBAi conversation that must own the session.
 * @param sessionId - The OpenCode session id to check.
 * @returns The process-local activity, or `unknown` when it could not be read.
 * @throws {OpenCodeSessionMismatchError} When the pair is not a known binding.
 */
export async function getOpenCodeSessionActivity(
  conversationId: string,
  sessionId: string,
): Promise<OpenCodeSessionActivity> {
  const conversation = await conversationService.get(conversationId);
  if (conversation?.engine !== "opencode" || conversation?.opencodeSessionId !== sessionId) {
    throw new OpenCodeSessionMismatchError(conversationId, sessionId);
  }
  try {
    const resolved = await resolveConversationWorkspace(conversationId);
    const baseUrl = await openCodeServerManager.ensureBaseUrl();
    const client = createOpenCodeClient(baseUrl, { directory: resolved.dir });
    const active = await client.session.active();
    // Only the requested entry is read. The map itself never leaves this
    // function — not in the return value and not in a log line.
    return active[sessionId]?.type === "running" ? "running" : "not-running";
  } catch (error) {
    logger.warn("opencode", "opencode.session_activity_failed", {
      conversationId,
      sessionId,
      ...classifyError(error),
    });
    return "unknown";
  }
}

/**
 * Best-effort termination of the OpenCode session bound to a conversation.
 * Interrupts any live work, removes the server-side session, and clears the
 * persisted pointer. Every step tolerates absence (missing conversation, no
 * session, dead server) so the call is idempotent and safe to repeat — the
 * deletion coordinator relies on this to never block conversation teardown.
 *
 * Uses the official V2 `session.interrupt` then `session.remove` contract.
 *
 * The pointer is cleared ONLY when the remote session is gone. A failed
 * removal keeps it and reports why (L2): a cleared pointer orphans a session
 * the server still has, and nothing holds the handle that could remove it.
 *
 * @param conversationId - TBAi conversation whose session should end.
 * @returns Whether a live session was terminated, and why not when it was not.
 */
export async function terminateOpenCodeSession(
  conversationId: string,
): Promise<{ terminated: boolean; reason?: "remote-removal-failed" | "unreachable" }> {
  const conversation = await conversationService.get(conversationId);
  const sessionId = conversation?.opencodeSessionId;
  if (!conversation || !sessionId) {
    return { terminated: false };
  }
  try {
    const resolved = await resolveConversationWorkspace(conversationId);
    const baseUrl = await openCodeServerManager.ensureBaseUrl();
    const client = createOpenCodeClient(baseUrl, { directory: resolved.dir });
    // Interrupt first, then remove: stop live work before dropping the session
    // out from under it. Each step is individually best-effort — an idle run
    // has nothing to interrupt and a restarted server has nothing to remove.
    // Failures are recorded at debug level (both are expected on the happy
    // path) so a genuinely broken call is still diagnosable.
    try {
      await client.session.interrupt({ sessionID: sessionId });
    } catch (err) {
      logger.debug("opencode", "opencode.session_interrupt_skipped", {
        conversationId,
        ...classifyError(toOpenCodeError(err)),
      });
    }
    try {
      await client.session.remove({ sessionID: sessionId });
    } catch (err) {
      // L2: the remote removal FAILED. The pointer is KEPT.
      //
      // A cleared pointer orphans the session: the server still has it, and
      // nothing holds the handle that could remove it. A kept pointer is
      // recoverable - the next termination attempt tries again, and the reader
      // can still see which session the conversation is bound to. The plan's
      // decision (D17) is exactly this: "a pointer to a possibly-live session
      // is recoverable, a cleared pointer orphans it".
      logger.warn("opencode", "opencode.session_remove_failed", {
        conversationId,
        sessionId,
        ...classifyError(toOpenCodeError(err)),
      });
      return { terminated: false, reason: "remote-removal-failed" };
    }
  } catch (err) {
    logger.warn("opencode", "opencode.session_terminate_failed", {
      conversationId,
      ...classifyError(toOpenCodeError(err)),
    });
    return { terminated: false, reason: "unreachable" };
  }
  // The session is gone, but an outstanding create may still recreate the id.
  // A risk-free intent is released; a risk-bearing row is kept, and its
  // absence epoch is reset so the next 404 starts a fresh post-removal
  // horizon. A journal failure deletes nothing, so the obligation survives;
  // the pointer still reflects the remote state and is cleared either way.
  let journal: "released" | "retained" | "absent" | "failed" = "failed";
  try {
    journal = await opencodeOrphanService.settleTerminatedSession({
      conversationId,
      sessionId,
      at: Date.now(),
    });
  } catch (error) {
    logger.error("opencode", "opencode.session_terminate_journal_failed", {
      conversationId,
      ...classifyError(error),
    });
  }
  await conversationService.update(conversationId, { opencodeSessionId: null });
  logger.info("opencode", "opencode.session_terminate", {
    conversationId,
    sessionId,
    journal,
  });
  return { terminated: true };
}
