"use client";

/**
 * DEV-ONLY POC — minimal OpenCode content host for the Dockview lab.
 * Reuses the real bootstrap + runtime + isolation primitives, without the
 * route binding / config / permissions / first-prompt handoff of OpenCodeView.
 * Not production code; compiled out of production builds with the lab route.
 */
import { useEffect, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";

import { bootstrapOpenCodeSession } from "../opencode/sessionBootstrap";
import { useOpenCodeRuntime } from "../opencode/useOpenCodeRuntime";
import { OpenCodeIsolationBoundary } from "../opencode/OpenCodeIsolationBoundary";
import { ChatWindow } from "../../components/ChatWindow";

export function DockviewOpenCodeHost({ conversationId }: { conversationId: string }) {
  const [session, setSession] = useState<{
    sessionId: string;
    directory: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    bootstrapOpenCodeSession(conversationId)
      .then((result) => {
        if (cancelled) return;
        setSession({ sessionId: result.sessionId, directory: result.directory });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "bootstrap failed");
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  if (error) return <div className="p-2 text-xs text-destructive">{error}</div>;
  if (!session) return <div className="p-2 text-xs text-muted-foreground">Starting session…</div>;

  return <OpenCodeInner conversationId={conversationId} {...session} />;
}

function OpenCodeInner({
  conversationId,
  sessionId,
  directory,
}: {
  conversationId: string;
  sessionId: string;
  directory: string | null;
}) {
  const { runtime } = useOpenCodeRuntime(
    sessionId,
    conversationId,
    undefined,
    undefined,
    directory,
  );
  return (
    <OpenCodeIsolationBoundary>
      <AssistantRuntimeProvider runtime={runtime}>
        <ChatWindow mode="agent" />
      </AssistantRuntimeProvider>
    </OpenCodeIsolationBoundary>
  );
}
