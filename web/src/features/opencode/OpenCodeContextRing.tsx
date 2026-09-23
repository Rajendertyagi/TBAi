import { useAuiState } from "@assistant-ui/react";
import { useMemo } from "react";
import {
  ContextDisplayRing as StandaloneRing,
  type TokenUsage,
} from "@/components/assistant-ui/elements/context-display";
import { resolveContextWindow } from "@/config/modelContext";
import { useOpenCodeRuntimeContext } from "./opencodeRuntimeContext";
import { useOpenCodeCapabilities } from "./useOpenCodeCapabilities";
import { selectOpenCodeRawTokens, toTokenUsage } from "./contextTokens";

/** Newest assistant message carrying OpenCode `tokens`, if any. */
function useOpenCodeUsage(): TokenUsage | undefined {
  // Store selection (stable reference) and presentation mapping (memoized)
  // are deliberately separate: the selector must never allocate, or the
  // external-store snapshot changes every render (React #185 loop).
  const raw = useAuiState(selectOpenCodeRawTokens);
  return useMemo(() => toTokenUsage(raw), [raw]);
}

/**
 * OpenCode context ring for the composer rail.
 *
 * Standalone preset driven by the already-projected message tokens
 * (`metadata.custom.tokens`, preserved by the adapter — no second store):
 * newest token-bearing assistant message wins. Resets on session change via
 * `resetKey={sessionId}`; the window prefers the live `model.limit.context`
 * for the session's current model. Renders nothing until usage exists.
 */
export function OpenCodeContextRing() {
  const runtime = useOpenCodeRuntimeContext();
  const usage = useOpenCodeUsage();
  const { models } = useOpenCodeCapabilities(true);
  const current =
    runtime?.providerID && runtime?.modelID
      ? models.find(
          (m) =>
            m.id === runtime.modelID &&
            (!runtime.providerID || m.providerID === runtime.providerID),
        )
      : undefined;
  return (
    <StandaloneRing
      modelContextWindow={resolveContextWindow({
        limitContext: current?.limit?.context,
      })}
      usage={usage}
      resetKey={runtime?.sessionId}
      side="top"
    />
  );
}
