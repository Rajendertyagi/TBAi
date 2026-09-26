"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router";
import { RefreshCw } from "lucide-react";
import { AssistantRuntimeProvider, AuiConfig, Tools } from "@assistant-ui/react";
import { DevToolsModal } from "@assistant-ui/react-devtools";
import { ChatWindow } from "@/components/ChatWindow";
import { ThreadBootSkeleton } from "@/components/assistant-ui/elements/thread-boot-skeleton";
import { appToolkit } from "@/tools/toolkit";
import { useConversationTab } from "@/features/chat/state/useConversationTab";
import { OPENCODE_INIT_TIMEOUT_MS } from "@/config/opencode";
import { useOpenCodeRuntime } from "./useOpenCodeRuntime";
import { useAvailabilityStore } from "../availability/availabilityStore";
import { useOpenCodeCapabilities } from "./useOpenCodeCapabilities";
import { useOpenCodeConversationConfig } from "./useOpenCodeConversationConfig";
import { useResolvedOpenCodeModel } from "./resolveOpenCodeModel";
import { hydrateAutoPolicy } from "./sessionAutoPolicy";
import { shouldReconnectForEpoch } from "./recoveryEpoch";
import { OpenCodeRuntimeContext } from "./opencodeRuntimeContext";
import { FirstPromptHandoff } from "./FirstPromptHandoff";
import {
  bootstrapOpenCodeSession,
  invalidateBootstrap,
} from "./sessionBootstrap";
import { OpenCodeIsolationBoundary } from "./OpenCodeIsolationBoundary";
import { OpenCodeStatus } from "./OpenCodeStatus";
import { OpenCodePermissions } from "./OpenCodePermissions";
import { OpenCodeQuestions } from "./OpenCodeQuestions";
import { OpenCodeSessionRow } from "./OpenCodeSessionRow";
import { OpenCodeTodoTracker } from "./OpenCodeTodoTracker";

/**
 * Code-mode surface. Renders the shared ChatWindow with mode="agent" inside a
 * nested OpenCode runtime provider (own context, separate from the chat runtime).
 * The conversation id comes from the route param; the OpenCode session is
 * created/resumed via the backend seam and the tab is registered on open.
 */
export function OpenCodeView() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  // The session's directory scope, delivered by the same backend call that
  // mints `sessionId`. It is what makes the runtime's event subscription reach
  // the real session stream instead of OpenCode's unscoped `/event` stub —
  // without it a finished reply only appears after a history reload. Kept
  // beside the id so the two are always set together and never used apart.
  const [eventDirectory, setEventDirectory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Init attempt counter: bumping it re-runs the session fetch (a single,
  // idempotent "start one server / resume one session" call — never a poll).
  const [attempt, setAttempt] = useState(0);
  // Bounded: if session init takes longer than the config window, surface a
  // retry affordance instead of leaving "Starting OpenCode…" stuck forever.
  const [timedOut, setTimedOut] = useState(false);

  // Shared route→tab binding with existence validation: a deleted agent
  // conversation closes its tabs and falls back to a draft instead of
  // mounting a stale view. No-op while no conversation is routed.
  useConversationTab(agentId, "agent");

  // Prompt-level defaults: the runtime attaches the conversation's persisted
  // agent/model to every new turn, so a session never depends on the OpenCode
  // server's implicit default. Both come from the live config + capabilities
  // (never the Direct-chat provider state).
  const config = useOpenCodeConversationConfig(agentId);
  const { models } = useOpenCodeCapabilities();
  const defaultModel = useResolvedOpenCodeModel(config?.opencodeModel ?? null, models);
  const defaultAgent = config?.opencodeAgent ?? undefined;
  const defaultModelWithVariant = defaultModel
    ? { ...defaultModel, ...(config?.opencodeVariant ? { variant: config.opencodeVariant } : {}) }
    : undefined;

  const retry = useCallback(() => {
    setError(null);
    setTimedOut(false);
    if (agentId) {
      invalidateBootstrap(agentId);
    }
    setAttempt((n) => n + 1);
  }, [agentId]);

  useEffect(() => {
    if (!agentId || !agentId.trim()) {
      // No auto-created conversation: Code mode shares the welcome draft
      // with normal chat (engine picker). The first send with the OpenCode
      // engine mints the conversation and routes here, so visiting /code
      // alone must never leave phantom rows behind.
      navigate("/chat/new", { replace: true });
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onTimeout = () => {
      if (!cancelled && !sessionId) {
        setTimedOut(true);
      }
    };
    // A timed-out retry re-attempts after the fetch resolves so the in-flight
    // call is not orphaned; clear it on any resolution.
    timer = setTimeout(onTimeout, OPENCODE_INIT_TIMEOUT_MS);

    bootstrapOpenCodeSession(agentId)
      .then((data) => {
        if (cancelled) return;
        setTimedOut(false);
        // Both are set in one update, so the runtime — which only mounts once
        // `sessionId` exists — always builds its event subscription from a
        // client that already carries the scope.
        setEventDirectory(data.directory);
        setSessionId(data.sessionId);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTimedOut(false);
        setError(e instanceof Error ? e.message : "Could not start OpenCode session");
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, navigate, attempt]);

  if (error || timedOut) {
    return (
      <div className="flex flex-col items-center gap-3 p-6 text-sm">
        <span className="text-destructive">
          {error ?? "OpenCode session did not start in time"}
        </span>
        <button
          type="button"
          onClick={retry}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-foreground transition-colors hover:bg-accent/50"
        >
          <RefreshCw className="size-3.5" />
          Retry
        </button>
      </div>
    );
  }
  if (!sessionId) {
    // Session not yet resolved: show the message-shaped boot skeleton inside
    // the normal content surface (the AppShell chrome stays visible). This is
    // a loading surface, not fake readiness — the existing session
    // creation/resume flow continues unchanged and the runtime mounts once
    // `sessionId` exists.
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto px-4 py-6 pb-4">
        <ThreadBootSkeleton />
      </div>
    );
  }

  // Runtime is created only once a valid session id exists, so initialSessionId
  // is never stale (the hook reads it on first mount).
  return (
    <AgentRuntime
      sessionId={sessionId}
      eventDirectory={eventDirectory}
      defaultModel={defaultModelWithVariant}
      defaultAgent={defaultAgent}
      conversationId={agentId}
    />
  );
}

function AgentRuntime({
  sessionId,
  eventDirectory,
  defaultModel,
  defaultAgent,
  conversationId,
}: {
  sessionId: string;
  eventDirectory: string | null;
  defaultModel?: { providerID: string; modelID: string; variant?: string };
  defaultAgent?: string;
  /** The TBAi conversation this session belongs to — the Auto shield's owner. */
  conversationId?: string;
}) {
  // The conversation's persisted OpenCode config, read through the existing
  // path. `opencodeAutoApprove` on it is the Auto shield's single source of
  // truth — no store, no context, no global.
  const conversationConfig = useOpenCodeConversationConfig(conversationId);

  const { runtime, reconnect, reconcileAutoApprove, controller } = useOpenCodeRuntime(
    sessionId,
    conversationId ?? null,
    defaultModel,
    defaultAgent,
    eventDirectory,
  );

  // Global backend recovery triggers the existing native controller rebuild
  // and state reconciliation. Mount-time reconnect is deliberately skipped:
  // the controller was just created, so replacing it while the first thread
  // switch or append is pending can invalidate that operation. A stale
  // non-zero epoch must not reconnect; only an epoch change while mounted
  // represents a genuine recovery.
  const recoveryEpoch = useAvailabilityStore((s) => s.recoveryEpoch);
  const seenRecoveryEpochRef = useRef(recoveryEpoch);
  useEffect(() => {
    const decision = shouldReconnectForEpoch({
      sessionId,
      recoveryEpoch,
      seenRecoveryEpoch: seenRecoveryEpochRef.current,
    });
    seenRecoveryEpochRef.current = decision.seenRecoveryEpoch;
    if (decision.reconnect) reconnect();
  }, [recoveryEpoch, sessionId, reconnect]);

  // Hydrate the runtime policy cache the moment the authoritative config is
  // known. The cache is keyed by the OpenCode sessionId (the identity the
  // event-time read has), so this is the one place that holds both the session
  // id and the conversation config. When Auto is on, reconcile any request that
  // was already pending before the config arrived — the same responder the
  // toggle write path uses, so a late config can never leave a request stuck.
  useEffect(() => {
    if (!sessionId || !conversationConfig) return;
    hydrateAutoPolicy(sessionId, conversationConfig.opencodeAutoApprove);
    if (conversationConfig.opencodeAutoApprove) {
      void reconcileAutoApprove?.().catch(() => undefined);
    }
  }, [sessionId, conversationConfig, reconcileAutoApprove]);

  // First-prompt handoff lives in <FirstPromptHandoff/>. It fires the stashed
  // draft prompt exactly once, and only after the native runtime's main thread
  // is bound to this session id. Claim-guarded, so remounts and reconnects can
  // never refire it: the claim persists before the append, and the stash clears
  // after the runtime accepts the prompt. Async failures unclaim for an explicit
  // retry and surface in-thread; the prompt is never auto-replayed.

  // Code mode needs its OWN tool-renderer registration.
  //
  // `AuiConfig` is scoped to the provider it is passed to, and this view mounts
  // its own `AssistantRuntimeProvider` (the runtime is the OpenCode one, not
  // the chat one). Without this, the registry read by `part.toolUI`
  // (`s.tools.toolUIs`) is empty here, so EVERY tool part fell through to the
  // generic `ToolFallback` — which is why Code mode never showed a rich tool
  // UI at all, no matter how the toolkit was populated.
  //
  // Safe to reuse the same resource: `Tools` also registers its entries with
  // model context, but the OpenCode runtime never reads model context (it
  // builds prompts server-side from OpenCode's own tool list), so that half is
  // inert here. Only the renderer half takes effect.
  const config = useMemo(
    () => AuiConfig({ tools: Tools({ toolkit: appToolkit }) }),
    [],
  );

  // The composer's session-dependent seams read from here (the Shield chip's
  // reconcile path, and the built-in `/compact` action's session/directory/
  // model). Memoized so the provider value is stable for the life of the
  // client; a reconnect rebuilds the client and updates it.
  const runtimeContext = useMemo(
    () => ({
      sessionId,
      reconcileAutoApprove,
      directory: eventDirectory,
      compact: controller.compact,
      setDesiredSelection: controller.setDesiredSelection,
      reconcileStagedRevert: controller.reconcileStagedRevert,
      ...(defaultModel
        ? { providerID: defaultModel.providerID, modelID: defaultModel.modelID, ...(defaultModel.variant ? { variant: defaultModel.variant } : {}) }
        : {}),
    }),
    [sessionId, reconcileAutoApprove, eventDirectory, defaultModel, controller],
  );

  return (
    <OpenCodeIsolationBoundary>
      <OpenCodeRuntimeContext.Provider value={runtimeContext}>
        <AssistantRuntimeProvider runtime={runtime} config={config}>
          <FirstPromptHandoff
            conversationId={conversationId}
            sessionId={sessionId}
            runtime={runtime}
            sendWithId={controller.sendMessage}
          />
          <div className="flex h-full min-h-0 flex-col">
            <OpenCodeSessionRow />
            <OpenCodePermissions />
            <OpenCodeQuestions />
            <OpenCodeTodoTracker sessionId={sessionId} />
            <div className="min-h-0 flex-1">
              <ChatWindow
                mode="agent"
                belowComposerExtra={
                  <OpenCodeStatus compact onReconnect={reconnect} />
                }
              />
            </div>
          </div>
          <DevToolsModal />
        </AssistantRuntimeProvider>
      </OpenCodeRuntimeContext.Provider>
    </OpenCodeIsolationBoundary>
  );
}
