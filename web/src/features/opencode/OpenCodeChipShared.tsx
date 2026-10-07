"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { isPlainEscape } from "@/lib/ime";
import { logger } from "@/lib/logger";
import { apiFetch } from "@/lib/platform";
import { welcomeConfig } from "@/config/welcome";
import { useOpenCodeCapabilities } from "./useOpenCodeCapabilities";
import {
  updateConversationConfig,
  useOpenCodeConversationConfig,
} from "./useOpenCodeConversationConfig";
import { useWelcomeEngineStore } from "../chat/state/welcomeEngine";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";
import {
  mergeOpenCodeSelectionState,
  type OpenCodeSelectionPatch,
} from "./opencodeSelection";
import { findChipModelInfo, resolveChipModelSource } from "./chipModelSource";

/**
 * Shared state + persist helper for the three OpenCode composer chips.
 * Each chip renders one independent section (Agent / Model / Thinking) and
 * persists its pick straight to the conversation record so the OpenCode
 * session picks it up on the next send.
 */
export function useOpenCodeChipState(conversationId: string) {
  const { agents, models, isLoading, error } = useOpenCodeCapabilities(true);
  const config = useOpenCodeConversationConfig(conversationId);
  const nativeExtras = useOptionalV2RuntimeExtras();
  // Draft (no bound conversation yet): picks live in the welcome-engine store
  // and seed native session creation. Bound threads persist to the conversation
  // record instead.
  const draft = !conversationId;
  const welcomeAgent = useWelcomeEngineStore((s) => s.agent);
  const welcomeModel = useWelcomeEngineStore((s) => s.model);
  const welcomeVariant = useWelcomeEngineStore((s) => s.variant);
  const setAgent = useWelcomeEngineStore((s) => s.setAgent);
  const setModel = useWelcomeEngineStore((s) => s.setModel);
  const setVariant = useWelcomeEngineStore((s) => s.setVariant);
  const [open, setOpen] = useState(false);

  const currentAgent = draft ? welcomeAgent : (config?.opencodeAgent ?? "");
  // Display source, and the whole point of `chipModelSource`: a stored choice
  // wins, but with no stored choice the chip must show what the session is
  // ACTUALLY bound to. A session bound via the server default never wrote the
  // `opencodeModel` column, so reading only that column showed "Select a model"
  // for a session that was running a real model on every turn.
  //
  // `nativeExtras.model` is the server-reported bound model (set from the real
  // `SessionInfo` and updated by `session.model.selected`), so it is read state
  // rather than a local guess â€” and it is display-only, never written back to
  // the conversation, so observing it cannot become a stored preference.
  const currentModel = resolveChipModelSource({
    draft,
    storedModel: config?.opencodeModel,
    nativeModel: nativeExtras?.model,
    draftModel: welcomeModel,
  });
  const currentVariant = draft ? welcomeVariant : (config?.opencodeVariant ?? "");

  // The catalogue entry for whatever is displayed, resolved through the same
  // lookup the picker uses. `null` for an id this install does not carry, so
  // the chip falls back to showing the raw id instead of inventing a label.
  const currentModelInfo = findChipModelInfo(models, currentModel);

  const persist = async (patch: Record<string, string | null>) => {
    if (draft) {
      if ("opencodeAgent" in patch) setAgent(patch.opencodeAgent ?? "");
      if ("opencodeModel" in patch) setModel(patch.opencodeModel ?? "");
      if ("opencodeVariant" in patch) setVariant(patch.opencodeVariant ?? "");
      return;
    }
    if (!conversationId) return;
    try {
      const res = await apiFetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        logger.debug("opencode", "config persist failed", {
          conversationId,
          status: res.status,
        });
        return;
      }
      const updated = (await res.json().catch(() => null)) as {
        opencodeAgent?: string | null;
        opencodeModel?: string | null;
        opencodeVariant?: string | null;
      } | null;
      // Publish ONLY server-echoed values: the override map must reflect
      // SQLite, not the request. A mismatch leaves all visible state
      // untouched â€” a failed write changes nothing visible.
      const confirmed: {
        -readonly [K in keyof OpenCodeSelectionPatch]: OpenCodeSelectionPatch[K];
      } = {};
      for (const [key, sent] of Object.entries(patch)) {
        const echoed = updated?.[key as keyof typeof updated] ?? null;
        if (echoed !== sent) {
          logger.debug("opencode", "config persist mismatch", {
            conversationId,
            key,
          });
          return;
        }
        confirmed[key as keyof OpenCodeSelectionPatch] = echoed;
      }
      const nextSelection = mergeOpenCodeSelectionState(
        {
          agent: currentAgent,
          model: currentModel,
          variant: currentVariant,
        },
        confirmed,
      );
      updateConversationConfig(conversationId, {
        opencodeAgent: nextSelection.agent || null,
        opencodeModel: nextSelection.model || null,
        opencodeVariant: nextSelection.variant || null,
      });
      if (nativeExtras) {
        const [providerID, ...modelParts] = nextSelection.model.split("/");
        nativeExtras.setDesiredSelection({
          model: providerID && modelParts.length > 0
            ? {
                providerID,
                modelID: modelParts.join("/"),
                ...(nextSelection.variant ? { variant: nextSelection.variant } : {}),
              }
            : null,
          agent: nextSelection.agent || null,
        });
      }
    } catch {
      logger.debug("opencode", "config persist error", { conversationId });
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

/** Shared chip trigger button â€” one look for all three OpenCode chips. */
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
        "inline-flex items-center gap-1.5 h-7",
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
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        "hover:bg-accent/60",
        active && "bg-accent text-accent-foreground",
      )}
    >
      {/* A permanent check column, so the label never shifts sideways when an
          option becomes selected â€” the same contract as the Direct chat model
          list (`ModelOptionList`). */}
      <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
        {active ? <Check aria-hidden="true" className="size-4" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {label}
        {sub ? <span className="text-muted-foreground"> Â· {sub}</span> : null}
      </span>
    </button>
  );
}

/** Wrapper div with consistent menu chrome. Closes on outside click / Escape. */
export function OpenCodeChipMenu({
  open,
  onClose,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // This listener is on `document`, so it sees Escape from anywhere while the
      // menu is open â€” including the composer. The menu holds no text input, so a
      // composition cannot be open *inside* it, but one can be open in the
      // composer while this menu happens to be up, and Escape belongs to the IME
      // first. Guarding only fixes that; it deliberately does NOT change which
      // element may close the menu.
      if (isPlainEscape(e)) onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      ref={rootRef}
      role="menu"
      className={cn(
        "absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl border-none p-0 text-sm glass-surface shadow-floating",
        "animate-in fade-in-0 zoom-in-95 duration-150",
        className,
      )}
    >
      {children}
    </div>
  );
}
