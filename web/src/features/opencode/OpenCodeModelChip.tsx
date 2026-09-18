"use client";

import { useParams } from "react-router";
import { Bot } from "lucide-react";
import { welcomeConfig } from "@/config/welcome";
import {
  useOpenCodeChipState,
  OpenCodeChipButton,
  OpenCodeChipMenu,
  OpenCodeChipMenuContent,
  OpenCodeChipOption,
} from "./OpenCodeChipShared";
import type { OpenCodeModelOption } from "./useOpenCodeCapabilities";

/**
 * Code-mode model chip: one of three independent OpenCode composer chips.
 * Renders OpenCode's own model choices (from the live capabilities API) and
 * persists the pick to the conversation record (`opencodeModel`). Model
 * selection is independent of the agent chip.
 */
export function OpenCodeModelChip() {
  const copy = welcomeConfig.copy;
  const { agentId } = useParams();
  const conversationId = agentId ?? "";
  const {
    models,
    isLoading,
    error,
    open,
    setOpen,
    currentModel,
    currentModelInfo,
    persist,
  } = useOpenCodeChipState(conversationId);

  const label =
    currentModelInfo?.name ??
    (currentModel || copy.selectModel);

  const toggleModel = async (m: OpenCodeModelOption) => {
    setOpen(false);
    const value = m.providerID ? `${m.providerID}/${m.id}` : m.id;
    await persist({ opencodeModel: value });
  };

  return (
    <div className="relative inline-block">
      <OpenCodeChipButton
        icon={<Bot className="size-3.5 shrink-0" />}
        label={label}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        ariaLabel={copy.modelLabel}
      />
      <OpenCodeChipMenu open={open}>
        <OpenCodeChipMenuContent isLoading={isLoading} error={error}>
          <div className="p-2">
            <div role="list" className="max-h-48 overflow-y-auto">
              {models.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  {copy.selectModel}
                </div>
              ) : (
                models.map((m) => {
                  const value = m.providerID ? `${m.providerID}/${m.id}` : m.id;
                  return (
                    <OpenCodeChipOption
                      key={value}
                      label={m.name}
                      sub={m.providerID || undefined}
                      active={value === currentModel}
                      onSelect={() => void toggleModel(m)}
                    />
                  );
                })
              )}
            </div>
            <div className="mt-2 px-1 text-xs text-muted-foreground">
              {copy.modelHint}
            </div>
          </div>
        </OpenCodeChipMenuContent>
      </OpenCodeChipMenu>
    </div>
  );
}
