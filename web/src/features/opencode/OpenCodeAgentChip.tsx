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

/**
 * Code-mode agent chip: one of three independent OpenCode composer chips.
 * Renders OpenCode's own agent choices (from the live capabilities API) and
 * persists the pick to the conversation record (`opencodeAgent`). The agent
 * never auto-selects a model — the three chips (Agent / Model / Thinking)
 * are fully independent.
 */
export function OpenCodeAgentChip() {
  const copy = welcomeConfig.copy;
  const { agentId } = useParams();
  const conversationId = agentId ?? "";
  const {
    agents,
    isLoading,
    error,
    open,
    setOpen,
    currentAgent,
    persist,
  } = useOpenCodeChipState(conversationId);

  const agentName = agents.find((a) => a.id === currentAgent)?.name;
  const label = agentName ?? copy.selectAgent;

  const toggleAgent = async (id: string) => {
    setOpen(false);
    await persist({ opencodeAgent: id });
  };

  return (
    <div className="relative inline-block">
      <OpenCodeChipButton
        icon={<Bot className="size-3.5 shrink-0" />}
        label={label}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        ariaLabel={copy.agentLabel}
      />
      <OpenCodeChipMenu open={open} onClose={() => setOpen(false)}>
        <OpenCodeChipMenuContent isLoading={isLoading} error={error}>
          <div className="p-2">
            <div role="list" className="max-h-40 overflow-y-auto">
              {agents.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  {copy.selectAgent}
                </div>
              ) : (
                agents.map((a) => (
                  <OpenCodeChipOption
                    key={a.id}
                    label={a.name}
                    sub={a.description}
                    active={a.id === currentAgent}
                    onSelect={() => void toggleAgent(a.id)}
                  />
                ))
              )}
            </div>
            <div className="mt-2 px-1 text-xs text-muted-foreground">
              {copy.agentHint}
            </div>
          </div>
        </OpenCodeChipMenuContent>
      </OpenCodeChipMenu>
    </div>
  );
}
