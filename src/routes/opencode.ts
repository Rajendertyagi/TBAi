import { Hono } from "hono";
import { z } from "zod";
import {
  EngineMismatchError,
  ensureOpenCodeSession,
  getOpenCodeSessionActivity,
  OpenCodeSessionIntentError,
  OpenCodeSessionMismatchError,
  reconcileOpenCodeSessionDirectory,
  terminateOpenCodeSession,
} from "../services/opencode/sessions";
import { getOpenCodeCapabilities } from "../services/opencode/capabilities";
import { getOpenCodeCommandFeed } from "../services/opencode/commands";
import {
  historyOwnerFromTarget,
  LOCAL_HISTORY_OWNER,
  OpenCodeHistoryBoundaryError,
  serializeHistoryOwner,
} from "../services/opencode/historyBoundary";
import {
  OpenCodeBinaryMissingError,
  stripOpenCodeProxyPrefix,
} from "../services/opencode/serverManager";
import {
  getOpenCodeDirectoryHeaders,
  OPENCODE_DIRECTORY_HEADER,
} from "../services/opencode/runtime";
import { matchOpenCodeProxyRoute } from "../services/opencode/proxyRoutes";
import {
  authorizeOpenCodeProxyRequest,
  OPENCODE_SESSION_HEADER,
  OpenCodeProxyRefusalError,
} from "../services/opencode/proxyAuthorization";
import {
  appendOpenCodePermissionRule,
  OpenCodeConfigNotFoundError,
  OpenCodeConfigUnreadableError,
  readOpenCodeConfigDocument,
  removeOpenCodePermissionRule,
  setOpenCodeConfigValue,
  setOpenCodePermissionEffect,
  setOpenCodePermissionEffectAt,
  writeOpenCodeConfigDocument,
} from "../services/opencode/configDocument";
import {
  redactOpenCodeConfigDocument,
  redactOpenCodeConfigText,
} from "../services/opencode/configRedaction";
import {
  OpenCodeConfigWriteDisabledError,
  type OpenCodeConfigWriteRefusalReason,
  assertOpenCodeConfigWriteAllowed,
  openCodeConfigWriteRefusal,
} from "../services/opencode/configWritePolicy";
import { readConnectionState } from "../services/opencode/connectionState";
import { OpenCodeRedirectRefusedError, type OpenCodeTransport } from "../services/opencode/http";
import {
  describeOpenCodeRuntime,
  resolveOpenCodeRuntimeTarget,
} from "../services/opencode/runtimeTarget";
import { listImportableOpenCodeSessions, importOpenCodeSession } from "../services/opencode/import";
import {
  OpenCodeDirectoryUnavailableError,
  OpenCodeImportStaleSourceError,
  OpenCodeSessionAlreadyImportedError,
  OpenCodeImportSessionEligibilityError,
  OpenCodeImportedSessionMissingError,
} from "../services/opencode/errors";
import { logger, getRequestContext } from "../lib/logger";
import { classifyError } from "../lib/errors";
import { openCodeSessionActivitySchema } from "../lib/validation";

const sessionRequestSchema = z.object({
  conversationId: z.string().min(1),
});

const app = new Hono();

/**
 * Maps OpenCode failures to a message + status. A missing CLI binary is a 503
 * with an actionable message (the user can install it); a journal outage is a
 * 503 because the session was deliberately NOT created and retrying is safe; a
 * wrong-engine caller is a 422 (the row, not the server, is at fault); a
 * history that belongs to a different service is a 409 — retrying changes
 * nothing until the service does; everything else is a generic 500 so
 * internals never leak to the browser.
 */
function openCodeError(
  err: unknown,
  fallback: string,
): { message: string; status: 503 | 502 | 422 | 409 | 404 | 500 } {
  if (err instanceof OpenCodeBinaryMissingError) {
    return { message: err.message, status: 503 };
  }
  if (err instanceof OpenCodeSessionIntentError) {
    // Fail-closed: no remote session was requested. The message names no
    // conversation or session id; the retry is safe because nothing was made.
    return { message: err.message, status: 503 };
  }
  if (err instanceof OpenCodeRedirectRefusedError) {
    // The refusal carries only the status; the Location header is never read,
    // so no redirect target can reach a log, an error body or the browser.
    return { message: err.message, status: 502 };
  }
  if (err instanceof EngineMismatchError) {
    return { message: err.message, status: 422 };
  }
  if (err instanceof OpenCodeHistoryBoundaryError) {
    // The conversation's session is owned by a service that is not the one in
    // use. The message names service kinds, never a credential or session id.
    return {
      message: err.message,
      status: err.refusal === "adopted_unavailable" ? 503 : 409,
    };
  }
  if (err instanceof OpenCodeSessionAlreadyImportedError) {
    return { message: err.message, status: 409 };
  }
  if (err instanceof OpenCodeImportStaleSourceError) {
    return { message: err.message, status: 409 };
  }
  if (err instanceof OpenCodeImportSessionEligibilityError) {
    return { message: err.message, status: 422 };
  }
  if (err instanceof OpenCodeImportedSessionMissingError) {
    return { message: err.message, status: 404 };
  }
  if (err instanceof OpenCodeDirectoryUnavailableError) {
    return { message: err.message, status: 422 };
  }
  return { message: fallback, status: 500 };
}

/**
 * Session seam: creates or resumes the OpenCode session bound to a conversation
 * (reusing its resolved workspace directory) and returns the session id **plus
 * the directory scope that id is addressed by**. This is the only
 * TS→OpenCode-server boundary for session lifecycle; the runtime talks to the
 * server through the proxy below.
 *
 * The directory is part of the response because the browser runtime must scope
 * its event subscription to it: OpenCode answers an unscoped `GET /event` with
 * a stub (only `server.connected` + `server.heartbeat`), so a runtime that
 * subscribes unscoped never receives a single session event and a completed
 * reply only becomes visible after a history reload. Resolving the scope here —
 * where the server's session record is already in hand — keeps the id and its
 * scope from ever being separable in the client. `null` means the server did
 * not report one; the runtime then leaves its subscription unscoped rather than
 * guessing a path.
 */
app.post("/session", async (c) => {
  const parsed = sessionRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "conversationId is required" }, 400);
  }
  try {
    const { sessionId, directory, reusedExistingSession } = await ensureOpenCodeSession(
      parsed.data.conversationId,
    );
    return c.json({ sessionId, directory, reusedExistingSession });
  } catch (err) {
    logger.error("opencode", "opencode.session_error", { ...classifyError(err) });
    const mapped = openCodeError(err, "Failed to start OpenCode session");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/**
 * Authoritatively reconciles the persisted directory for a session with OpenCode's
 * server record after an external move.
 */
app.post("/session/reconcile-directory", async (c) => {
  const parsed = sessionRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "conversationId is required" }, 400);
  }
  try {
    const { sessionId, directory } = await reconcileOpenCodeSessionDirectory(
      parsed.data.conversationId,
    );
    return c.json({ sessionId, directory });
  } catch (err) {
    logger.error("opencode", "opencode.session_reconcile_error", { ...classifyError(err) });
    const mapped = openCodeError(err, "Failed to reconcile OpenCode session directory");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/**
 * Session termination for conversation teardown. Best-effort by contract (see
 * `terminateOpenCodeSession`): aborts live work, deletes the server-side
 * session, clears the persisted pointer. Missing conversation/session/server
 * surfaces as `{ terminated: false }`, never an error, so the deletion
 * coordinator can call it unconditionally. A failed REMOVAL also reports
 * `{ terminated: false, reason }` and keeps the pointer, because a cleared
 * pointer orphans a session the server still has. Registered before the proxy
 * catch-all below.
 */
app.post("/session/terminate", async (c) => {
  const parsed = sessionRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "conversationId is required" }, 400);
  }
  try {
    const result = await terminateOpenCodeSession(parsed.data.conversationId);
    return c.json(result);
  } catch (err) {
    logger.error("opencode", "opencode.session_terminate_error", {
      ...classifyError(err),
    });
    const mapped = openCodeError(err, "Failed to terminate OpenCode session");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/**
 * Read-only session activity for one conversation/session pair.
 *
 * This is the browser's only path to `session.active`. That operation answers
 * with the **global** active-session map of the managed process; exposing it
 * would tell the browser about sessions it does not own, so the map never
 * leaves the backend. The pair is verified against the conversation row before
 * any OpenCode request (an unknown pair is a 404, not a probe). A failure to
 * read returns `unknown`, never `not-running`: absent from the active map only
 * describes this process, and an unreadable answer proves nothing.
 *
 * Registered before the proxy catch-all below, so TBAi handles it rather than
 * forwarding it upstream.
 */
app.post("/session/activity", async (c) => {
  const parsed = openCodeSessionActivitySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "conversationId and sessionId are required" }, 400);
  }
  const { conversationId, sessionId } = parsed.data;
  try {
    const activity = await getOpenCodeSessionActivity(conversationId, sessionId);
    return c.json({ activity });
  } catch (err) {
    if (err instanceof OpenCodeSessionMismatchError) {
      logger.warn("opencode", "opencode.session_activity_mismatch", {
        conversationId,
      });
      return c.json({ error: "Unknown conversation/session pair" }, 404);
    }
    logger.error("opencode", "opencode.session_activity_error", {
      conversationId,
      ...classifyError(err),
    });
    const mapped = openCodeError(err, "Failed to read OpenCode session activity");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/**
 * OpenCode configuration management (read + targeted write).
 *
 * Two rules make this safe, and both are enforced in
 * `services/opencode/configDocument.ts` rather than here:
 *
 *   1. The document edited is the one the SERVER reports as carrying
 *      `permissions`, not a path TBAi computes. `data/opencode-home/opencode.json`
 *      exists and is not the permission source.
 *   2. A write is refused outright when the document is malformed or when
 *      `permissions` is not a rule array. There is no fallback policy.
 *
 * The write route takes ONE `(action, resource, effect)` triple, not a document.
 * That is what makes preservation structural rather than a promise: the server
 * cannot be handed a ruleset to install, so it can only be told to change one
 * existing rule, and every other rule keeps its index by construction.
 */

/**
 * Zod-validated body for a single permission-effect change.
 *
 * `index` is OPTIONAL, and its presence changes how the rule is addressed:
 *
 * - with it, the rule at that position is changed after its identity is
 *   re-checked, which is exact even when the configuration carries the same
 *   `(action, resource)` pair twice;
 * - without it, the rule is addressed by its `(action, resource)` pair, and a
 *   pair that identifies more than one rule is REFUSED rather than applied to
 *   an arbitrary match.
 */
const permissionEffectSchema = z.object({
  action: z.string().min(1),
  resource: z.string().min(1),
  effect: z.enum(["allow", "ask", "deny"]),
  index: z.number().int().min(0).optional(),
});

/**
 * The service-wide target for configuration reads and writes.
 *
 * It is the runtime's installed target, not "the managed server": an adopted
 * service owns its own document, and reading it with TBAi's managed password
 * would be both wrong and unauthorized. Writes remain refused by
 * {@link applyPermissionChange}'s G4 gate.
 */
async function configServerTarget(): Promise<{
  baseUrl: string;
  transport: OpenCodeTransport;
}> {
  const target = await resolveOpenCodeRuntimeTarget();
  return {
    baseUrl: target.baseUrl,
    transport: target.transport,
  };
}

/**
 * The refusal the installed runtime's write path would raise, or `null` when a
 * write is permitted.
 *
 * Derived from the same policy function the writer uses, so the read projection
 * below cannot offer editing on a runtime whose write would be refused.
 */
function configWriteRefusalForRuntime(): OpenCodeConfigWriteRefusalReason | null {
  return openCodeConfigWriteRefusal({
    mode: readConnectionState().target.mode === "adopted" ? "adopted" : "managed",
  });
}

/**
 * The ONE write path for permission rules, shared by edit / add / remove.
 *
 * All three take a function that maps the current rules to the next ones, and
 * all three get the same guarantees for free: the document is re-read here
 * rather than trusting the browser's copy (a stale base is exactly how an
 * unrelated rule gets dropped), a malformed document is refused, and a
 * transform that returns the identical array writes nothing at all.
 *
 * Returns the Hono response so each route is a single call plus its own error
 * mapping — a duplicated read-refuse-write sequence is how the three operations
 * would drift apart.
 *
 * Every write is refused here, before this function reads or writes anything:
 * an adopted service because G4 is unproven, and the managed service because
 * the child runs with the user's own configuration environment and therefore
 * has no TBAi-owned root to contain a write (§9.3(1)).
 */
async function applyPermissionChange(
  transform: (current: unknown) => unknown,
  signal: AbortSignal,
): Promise<Response | { readonly path: string; readonly changed: boolean }> {
  assertOpenCodeConfigWriteAllowed({
    mode: readConnectionState().target.mode === "adopted" ? "adopted" : "managed",
  });
  const target = await configServerTarget();
  const document = await readOpenCodeConfigDocument(target, { signal });
  if (document.malformed) {
    throw new OpenCodeConfigUnreadableError(
      "OpenCode configuration is not valid JSON; refusing to write",
    );
  }
  const nextPermissions = transform(document.doc.permissions);
  // An identity result means the change was a no-op (the effect already
  // matched). Writing it would still rewrite the file, so it is reported
  // without touching disk.
  if (nextPermissions === document.doc.permissions) {
    return { path: document.path, changed: false };
  }
  const nextText = setOpenCodeConfigValue(document.raw, "permissions", nextPermissions);
  await writeOpenCodeConfigDocument(document.path, nextText, document.doc);
  return { path: document.path, changed: true };
}

app.get("/config", async (c) => {
  try {
    const target = await configServerTarget();
    const document = await readOpenCodeConfigDocument(target, { signal: c.req.raw.signal });
    // The response is a REDACTED projection; the file on disk keeps its real
    // values, and nothing here writes to it.
    const redacted = redactOpenCodeConfigDocument(document.doc);
    // Reads stay available; edits do not. `editable` is "a write is permitted
    // at all", not "the document parsed", so it is false for every runtime
    // whose writer would refuse — and the reason travels with it rather than
    // being discovered from a failed save.
    const writeDisabledReason = configWriteRefusalForRuntime();
    return c.json({
      path: document.path,
      discoveredPaths: document.discoveredPaths,
      raw: redactOpenCodeConfigText(document.raw),
      malformed: document.malformed,
      permissions: redacted.permissions ?? null,
      editable: !document.malformed && writeDisabledReason === null,
      writeDisabledReason,
    });
  } catch (err) {
    logger.error("opencode", "opencode.config_read_error", { ...classifyError(err) });
    if (err instanceof OpenCodeConfigUnreadableError) {
      return c.json({ error: err.message }, 422);
    }
    if (err instanceof OpenCodeConfigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    const mapped = openCodeError(err, "Failed to read OpenCode configuration");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/** Adds one rule to the END of the array, where it has the highest precedence. */
app.post("/config/permissions", async (c) => {
  const parsed = z
    .object({
      action: z.string().trim().min(1),
      resource: z.string().trim().min(1),
      effect: z.enum(["allow", "ask", "deny"]),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "action, resource and effect are required" }, 400);
  }
  const { action, resource, effect } = parsed.data;
  try {
    const result = await applyPermissionChange(
      (current) => appendOpenCodePermissionRule(current, { action, resource, effect }),
      c.req.raw.signal,
    );
    return c.json(result);
  } catch (err) {
    logger.error("opencode", "opencode.config_rule_add_error", {
      ...classifyError(err),
      action,
      resource,
      effect,
    });
    if (err instanceof OpenCodeConfigWriteDisabledError) {
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof OpenCodeConfigUnreadableError) {
      return c.json({ error: err.message }, 422);
    }
    if (err instanceof OpenCodeConfigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    const mapped = openCodeError(err, "Failed to add the rule");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/**
 * Removes one rule, addressed by the position AND identity the page read.
 *
 * The identity is re-checked against the file immediately before the removal,
 * so a rule that moved or changed since the page was rendered is refused rather
 * than deleted by position alone.
 */
app.delete("/config/permissions", async (c) => {
  const parsed = z
    .object({
      index: z.number().int().min(0),
      action: z.string().min(1),
      resource: z.string().min(1),
      effect: z.enum(["allow", "ask", "deny"]),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "index, action, resource and effect are required" }, 400);
  }
  const { index, action, resource, effect } = parsed.data;
  try {
    const result = await applyPermissionChange(
      (current) => removeOpenCodePermissionRule(current, index, { action, resource, effect }),
      c.req.raw.signal,
    );
    return c.json(result);
  } catch (err) {
    logger.error("opencode", "opencode.config_rule_remove_error", {
      ...classifyError(err),
      index,
      action,
      resource,
      effect,
    });
    if (err instanceof OpenCodeConfigWriteDisabledError) {
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof OpenCodeConfigUnreadableError) {
      return c.json({ error: err.message }, 422);
    }
    if (err instanceof OpenCodeConfigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    const mapped = openCodeError(err, "Failed to remove the rule");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

app.put("/config/permissions", async (c) => {
  const parsed = permissionEffectSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "action, resource and effect are required" }, 400);
  }
  const { action, resource, effect, index } = parsed.data;
  try {
    const result = await applyPermissionChange(
      (current) =>
        index === undefined
          ? setOpenCodePermissionEffect(current, { action, resource }, effect)
          : setOpenCodePermissionEffectAt(current, index, { action, resource }, effect),
      c.req.raw.signal,
    );
    return c.json(result);
  } catch (err) {
    logger.error("opencode", "opencode.config_write_error", {
      ...classifyError(err),
      action,
      resource,
      effect,
    });
    if (err instanceof OpenCodeConfigWriteDisabledError) {
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof OpenCodeConfigUnreadableError) {
      return c.json({ error: err.message }, 422);
    }
    if (err instanceof OpenCodeConfigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    const mapped = openCodeError(err, "Failed to write OpenCode configuration");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/**
 * The composer's command feed.
 *
 * OpenCode's command catalogue is **location-scoped upstream**, and the
 * proxy's allowlist deliberately carries only the routes the browser's
 * session client calls — so the catalogue is read here, by the backend, and
 * served from TBAi's own route. The payload is the server's own, verbatim.
 */
app.get("/commands", async (c) => {
  try {
    return c.json(await getOpenCodeCommandFeed());
  } catch (err) {
    logger.error("opencode", "opencode.commands_error", { ...classifyError(err) });
    const mapped = openCodeError(err, "Failed to load OpenCode commands");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/**
 * Which kind of OpenCode service backs Code mode (D1/H5), and what an adopted
 * one proved about itself (B7).
 *
 * This is a read of the installed target, never a probe: asking the browser
 * for status must not start a managed process or contact an adopted one. The
 * payload is deliberately small — the origin, the password, the registration
 * path and the probe bodies stay in the backend (§4.2).
 */
app.get("/status", (c) => c.json(describeOpenCodeRuntime()));

/**
 * Live capability discovery for the unified new-chat picker. Returns the agents
 * and models the ACTIVE OpenCode service exposes (managed or adopted, D1/H5).
 * Starts the managed server on first call when nothing is installed, and
 * queries its discovery endpoints. No input is accepted — discovery is
 * server-driven, so there is nothing to Zod-validate.
 */
app.get("/capabilities", async (c) => {
  try {
    const caps = await getOpenCodeCapabilities();
    return c.json(caps);
  } catch (err) {
    logger.error("opencode", "opencode.capabilities_error", { ...classifyError(err) });
    const mapped = openCodeError(err, "Failed to load OpenCode capabilities");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/**
 * Lists external OpenCode sessions available for import into TBAi.
 * Registered before the proxy catch-all below.
 */
app.get("/importable", async (c) => {
  const query = c.req.query("query");
  const limitParam = c.req.query("limit");
  const scanLimitParam = c.req.query("scanLimit");
  const cursor = c.req.query("cursor");
  const includeChildrenParam = c.req.query("includeChildren");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  const scanLimit = scanLimitParam ? Number.parseInt(scanLimitParam, 10) : undefined;
  const includeChildren =
    includeChildrenParam !== undefined ? includeChildrenParam !== "false" : undefined;

  try {
    const result = await listImportableOpenCodeSessions({
      query,
      limit: Number.isFinite(limit) ? limit : undefined,
      scanLimit: Number.isFinite(scanLimit) ? scanLimit : undefined,
      cursor: cursor?.trim() || undefined,
      includeChildren,
    });
    return c.json(result);
  } catch (err) {
    logger.error("opencode", "opencode.importable_error", { ...classifyError(err) });
    const mapped = openCodeError(err, "Failed to list importable OpenCode sessions");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/**
 * Imports an external OpenCode session into TBAi.
 * Accepts only { sessionId, sourceRef } in the body.
 * Registered before the proxy catch-all below.
 */
app.post("/import", async (c) => {
  const parseResult = z
    .object({
      sessionId: z.string().trim().min(1),
      sourceRef: z.string().trim().min(1),
    })
    .safeParse(await c.req.json().catch(() => ({})));

  if (!parseResult.success) {
    return c.json({ error: "sessionId and sourceRef are required" }, 400);
  }

  const { sessionId, sourceRef } = parseResult.data;

  try {
    const result = await importOpenCodeSession({ sessionId, sourceRef });
    return c.json(result, 201);
  } catch (err) {
    logger.error("opencode", "opencode.import_error", { ...classifyError(err), sessionId });

    if (err instanceof OpenCodeSessionAlreadyImportedError) {
      return c.json({ error: err.message, conversationId: err.conversationId }, 409);
    }
    if (err instanceof OpenCodeImportStaleSourceError) {
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof OpenCodeImportSessionEligibilityError) {
      return c.json({ error: err.message }, 422);
    }
    if (err instanceof OpenCodeImportedSessionMissingError) {
      return c.json({ error: err.message }, 404);
    }

    const mapped = openCodeError(err, "Failed to import OpenCode session");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/**
 * Same-origin reverse proxy to the managed OpenCode server (REST + SSE). The
 * assistant-ui OpenCode runtime talks to this path; we forward to the local
 * server, stripping the proxy prefix and preserving streaming responses.
 *
 * The catch-all below is the ONLY upstream-forwarding path in this module.
 * All OpenCode browser traffic (capabilities, session, prompt, SSE event
 * stream) flows through it. Temporary high-signal diagnostics instrument the
 * request/response/stream lifecycle so a single reproduction can localize the
 * "refresh to see the answer" failure (upstream header mismatch, proxy
 * transformation, SSE connect/delivery, runtime/UI consumption, or REST
 * history load). No bodies, prompts, tokens, or auth headers are logged.
 */
app.all("*", async (c) => {
  const startMs = Date.now();
  const requestId = getRequestContext()?.requestId;
  let target: Awaited<ReturnType<typeof resolveOpenCodeRuntimeTarget>>;
  try {
    target = await resolveOpenCodeRuntimeTarget();
  } catch (err) {
    logger.error("opencode", "opencode.proxy_unavailable", { ...classifyError(err) });
    const mapped = openCodeError(err, "OpenCode server unavailable");
    return c.json({ error: mapped.message }, mapped.status);
  }
  const baseUrl = target.baseUrl;
  const targetPath = stripOpenCodeProxyPrefix(c.req.path);
  const upstreamPath =
    targetPath === "/api" || targetPath.startsWith("/api/") ? targetPath : `/api${targetPath}`;

  const method = c.req.method;
  const reqHeaders = c.req.raw.headers;

  // A1 — THE ALLOWLIST. The proxy forwards only the routes the browser's
  // client actually calls. Everything else the managed server exposes (shell,
  // filesystem read/write, credentials, config writes, RPC, MCP, PTY, plugin
  // updates) is refused here, before any upstream request is made. The list
  // lives in `services/opencode/proxyRoutes.ts` and is checked against the
  // real client by two drift tests, so it cannot drift into a blocklist.
  const match = matchOpenCodeProxyRoute(method, upstreamPath);
  if (!match) {
    logger.warn("opencode", "proxy.route_refused", {
      requestId,
      method,
      pathname: upstreamPath,
    });
    return c.json({ error: "Unknown OpenCode route" }, 404);
  }

  // A2 — THE WORKSPACE SCOPE. The caller never chooses the directory. The
  // proxy resolves the session the request names (path for a session-scoped
  // route, `x-tbai-session` for the location-scoped event stream) through the
  // local database and forwards THAT directory.
  const historyOwner = historyOwnerFromTarget(target);
  const serviceOwner = historyOwner ? serializeHistoryOwner(historyOwner) : LOCAL_HISTORY_OWNER;

  let authorization: Awaited<ReturnType<typeof authorizeOpenCodeProxyRequest>>;
  try {
    authorization = await authorizeOpenCodeProxyRequest({
      route: match.route,
      parameters: match.parameters,
      sessionHeader: reqHeaders.get(OPENCODE_SESSION_HEADER),
      serviceOwner,
    });
  } catch (err) {
    if (err instanceof OpenCodeProxyRefusalError) {
      logger.warn("opencode", "proxy.authorization_refused", {
        requestId,
        method,
        pathname: upstreamPath,
        status: err.status,
        reason: err.message,
      });
      return c.json({ error: err.message }, err.status);
    }
    throw err;
  }

  const url = new URL(upstreamPath, baseUrl);
  url.search = new URL(c.req.url).search;
  // The managed server reads the location from `location[directory]` as well
  // as from the header, so a caller-supplied value is stripped from BOTH.
  url.searchParams.delete("location[directory]");

  const sessionId = url.searchParams.get("session") ?? undefined;
  const sseOriented = url.pathname.includes("/event");

  // A. request diagnostics (no auth/body/prompt logging)
  logger.debug("opencode", "proxy.request", {
    requestId,
    sessionId,
    ocSession: authorization.sessionId ?? undefined,
    method,
    pathname: url.pathname,
    sseOriented,
    accept: reqHeaders.get("accept") ?? undefined,
    acceptEncoding: reqHeaders.get("accept-encoding") ?? undefined,
    contentType: reqHeaders.get("content-type") ?? undefined,
    upstreamUrl: url.toString(),
    elapsedMs: Date.now() - startMs,
  });

  const headers = new Headers(reqHeaders);
  for (const hop of [
    "authorization",
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(hop);
  }
  // The caller's own scope inputs are removed before the server's are set:
  // the upstream must never see a directory the caller chose, nor the
  // TBAi-internal session header (which is a selector, not an instruction).
  headers.delete(OPENCODE_SESSION_HEADER);
  headers.delete(OPENCODE_DIRECTORY_HEADER);
  // The captured target's transport injects its own credential and refuses a
  // redirect. There is no branch that sets a credential header here: the proxy
  // always goes through the transport, so it cannot forward a caller's
  // Authorization or pair the target's credential with another origin.
  if (authorization.directory) {
    for (const [key, value] of Object.entries(
      getOpenCodeDirectoryHeaders(authorization.directory),
    )) {
      headers.set(key, value);
    }
  }

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = c.req.raw.body ?? undefined;
  }

  let upstream: Response;
  try {
    upstream = await target.transport(url, init);
  } catch (err) {
    if (err instanceof OpenCodeRedirectRefusedError) {
      // The refusal carries only the status; the Location header is never read,
      // so no redirect target can reach the browser.
      logger.warn("opencode", "proxy.redirect_refused", {
        requestId,
        method,
        pathname: url.pathname,
        status: err.status,
      });
      return c.json({ error: "OpenCode refused a redirect" }, 502);
    }
    logger.error("opencode", "proxy.upstream_fetch_failed", {
      requestId,
      ocSession: sessionId,
      method,
      pathname: url.pathname,
      errorType: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - startMs,
    });
    const mapped = openCodeError(err, "OpenCode upstream request failed");
    return c.json({ error: mapped.message }, mapped.status);
  }

  const upstreamHeaders = new Headers(upstream.headers);
  const contentType = upstreamHeaders.get("content-type") ?? "";
  const isSSE = contentType.includes("text/event-stream") || url.pathname.includes("/event");

  // B. upstream response diagnostics (original metadata, before stripping)
  logger.debug("opencode", "proxy.upstream_response", {
    requestId,
    sessionId,
    status: upstream.status,
    contentType,
    contentEncoding: upstreamHeaders.get("content-encoding") ?? null,
    contentLength: upstreamHeaders.get("content-length") ?? null,
    transferEncoding: upstreamHeaders.get("transfer-encoding") ?? null,
    connection: upstreamHeaders.get("connection") ?? null,
    keepAlive: upstreamHeaders.get("keep-alive") ?? null,
    hasBody: upstream.body != null,
    elapsedMs: Date.now() - startMs,
  });

  if (isSSE) {
    logger.debug("opencode", "sse.open", {
      requestId,
      ocSession: sessionId,
      status: upstream.status,
      contentType,
      contentEncoding: upstreamHeaders.get("content-encoding") ?? null,
      contentLength: upstreamHeaders.get("content-length") ?? null,
      timestamp: Date.now(),
    });
  }

  // Remove hop-by-hop headers and response metadata invalidated by Bun's
  // transparent response decompression. The forwarded body is plaintext, so
  // upstream Content-Encoding/Content-Length must not describe it.
  const responseHeaders = new Headers(upstreamHeaders);
  for (const hop of [
    "connection",
    "transfer-encoding",
    "keep-alive",
    "content-encoding",
    "content-length",
  ]) {
    responseHeaders.delete(hop);
  }

  // C. forward diagnostics — make the stale-metadata removal explicit
  const upstreamEncodingPresent = upstreamHeaders.has("content-encoding");
  const upstreamLengthPresent = upstreamHeaders.has("content-length");
  const forwardedEncodingPresent = responseHeaders.has("content-encoding");
  const forwardedLengthPresent = responseHeaders.has("content-length");
  logger.debug("opencode", "proxy.forward_response", {
    requestId,
    sessionId,
    status: upstream.status,
    contentType,
    forwardedContentEncoding: responseHeaders.get("content-encoding") ?? null,
    forwardedContentLength: responseHeaders.get("content-length") ?? null,
    transferEncoding: responseHeaders.get("transfer-encoding") ?? null,
    isSSE,
    elapsedMs: Date.now() - startMs,
    upstreamEncodingPresent,
    forwardedEncodingPresent,
    upstreamLengthPresent,
    forwardedLengthPresent,
  });

  const body = upstream.body
    ? observeBody(upstream.body, {
        isSSE,
        requestId,
        ocSession: sessionId,
        startMs,
        status: upstream.status,
      })
    : null;

  return new Response(body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});

/**
 * Observe a proxied response body stream without altering it: records SSE
 * first-byte / first-event / per-event (capped) signals and stream
 * close/error. For non-SSE responses it records completion. Never logs body
 * bytes, prompts, or payloads — only event type names and counts.
 */
function observeBody(
  body: ReadableStream<Uint8Array>,
  meta: {
    isSSE: boolean;
    requestId?: string;
    ocSession?: string;
    startMs: number;
    status: number;
  },
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let firstByteMs: number | null = null;
  let firstEvent = false;
  let eventCount = 0;
  let samplingStarted = false;
  let finished = false;

  const log = (event: string, fields: Record<string, unknown>) =>
    logger.debug("opencode", event, {
      requestId: meta.requestId,
      ocSession: meta.ocSession,
      ...fields,
    });

  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    if (meta.isSSE) {
      log("sse.close", {
        reason,
        totalDurationMs: Date.now() - meta.startMs,
        totalEvents: eventCount,
        firstByte: firstByteMs !== null,
        firstEvent,
      });
    } else {
      log("proxy.json_complete", {
        status: meta.status,
        elapsedMs: Date.now() - meta.startMs,
      });
    }
  };

  const parseEvents = (text: string) => {
    buffer += text;
    // Find each `\n\n` frame terminator, consume it, and re-scan: the buffer
    // shrinks as frames are taken, so the next terminator has to be located
    // again on each pass. Assigning outside the condition keeps the loop
    // condition a plain comparison (an assignment-in-condition is a classic
    // place for an off-by-one to hide).
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const type = extractEventType(raw);
      if (!firstEvent) {
        firstEvent = true;
        log("sse.first_event", {
          eventType: type,
          elapsedMs: Date.now() - meta.startMs,
        });
      }
      eventCount++;
      if (!samplingStarted) {
        if (eventCount <= 20) {
          log("sse.event", { eventIndex: eventCount, eventType: type });
        } else {
          samplingStarted = true;
          log("sse.event_sampling_started", { eventsObserved: eventCount });
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  };

  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish("stream-complete");
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }
        if (firstByteMs === null) {
          firstByteMs = Date.now() - meta.startMs;
          if (meta.isSSE) log("sse.first_byte", { elapsedMs: firstByteMs });
        }
        if (meta.isSSE && value) {
          parseEvents(decoder.decode(value, { stream: true }));
        }
        controller.enqueue(value);
      } catch (err) {
        if (finished) return;
        if (meta.isSSE) {
          log("sse.error", {
            errorType: err instanceof Error ? err.name : typeof err,
            message: err instanceof Error ? err.message : String(err),
            elapsedMs: Date.now() - meta.startMs,
            eventsObserved: eventCount,
            firstByte: firstByteMs !== null,
            firstEvent,
          });
        } else {
          log("proxy.stream_error", {
            errorType: err instanceof Error ? err.name : typeof err,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        finished = true;
        try {
          controller.error(err);
        } catch {
          /* already closed */
        }
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
      finish(typeof reason === "string" ? reason : "cancelled");
    },
  });
}

/** Extract only the SSE event type name (never the payload/data content). */
function extractEventType(raw: string): string {
  const lines = raw.split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("event:")) {
      const v = t.slice(6).trim();
      if (v) return v;
    }
  }
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("data:")) {
      const v = t.slice(5).trim();
      if (v) {
        try {
          const parsed = JSON.parse(v) as { type?: unknown };
          if (typeof parsed?.type === "string") return parsed.type;
        } catch {
          /* non-JSON data — fall through */
        }
      }
    }
  }
  return "message";
}

export default app;
