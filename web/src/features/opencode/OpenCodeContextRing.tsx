import { useMemo } from "react";
import { ContextDisplayRing as StandaloneRing } from "@/components/assistant-ui/elements/context-display";
import { resolveContextWindow } from "@/config/modelContext";
import { useOpenCodeCapabilities } from "./useOpenCodeCapabilities";
import { toTokenUsage } from "./contextTokens";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

/** Context ring backed by the native OpenCode V2 thread state. */
export function OpenCodeContextRing() {
  const extras = useOptionalV2RuntimeExtras();
  const { models } = useOpenCodeCapabilities(true);
  const usage = useMemo(
    () => toTokenUsage(extras?.state.usage?.tokens),
    [extras?.state.usage?.tokens],
  );
  if (!extras) return null;
  const current = extras.model
    ? models.find(
        (model) =>
          model.id === extras.model?.modelID &&
          model.providerID === extras.model?.providerID,
      )
    : undefined;
  return (
    <StandaloneRing
      modelContextWindow={resolveContextWindow({
        limitContext: current?.limit?.context,
      })}
      usage={usage}
      resetKey={extras.sessionId}
      side="top"
    />
  );
}
