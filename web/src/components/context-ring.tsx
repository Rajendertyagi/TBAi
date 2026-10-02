import { useAuiState } from "@assistant-ui/react";
import { ContextDisplayRing as DirectRuntimeRing } from "./assistant-ui/elements/context-display.aui";
import { resolveContextWindow } from "../config/modelContext";
import {
  buildModelGroups,
  resolveModelOwner,
} from "../lib/model-groups";
import { useSettingsStore } from "../stores";
import { useCurrentContext } from "../features/chat/context/useCurrentContext";

interface ConversationCustom {
  providerId?: string;
  modelId?: string;
  reasoningLevel?: string;
}

/**
 * Direct-chat context ring for the composer rail.
 *
 * Runtime preset: usage + thread reset come from the thread itself
 * (`useThreadTokenUsage`, fed by the route's `messageMetadata.usage`). The
 * window uses the same effective model as `ModelChip` (one-shot picker
 * override → conversation default → provider default) resolved against the
 * same provider groups, so the denominator always names the model that will
 * run — configured per-model window where present, documented default
 * otherwise. Renders nothing until usage exists — no placeholder, no estimate.
 */
export function DirectContextRing() {
  const { providers, activeProviderId, selectedProviderId, selectedModelId } =
    useSettingsStore();
  const custom = useAuiState((s) => s.threadListItem.custom) as
    | ConversationCustom
    | undefined;
  const groups = buildModelGroups(providers, activeProviderId);
  let currentProviderId =
    selectedProviderId ?? custom?.providerId ?? activeProviderId;
  let currentModelId: string | undefined;
  if (selectedModelId) {
    const owner = resolveModelOwner(groups, selectedModelId);
    if (owner) {
      currentProviderId = owner.providerId;
      currentModelId = owner.modelId;
    }
  }
  currentModelId ??= custom?.modelId ?? undefined;
  currentModelId ??=
    providers.find((p) => p.id === currentProviderId)?.model ?? undefined;
  // The SERVER's current-context measurement is the numerator, and the server's
  // effective window is the denominator, so the meter and the budget can never
  // disagree. Before the first turn reports one, the ring keeps the previous
  // behaviour (nothing rendered) rather than inventing a number.
  const serverContext = useCurrentContext();
  return (
    <DirectRuntimeRing
      modelContextWindow={
        serverContext?.windowTokens ??
        resolveContextWindow({
          modelId: currentModelId,
          groups,
        })
      }
      contextTokens={serverContext?.usedTokens}
      windowSource={serverContext?.windowSource}
      side="top"
    />
  );
}
