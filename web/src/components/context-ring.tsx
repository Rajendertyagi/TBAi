import { useAuiState } from "@assistant-ui/react";
import { ContextDisplayRing as DirectRuntimeRing } from "./assistant-ui/elements/context-display.aui";
import { resolveContextWindow } from "../config/modelContext";
import {
  buildModelGroups,
  resolveModelOwner,
} from "../lib/model-groups";
import { useSettingsStore } from "../stores";

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
  return (
    <DirectRuntimeRing
      modelContextWindow={resolveContextWindow({
        modelId: currentModelId,
        groups,
      })}
      side="top"
    />
  );
}
