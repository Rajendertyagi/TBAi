import { useCallback, useEffect, useMemo, useState } from "react";
import { createOpenCodeV2Client } from "./v2Client";
import { createV2ThreadController } from "./v2ThreadController";
import { useV2AssistantRuntime } from "./v2Runtime";
import { useOpenCodeAuxiliaryResync } from "./useOpenCodeAuxiliaryResync";
import {
  fetchOpenCodeSessionActivity,
  reconcileOpenCodeSessionDirectory,
} from "./sessionBootstrap";
import { getApiBaseUrl } from "../../lib/platform";

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: `clientEpoch` is a state counter that is never read in the body - it is the rebuild trigger. Incrementing it forces a fresh client (and therefore a fresh controller) when the transport has to be replaced even though the session id and directory are unchanged.
  const client = useMemo(
    () =>
      createOpenCodeV2Client(
        { sessionId: scopedSessionId, directory: eventDirectory ?? null },
        getApiBaseUrl() || window.location.origin,
      ),
    [eventDirectory, scopedSessionId, clientEpoch],
  );
  const controller = useMemo(
    () =>
      createV2ThreadController(
        client,
        undefined,
        conversationId
          ? {
              conversationId,
              fetchActivity: fetchOpenCodeSessionActivity,
              reconcileDirectory: ({ conversationId }) =>
                reconcileOpenCodeSessionDirectory(conversationId),
            }
          : undefined,
      ),
    [client, conversationId],
  );
  const runtime = useV2AssistantRuntime(controller, conversationId);

  useEffect(() => {
    // The runtime is loaded only once the session exists and its workspace
    // scope is resolved. Before bootstrap resolves there is no session id, and
    // without a resolved directory the proxy cannot authorize the event stream
    // (it would refuse with 403). Waiting is the honest behaviour; the client
    // is rebuilt when the session id or directory arrives.
    if (!sessionId || !eventDirectory) return;
    void controller.load().catch(() => undefined);
    return () => controller.dispose();
  }, [controller, sessionId, eventDirectory]);

  useOpenCodeAuxiliaryResync(controller);

  const reconnect = useCallback(() => {
    setClientEpoch((epoch) => epoch + 1);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    if (defaultModel || defaultAgent) {
      controller.setDesiredSelection({
        model: defaultModel
          ? {
              providerID: defaultModel.providerID,
              modelID: defaultModel.modelID,
              ...(defaultModel.variant ? { variant: defaultModel.variant } : {}),
            }
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
