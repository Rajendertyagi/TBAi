import { useCallback, useEffect, useMemo, useState } from "react";
import { useOpenCodeRuntime as useOpenCodeRuntimeBase } from "@assistant-ui/react-opencode";
import { OPENCODE_PROXY_BASE_URL } from "@/config/opencode";
import { logger } from "@/lib/logger";
import { createOpenCodeRuntimeClient } from "./runtimeClient";
import { openCodeTodoStore } from "./todoState";

/**
 * Builds the OpenCode assistant-ui runtime pointed at the TBAi proxy. The
 * session is resumed via `initialSessionId` (created server-side per
 * conversation). `defaultModel` / `defaultAgent`, when provided, are attached to
 * every new prompt turn so a session never relies on the OpenCode server's
 * implicit default model.
 *
 * `eventDirectory` is the directory scope of the session, returned by the same
 * backend call that mints `sessionId`. It reaches the runtime as a scoped
 * client, so the runtime's single event subscription receives the real session
 * stream instead of OpenCode's unscoped `/event` stub — see `./eventScope` for
 * the measurement. The id and its scope therefore always arrive together and
 * can never be used apart.
 *
 * `sessionId` also reaches the client, because the frozen V1 adapter replies to
 * permissions on the legacy global route, which this OpenCode build does not
 * populate; `./permissionCompat` re-points those two calls at the V2
 * session-scoped routes using this id. See `./runtimeClient` for the single
 * construction point that applies both patches.
 *
 * Reconnect: bumping `clientEpoch` rebuilds the client with the SAME
 * `sessionId` + directory, so the adapter's registry (and with it the single
 * event subscription) is torn down via its existing dispose path and rebuilt
 * from scratch — a genuine fresh subscription, then the normal hydration +
 * reconcile path. Nothing is re-created per render (the comment below still
 * holds); only an explicit `reconnect()` call or a session/directory change
 * rebuilds the client.
 *
 * @param sessionId - OpenCode session id to resume; undefined only during load.
 * @param defaultModel - Explicit prompt-level model (`{ providerID, modelID }`).
 * @param defaultAgent - Explicit prompt-level agent id.
 * @param eventDirectory - Directory the session's event stream is scoped to.
 * @returns The runtime plus `reconnect`, which re-establishes the event
 *   connection for the same session. Rebuilds are serialized by React state
 *   updates and each disposes its predecessor, so exactly one subscription
 *   is ever active.
 */
export function useOpenCodeRuntime(
  sessionId: string | undefined,
  defaultModel?: { providerID: string; modelID: string },
  defaultAgent?: string,
  eventDirectory?: string | null,
) {
  const [clientEpoch, setClientEpoch] = useState(0);
  // Memoized on the values the client is built from, plus the reconnect
  // epoch. The runtime keys its whole controller registry — and with it the
  // single event subscription — on client identity, so a fresh client per
  // render would tear that subscription down and rebuild it continuously,
  // which is precisely the class of churn this fix must not add. Session
  // inputs are stable for the life of a session (the id is minted once,
  // before this hook mounts), so the client is built once and re-created
  // only by an explicit reconnect or a session/directory change.
  const client = useMemo(
    () =>
      createOpenCodeRuntimeClient(OPENCODE_PROXY_BASE_URL, {
        directory: eventDirectory ?? null,
        sessionId,
      }),
    [eventDirectory, sessionId, clientEpoch],
  );

  /**
   * Re-establish the event connection for the current session: the next
   * render builds a fresh client, the adapter disposes the old registry
   * (single subscription invariant) and subscribes anew, then hydration +
   * reconcile restore session state through the normal path. Session id and
   * directory are preserved — no new session, no workspace change.
   */
  const reconnect = useCallback(() => {
    setClientEpoch((n) => n + 1);
  }, []);

  const runtime = useOpenCodeRuntimeBase({
    client,
    initialSessionId: sessionId,
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultAgent ? { defaultAgent } : {}),
  });

  // D. runtime event-subscription / message-update diagnostics. Observes the
  // assistant-ui thread (the narrowest observable boundary short of the
  // library-internal event source) so we can tell whether streamed events
  // reached the UI. Does not log message text, parts, or any payload.
  useEffect(() => {
    if (!sessionId) return;
    openCodeTodoStore.attachSession(sessionId);
    logger.debug("opencode", "runtime.event_subscribe_start", { ocSession: sessionId });

    let prevCount = -1;
    let prevAssistantStatus = "";
    let unsubscribe: (() => void) | undefined;
    try {
      const thread = runtime.thread;
      unsubscribe = thread.subscribe(() => {
        const state = thread.getState() as unknown as {
          messages?: ReadonlyArray<{ role?: string; status?: string; content?: unknown }>;
        };
        const messages = state?.messages ?? [];
        const count = messages.length;
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.role === "assistant");
        const assistantStatus = lastAssistant?.status ?? "";
        const assistantTextLen = lastAssistant
          ? sumTextLength(lastAssistant.content)
          : 0;
        if (count !== prevCount || assistantStatus !== prevAssistantStatus) {
          logger.debug("opencode", "runtime.message_update", {
            ocSession: sessionId,
            messageCount: count,
            assistantPresent: lastAssistant != null,
            assistantStatus,
            assistantTextLen,
            assistantCreated: count > prevCount,
          });
          prevCount = count;
          prevAssistantStatus = assistantStatus;
        }
      });
    } catch (err) {
      logger.debug("opencode", "runtime.event_apply_error", {
        sessionId,
        errorType: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return () => {
      unsubscribe?.();
      openCodeTodoStore.clearSession(sessionId);
    };
  }, [runtime, sessionId]);

  return { runtime, reconnect };
}

/** Defensive text-length sum over assistant-ui message content parts. */
function sumTextLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content as Array<Record<string, unknown>>) {
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      total += part.text.length;
    }
  }
  return total;
}
