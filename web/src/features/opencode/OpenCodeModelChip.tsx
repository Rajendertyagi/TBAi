"use client";

import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { Bot } from "lucide-react";
import { welcomeConfig } from "@/config/welcome";
import { Input } from "@/components/ui/input";
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

  // Search narrows by model name or id; survivors stay grouped under their
  // provider, providers in first-seen (capabilities) order.
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ordered: { provider: string; options: OpenCodeModelOption[] }[] = [];
    const byProvider = new Map<string, OpenCodeModelOption[]>();
    for (const m of models) {
      if (
        q &&
        !m.name.toLowerCase().includes(q) &&
        !m.id.toLowerCase().includes(q)
      ) {
        continue;
      }
      const key = m.providerID || "";
      let list = byProvider.get(key);
      if (!list) {
        list = [];
        byProvider.set(key, list);
        ordered.push({ provider: key, options: list });
      }
      list.push(m);
    }
    for (const g of ordered) {
      g.options.sort((a, b) => a.name.localeCompare(b.name));
    }
    return ordered;
  }, [models, query]);
  const matchCount = groups.reduce((n, g) => n + g.options.length, 0);

  return (
    <div className="relative inline-block">
      <OpenCodeChipButton
        icon={<Bot className="size-3.5 shrink-0" />}
        label={label}
        open={open}
        onToggle={() => {
          setQuery("");
          setOpen((v) => !v);
        }}
        ariaLabel={copy.modelLabel}
      />
      <OpenCodeChipMenu open={open} onClose={() => setOpen(false)} className="w-64">
        <OpenCodeChipMenuContent isLoading={isLoading} error={error}>
          <div className="p-2">
            <div className="px-0 pb-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={copy.modelSearchPlaceholder}
                aria-label={copy.modelSearchPlaceholder}
                className="h-8"
              />
            </div>
            <div role="list" className="max-h-48 overflow-y-auto">
              {matchCount === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  {query.trim() ? copy.noModelsMatch : copy.selectModel}
                </div>
              ) : (
                groups.map((g) => (
                  <div key={g.provider || "other"}>
                    {g.provider ? (
                      <div className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {g.provider}
                      </div>
                    ) : null}
                    {g.options.map((m) => {
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
                    })}
                  </div>
                ))
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
