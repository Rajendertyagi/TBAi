"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { welcomeConfig } from "@/config/welcome";
import { useOpenCodeCapabilities } from "./useOpenCodeCapabilities";
import { useOpenCodeConversationConfig } from "./useOpenCodeConversationConfig";
import { useWelcomeEngineStore } from "../chat/state/welcomeEngine";

/**
 * Shared state + persist helper for the three OpenCode composer chips.
 * Each chip renders one independent section (Agent / Model / Thinking) and
 * persists its pick straight to the conversation record so the OpenCode
 * session picks it up on the next send.
 */
export function useOpenCodeChipState(conversationId: string) {
  const { agents, models, isLoading, error } = useOpenCodeCapabilities(true);
  const config = useOpenCodeConversationConfig(conversationId);
  // Draft (no bound conversation yet): picks live in the welcome-engine store
  // and are read by the adapter's initialize() at first-send creation. Bound
  // threads persist to the conversation record instead.
  const draft = !conversationId;
  const welcomeAgent = useWelcomeEngineStore((s) => s.agent);
  const welcomeModel = useWelcomeEngineStore((s) => s.model);
  const welcomeVariant = useWelcomeEngineStore((s) => s.variant);
  const setAgent = useWelcomeEngineStore((s) => s.setAgent);
  const setModel = useWelcomeEngineStore((s) => s.setModel);
  const setVariant = useWelcomeEngineStore((s) => s.setVariant);
  const [open, setOpen] = useState(false);

  const currentAgent = draft ? welcomeAgent : (config?.opencodeAgent ?? "");
  const currentModel = draft ? welcomeModel : (config?.opencodeModel ?? "");
  const currentVariant = draft ? welcomeVariant : (config?.opencodeVariant ?? "");

  const currentModelInfo =
    models.find((m) => `${m.providerID}/${m.id}` === currentModel) ??
    models.find((m) => m.id === currentModel);

  const persist = async (patch: Record<string, string | null>) => {
    if (draft) {
      if ("opencodeAgent" in patch) setAgent(patch.opencodeAgent ?? "");
      if ("opencodeModel" in patch) setModel(patch.opencodeModel ?? "");
      if ("opencodeVariant" in patch) setVariant(patch.opencodeVariant ?? "");
      return;
    }
    if (!conversationId) return;
    try {
      await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch {
      /* a failed persist is non-fatal; the session falls back to server defaults */
    }
  };

  return {
    agents,
    models,
    isLoading,
    error,
    open,
    setOpen,
    currentAgent,
    currentModel,
    currentVariant,
    currentModelInfo,
    persist,
    draft,
  };
}

/** Shared chip trigger button — one look for all three OpenCode chips. */
export function OpenCodeChipButton({
  icon,
  label,
  open,
  onToggle,
  ariaLabel,
}: {
  icon: React.ReactNode;
  label: string;
  open: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-haspopup="true"
      aria-expanded={open}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 rounded-full border border-border",
        "px-2.5 text-xs text-muted-foreground hover:text-foreground",
        "hover:bg-accent/50 transition-colors cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {icon}
      <span className="max-w-30 truncate">{label}</span>
      <ChevronDownMini open={open} />
    </button>
  );
}

function ChevronDownMini({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0 opacity-50 transition-transform", open && "rotate-180")}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** Shared empty/loading/error state renderer for a chip menu body. */
export function OpenCodeChipMenuContent({
  isLoading,
  error,
  children,
}: {
  isLoading: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  const copy = welcomeConfig.copy;
  if (isLoading) {
    return (
      <div className="px-3 py-6 text-center text-sm text-muted-foreground">
        {copy.loadingCapabilities}
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-3 py-6 text-center text-sm text-destructive">
        {copy.capabilitiesError}
      </div>
    );
  }
  return <>{children}</>;
}

/** Single option row in a chip menu. */
export function OpenCodeChipOption({
  label,
  active,
  onSelect,
  sub,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
  sub?: string;
}) {
  return (
    <button
      type="button"
      role="listitem"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        "hover:bg-accent/60",
        active && "bg-accent",
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        {label}
        {sub ? <span className="text-muted-foreground"> · {sub}</span> : null}
      </span>
      {active && <Check aria-hidden="true" className="ml-auto size-3.5 shrink-0" />}
    </button>
  );
}

/** Wrapper div with consistent menu chrome. */
export function OpenCodeChipMenu({
  open,
  children,
  className,
}: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  if (!open) return null;
  return (
    <div
      role="menu"
      className={cn(
        "absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl border border-border bg-card p-0 text-sm shadow-md",
        "animate-in fade-in-0 zoom-in-95 duration-150",
        className,
      )}
    >
      {children}
    </div>
  );
}
