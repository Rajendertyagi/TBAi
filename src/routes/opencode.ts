import { Hono } from "hono";
import { z } from "zod";
import {
  EngineMismatchError,
  ensureOpenCodeSession,
  terminateOpenCodeSession,
} from "../services/opencode/sessions";
import { getOpenCodeCapabilities } from "../services/opencode/capabilities";
import { OpenCodeBinaryMissingError, openCodeServerManager, stripOpenCodeProxyPrefix } from "../services/opencode/serverManager";
import { getOpenCodeAuthHeaders } from "../services/opencode/runtime";
import { logger, getRequestContext } from "../lib/logger";
import { classifyError } from "../lib/errors";

const sessionRequestSchema = z.object({
  conversationId: z.string().min(1),
});

const app = new Hono();

/**
 * Maps OpenCode failures to a message + status. A missing CLI binary is a 503
 * with an actionable message (the user can install it); a wrong-engine caller
 * is a 422 (the row, not the server, is at fault); everything else is a
 * generic 500 so internals never leak to the browser.
 */
function openCodeError(
  err: unknown,
  fallback: string,
): { message: string; status: 503 | 422 | 500 } {
  if (err instanceof OpenCodeBinaryMissingError) {
    return { message: err.message, status: 503 };
  }
  if (err instanceof EngineMismatchError) {
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
    const { sessionId, directory } = await ensureOpenCodeSession(
      parsed.data.conversationId,
    );
    return c.json({ sessionId, directory });
  } catch (err) {
    logger.error("opencode", "opencode.session_error", { ...classifyError(err) });
    const mapped = openCodeError(err, "Failed to start OpenCode session");
    return c.json({ error: mapped.message }, mapped.status);
  }
});

/**
 * Session termination for conversation teardown. Best-effort by contract (see
 * `terminateOpenCodeSession`): aborts live work, deletes the server-side
 * session, clears the persisted pointer. Missing conversation/session/server
 * surfaces as `{ terminated: false }`, never an error, so the deletion
 * coordinator can call it unconditionally. Registered before the proxy
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
 * Live capability discovery for the unified new-chat picker. Returns the agents
 * and models the managed OpenCode server exposes. Starts the server on first
 * call (via the server manager) and queries its discovery endpoints. No input is
 * accepted — discovery is server-driven, so there is nothing to Zod-validate.
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
  let baseUrl: string;
  try {
    baseUrl = await openCodeServerManager.ensureBaseUrl();
  } catch (err) {
    logger.error("opencode", "opencode.proxy_unavailable", { ...classifyError(err) });
    const mapped = openCodeError(err, "OpenCode server unavailable");
    return c.json({ error: mapped.message }, mapped.status);
  }
  const targetPath = stripOpenCodeProxyPrefix(c.req.path);
  const upstreamPath = targetPath === "/api" || targetPath.startsWith("/api/")
    ? targetPath
    : `/api${targetPath}`;
  const url = new URL(upstreamPath, baseUrl);
  url.search = new URL(c.req.url).search;

  const method = c.req.method;
  const reqHeaders = c.req.raw.headers;
  const sessionId = url.searchParams.get("session") ?? undefined;
  const sseOriented = url.pathname.includes("/event");

  // A. request diagnostics (no auth/body/prompt logging)
  logger.debug("opencode", "proxy.request", {
    requestId,
    sessionId,
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
  for (const [key, value] of Object.entries(getOpenCodeAuthHeaders())) {
    headers.set(key, value);
  }

  const init: RequestInit = { method, headers, redirect: "manual" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = c.req.raw.body ?? undefined;
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (err) {
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
  const isSSE =
    contentType.includes("text/event-stream") || url.pathname.includes("/event");

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
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
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
    }
  };

  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish("stream-complete");
          try { controller.close(); } catch { /* already closed */ }
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
        try { controller.error(err); } catch { /* already closed */ }
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
