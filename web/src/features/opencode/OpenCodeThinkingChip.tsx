"use client";

import { useParams } from "react-router";
import { Brain } from "lucide-react";
import {
  useOpenCodeChipState,
  OpenCodeChipButton,
  OpenCodeChipMenu,
  OpenCodeChipMenuContent,
  OpenCodeChipOption,
} from "./OpenCodeChipShared";
import { buildOpenCodeThinkingOptions } from "./useOpenCodeCapabilities";

/**
 * Code-mode thinking chip: one of three independent OpenCode composer chips.
 * The options are sourced from the selected model's live `variants` array —
 * never a fixed enum. "Default" (= omit the variant field on prompt_async)
 * is always the first entry. The chip hides entirely when the selected model
 * declares no variants.
 */
export function OpenCodeThinkingChip() {
  const { agentId } = useParams();
  const conversationId = agentId ?? "";
  const {
    isLoading,
    error,
    open,
    setOpen,
    currentVariant,
    currentModelInfo,
    persist,
  } = useOpenCodeChipState(conversationId);

  const thinkingOptions = buildOpenCodeThinkingOptions(currentModelInfo);

  // No variants on the current model → the chip is hidden.
  if (thinkingOptions.length === 0) return null;

  const label =
    thinkingOptions.find((o) => o.id === currentVariant)?.label ??
    thinkingOptions[0]?.label ??
    "Thinking";

  const toggleVariant = async (id: string) => {
    setOpen(false);
    // Empty string = Default = omit the variant field on prompt_async.
    await persist({ opencodeVariant: id === "" ? null : id });
  };

  return (
    <div className="relative inline-block">
      <OpenCodeChipButton
        icon={<Brain className="size-3.5 shrink-0" />}
        label={label}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        ariaLabel="Thinking level"
      />
      <OpenCodeChipMenu open={open}>
        <OpenCodeChipMenuContent isLoading={isLoading} error={error}>
          <div role="list" className="p-2">
            {thinkingOptions.map((opt) => (
              <OpenCodeChipOption
                key={opt.id}
                label={opt.label}
                active={opt.id === currentVariant}
                onSelect={() => void toggleVariant(opt.id)}
              />
            ))}
          </div>
        </OpenCodeChipMenuContent>
      </OpenCodeChipMenu>
    </div>
  );
}
