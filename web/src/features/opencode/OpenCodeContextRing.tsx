import { useAuiState } from "@assistant-ui/react";
import { useMemo } from "react";
import { useParams } from "react-router";
import {
  ContextDisplayRing as StandaloneRing,
  type TokenUsage,
} from "@/components/assistant-ui/elements/context-display";
import { resolveContextWindow } from "@/config/modelContext";
import { useOpenCodeRuntimeContext } from "./opencodeRuntimeContext";
import { useOpenCodeCapabilities } from "./useOpenCodeCapabilities";
import { resolveOpenCodeModel } from "./resolveOpenCodeModel";
import { useOpenCodeConversationConfig } from "./useOpenCodeConversationConfig";
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
 * `resetKey={sessionId}`. The window prefers the live `model.limit.context`
 * for the conversation's current model — resolved through the same
 * conversation-config + capabilities lookup the Model chip uses, so it never
 * depends on ambient runtime internals. Renders nothing until usage exists.
 */
export function OpenCodeContextRing() {
  const runtime = useOpenCodeRuntimeContext();
  const usage = useOpenCodeUsage();
  const { agentId } = useParams();
  const config = useOpenCodeConversationConfig(agentId);
  const { models } = useOpenCodeCapabilities(true);
  const resolved = resolveOpenCodeModel(config?.opencodeModel, models);
  const current = resolved
    ? models.find(
        (m) =>
          m.id === resolved.modelID && m.providerID === resolved.providerID,
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
