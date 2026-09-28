import { createOpenCodeClient, lastStatusForSessionLookup, type OpenCodeClient } from "./client";
import { OpenCodeError, toOpenCodeError } from "./errors";
import { conversationService } from "../storage";
import { resolveConversationWorkspace } from "../workspace";
import { openCodeServerManager } from "./serverManager";
import { resolveOpenCodeModelRef } from "./capabilities";
import {
  fetchServerDefaultModel,
  pickSessionModel,
  resolveStoredModel,
} from "./sessionModel";
import { logger } from "../../lib/logger";
import { classifyError } from "../../lib/errors";

/** OpenCode `ModelRef` shape accepted by `session.create` / `defaultModel`. */
type ModelRef = { id: string; providerID: string; variant?: string };

/** Mutable form of the official `SessionCreateInput` (whose fields are readonly). */
type SessionCreateParams = {
  location: { directory: string };
  agent?: string;
  model?: ModelRef;
};

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
    super(
      `Conversation ${conversationId} uses the ${engine} engine, not OpenCode`,
    );
    this.name = "EngineMismatchError";
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
 * @param client - Client bound to the managed server's base URL.
 * @param sessionId - The persisted OpenCode session id to look up.
 * @returns The session id + directory, or null when the server has no such session.
 * @throws {OpenCodeError} When absence could not be established either way.
 */
async function fetchOpenCodeSession(
  client: OpenCodeClient,
  sessionId: string,
): Promise<{ id: string; directory: string | null; model: string | null } | null> {
  try {
    const session = await client.session.get({ sessionID: sessionId });
    if (typeof session?.id !== "string" || session.id.length === 0) {
      throw new OpenCodeError(
        "malformed",
        "OpenCode session response carried no session id",
      );
    }
    return {
      id: session.id,
      directory: asDirectory(session.location?.directory) ?? null,
      // The session's current model, so adopting it can tell "already has one"
      // from "has none" without a second request. OpenCode reports an unset
      // model as an empty/absent field, so anything non-string is "none".
      model: typeof session.model?.id === "string" && session.model.id.length > 0
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
 * @returns The session id and its directory scope (`null` when unreadable).
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

async function ensureOpenCodeSessionInner(
  conversationId: string,
): Promise<OpenCodeSessionBinding> {
  const conversation = await conversationService.get(conversationId);
  if (!conversation) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }
  // Row-authoritative engine guard: refuse before spawning anything (no
  // server, no session, no pointer write). Absent engine reads as Direct —
  // legacy conversations predate the engine column and are all Direct.
  if (conversation.engine !== "opencode") {
    throw new EngineMismatchError(
      conversationId,
      conversation.engine ?? "direct",
    );
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
      return { sessionId: live.id, directory: live.directory };
    }
    // Stale pointer (e.g. server restarted since the session was stored):
    // fall through and recreate rather than handing out a dead id.
    logger.warn("opencode", "opencode.session_stale", {
      conversationId,
      sessionId: conversation.opencodeSessionId,
    });
  }

  // `session.create` posts to `POST /api/session` and accepts a flat
  // `{ location: { directory }, agent?, model? }` body — `location.directory`
  // is what roots the session in the conversation's workspace (it is NOT a
  // query param). The call resolves to the created `SessionInfo`, so the id is
  // read straight off it. Verified live against the managed server.
  const params: SessionCreateParams = { location: { directory } };

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
    const target = pickSessionModel({
      storedModel: await resolveStoredModel(conversation.opencodeModel),
      serverDefault: await fetchServerDefaultModel(),
    });
    if (target) params.model = { id: target.id, providerID: target.providerID };
  }

  let sessionId: string | undefined;
  let createdDirectory: string;
  try {
    const session = await client.session.create(params);
    sessionId = session?.id;
    // Prefer the V2 response's authoritative location over the submitted path.
    createdDirectory = asDirectory(session.location?.directory) ?? directory;
  } catch (err) {
    throw toOpenCodeError(err);
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("OpenCode session create failed: response carried no session id");
  }

  await conversationService.update(conversationId, { opencodeSessionId: sessionId });
  logger.info("opencode", "opencode.session_create", { conversationId, sessionId });
  return { sessionId, directory: createdDirectory };
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
 * @param conversationId - TBAi conversation whose session should end.
 * @returns Whether a live session was terminated (false = nothing to do).
 */
export async function terminateOpenCodeSession(
  conversationId: string,
): Promise<{ terminated: boolean }> {
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
      logger.debug("opencode", "opencode.session_remove_skipped", {
        conversationId,
        ...classifyError(toOpenCodeError(err)),
      });
    }
  } catch (err) {
    logger.warn("opencode", "opencode.session_terminate_failed", {
      conversationId,
      ...classifyError(toOpenCodeError(err)),
    });
    return { terminated: false };
  }
  await conversationService.update(conversationId, { opencodeSessionId: null });
  logger.info("opencode", "opencode.session_terminate", {
    conversationId,
    sessionId,
  });
  return { terminated: true };
}
