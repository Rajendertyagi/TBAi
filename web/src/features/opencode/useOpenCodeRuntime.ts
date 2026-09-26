import { useCallback, useEffect, useMemo, useState } from "react";
import { createOpenCodeV2Client } from "./v2Client";
import { createV2ThreadController } from "./v2ThreadController";
import { useV2AssistantRuntime } from "./v2Runtime";

/** Builds the native OpenCode V2 runtime for one bootstrapped session. */
export function useOpenCodeRuntime(
  sessionId: string | undefined,
  conversationId: string | null,
  defaultModel?: { providerID: string; modelID: string; variant?: string },
  defaultAgent?: string,
  eventDirectory?: string | null,
) {
  const [clientEpoch, setClientEpoch] = useState(0);
  const scopedSessionId = sessionId ?? "";
  const client = useMemo(
    () => createOpenCodeV2Client(
      { sessionId: scopedSessionId, directory: eventDirectory ?? null },
      window.location.origin,
    ),
    [eventDirectory, scopedSessionId, clientEpoch],
  );
  const controller = useMemo(() => createV2ThreadController(client), [client]);
  const runtime = useV2AssistantRuntime(controller, conversationId);

  useEffect(() => {
    void controller.load().catch(() => undefined);
    return () => controller.dispose();
  }, [controller]);

  const reconnect = useCallback(() => {
    setClientEpoch((epoch) => epoch + 1);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    if (defaultModel || defaultAgent) {
      controller.setDesiredSelection({
        model: defaultModel
          ? { providerID: defaultModel.providerID, modelID: defaultModel.modelID, ...(defaultModel.variant ? { variant: defaultModel.variant } : {}) }
          : null,
        agent: defaultAgent ?? null,
      });
    }
  }, [controller, defaultAgent, defaultModel, sessionId]);

  return {
    runtime,
    reconnect,
    reconcileAutoApprove: controller.reconcileAutoApprove,
    controller,
  };
}
