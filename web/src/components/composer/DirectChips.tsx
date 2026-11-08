"use client";

import { useState } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { Bot, Brain, Check, ChevronDown } from "lucide-react";
import { composerConfig } from "../../config/composer";
import { useSettingsStore } from "@/features/providers/state/providersStore";
import type { ReasoningLevel } from "../../types";
import { ModelOptionList } from "../chat/ModelOptionList";
import { buildModelGroups, resolveModelOwner } from "../../lib/model-groups";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";

/**
 * The four levels, `Off` included.
 *
 * `Off` is a level, not a "default" placeholder: with it selected the provider
 * receives no thinking option and no reasoning part can come back. Naming the
 * off state honestly is what lets a reader tell thinking is disabled.
 */
export const THINKING_OPTIONS: ReadonlyArray<{ id: ReasoningLevel; label: string }> = [
  { id: "off", label: composerConfig.copy.thinkingOff },
  { id: "low", label: composerConfig.copy.thinkingLow },
  { id: "medium", label: composerConfig.copy.thinkingMedium },
  { id: "high", label: composerConfig.copy.thinkingHigh },
];

export type ConversationCustom = {
  providerId?: string | null;
  modelId?: string | null;
  reasoningLevel?: ReasoningLevel | null;
  engine?: "direct" | "opencode";
};

export function ModelChip() {
  const { providers, activeProviderId, selectedProviderId, selectedModelId, selectChatTarget } =
    useSettingsStore();
  const aui = useAui();
  const custom = useAuiState((s) => s.threadListItem.custom) as ConversationCustom | undefined;
  const [open, setOpen] = useState(false);

  // Every provider's models, grouped under its name (single source in
  // lib/model-groups — the picker list consumes the same groups).
  const groups = buildModelGroups(providers, activeProviderId);

  // Effective selection: one-shot picker override wins, else the conversation
  // default (custom), else the global active provider's model.
  let currentProviderId = selectedProviderId ?? custom?.providerId ?? activeProviderId;
  let currentModelId: string | undefined;
  if (selectedModelId) {
    const owner = resolveModelOwner(groups, selectedModelId);
    if (owner) {
      currentProviderId = owner.providerId;
      currentModelId = owner.modelId;
    }
  }
  currentModelId ??= custom?.modelId ?? undefined;
  const currentProvider = providers.find((p) => p.id === currentProviderId);
  currentModelId ??= currentProvider?.model ?? "";
  const currentModel =
    groups.flatMap((g) => g.models).find((m) => m.id === currentModelId) ?? undefined;
  const label = currentModel?.label ?? currentModelId ?? composerConfig.copy.selectModel;

  const handleSelect = (providerId: string, modelId: string) => {
    // Set the one-shot override for the NEXT message, AND persist it as this
    // conversation's default (SQLite source of truth) so it survives reloads
    // and is the baseline for subsequent messages. On a draft there is no
    // server row yet: the one-shot plus the initialize() carry own the pick,
    // so skip the PATCH (the SDK throws updateCustom on unbound threads).
    selectChatTarget(providerId, modelId);
    let remoteId: string | null = null;
    try {
      remoteId = (aui.threadListItem.getState() as { remoteId?: string | null }).remoteId ?? null;
    } catch {
      remoteId = null;
    }
    if (!remoteId) {
      setOpen(false);
      return;
    }
    const base = (aui.threadListItem.getState().custom ?? {}) as ConversationCustom;
    aui.threadListItem.updateCustom({
      ...base,
      providerId,
      modelId,
    });
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 h-7 rounded-full",
            "px-2.5 text-xs text-muted-foreground hover:text-foreground",
            "hover:bg-accent/50 transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          <Bot className="size-3.5 shrink-0" />
          <span className="max-w-30 truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-55 p-0">
        {groups.length === 0 || groups.every((g) => g.models.length === 0) ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            {composerConfig.copy.noModels}
          </div>
        ) : (
          <ModelOptionList
            groups={groups}
            currentProviderId={currentProviderId ?? undefined}
            currentModelId={currentModelId}
            onSelect={(providerId, modelId) => handleSelect(providerId, modelId)}
            searchPlaceholder={composerConfig.copy.modelSearchPlaceholder}
            searchAriaLabel={composerConfig.copy.modelSearchAria}
            listAriaLabel={composerConfig.copy.modelListAria}
            emptyLabel={composerConfig.copy.modelEmpty}
          />
        )}
        {currentProvider && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {composerConfig.copy.nextMessage(
                currentProvider.name,
                currentModelId || composerConfig.copy.defaultSuffix,
              )}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThinkingChip() {
  const [open, setOpen] = useState(false);
  const aui = useAui();
  const custom = useAuiState((s) => s.threadListItem.custom) as ConversationCustom | undefined;
  // Display follows: one-shot override > conversation default > provider default.
  const stored = useSettingsStore((s) => s.selectedReasoningLevel);
  const providerDefault = useSettingsStore((s) => {
    const pid = s.selectedProviderId ?? custom?.providerId ?? s.activeProviderId;
    return s.providers.find((p) => p.id === pid)?.thinking ?? "off";
  });
  // Show the level that will actually be used. The old code mapped "off" onto a
  // "Default" label, so a conversation with thinking disabled still read as if
  // something would happen.
  const selected: ReasoningLevel = stored ?? custom?.reasoningLevel ?? providerDefault;

  const handleSelect = (level: ReasoningLevel) => {
    setOpen(false);
    // Persist the chosen level as the conversation default AND as the one-shot
    // pick, so the very next message uses exactly what was chosen. Drafts have
    // no server row yet (one-shot + initialize() carry own the pick), so skip
    // the PATCH there — the SDK throws updateCustom on unbound threads.
    useSettingsStore.getState().setSelectedReasoningLevel(level);
    let remoteId: string | null = null;
    try {
      remoteId = (aui.threadListItem.getState() as { remoteId?: string | null }).remoteId ?? null;
    } catch {
      remoteId = null;
    }
    if (!remoteId) return;
    const base = (aui.threadListItem.getState().custom ?? {}) as ConversationCustom;
    aui.threadListItem.updateCustom({ ...base, reasoningLevel: level });
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 h-7 rounded-full",
            "px-2.5 text-xs text-muted-foreground hover:text-foreground",
            "hover:bg-accent/50 transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          <Brain className="size-3.5 shrink-0" />
          <span className="max-w-20 truncate">
            {THINKING_OPTIONS.find((o) => o.id === selected)?.label ?? composerConfig.copy.thinking}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-30">
        {THINKING_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.id}
            className={cn(
              "justify-between",
              opt.id === selected && "bg-accent text-accent-foreground",
            )}
            onSelect={() => handleSelect(opt.id)}
          >
            {opt.label}
            {opt.id === selected && (
              <Check aria-hidden="true" className="ml-auto size-3.5 shrink-0" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
