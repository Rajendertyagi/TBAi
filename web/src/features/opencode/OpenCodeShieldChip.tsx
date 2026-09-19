"use client";

import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Shield, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { welcomeConfig } from "@/config/welcome";
import { logger } from "@/lib/logger";
import { useOpenCodeConversationConfig } from "./useOpenCodeConversationConfig";
import { useOpenCodeRuntimeContext } from "./opencodeRuntimeContext";
import { persistAutoApprove } from "./autoApproveWrite";
import { useWelcomeEngineStore } from "../chat/state/welcomeEngine";

/**
 * The Auto Approval shield — a session convenience switch, not a grant.
 *
 * OFF: permission requests are asked. ON: OpenCode permission requests for this
 * session are answered "once" automatically. It is deliberately NOT a
 * permanent "always allow", not a per-tool matrix, and never a permission
 * responder itself — the runtime already owns that behaviour.
 *
 * The UI renders from the authoritative conversation config
 * (`conversation.opencodeAutoApprove`, or the welcome-engine draft before a
 * conversation exists) and writes through the single existing operation
 * (`persistAutoApprove`). It never reads the runtime policy cache and never
 * calls `permission.reply`/`list` directly.
 */

/** The write + draft seams the toggle needs, injected for testability. */
export interface ShieldToggleDeps {
  /** True on the welcome draft (no conversation/session yet). */
  draft: boolean;
  /** The bound conversation id, or "" on the draft. */
  conversationId: string;
  /** The OpenCode session id; undefined ⇒ fail closed (no unsafe call). */
  sessionId: string | undefined;
  /** The runtime's reconcile seam, passed through to the write operation. */
  reconcile?: () => Promise<number>;
  /** The single existing write operation (persist + cache + reconcile). */
  persist: typeof persistAutoApprove;
  /** The draft store setter (draft path only). */
  setDraftAutoApprove: (enabled: boolean) => void;
}

/**
 * The Shield's toggle decision + write orchestration, as a pure function.
 *
 * Draft: flips the welcome-engine draft value (materializes at conversation
 * creation). Bound: calls the single existing write operation with the real
 * session id and reconcile seam. Without a real session id it throws rather
 * than inventing one — the UI then keeps the current state.
 *
 * @param current - The current shield position.
 * @param deps - The write/draft seams.
 * @returns The new shield position.
 * @throws When a bound conversation has no session id, or the write fails.
 */
export async function runShieldToggle(
  current: boolean,
  deps: ShieldToggleDeps,
): Promise<boolean> {
  const target = !current;
  if (deps.draft) {
    deps.setDraftAutoApprove(target);
    return target;
  }
  if (!deps.conversationId || !deps.sessionId) {
    throw new Error("Auto-approval requires an OpenCode session");
  }
  await deps.persist(deps.conversationId, deps.sessionId, target, deps.reconcile);
  return target;
}

/**
 * The Shield's button — presentational, no hooks, so it is statically
 * renderable in tests. Active state is conveyed by `aria-pressed`, the label,
 * the title and the accent styling.
 */
export function OpenCodeShieldButton({
  enabled,
  busy = false,
  disabled = false,
  onToggle,
}: {
  enabled: boolean;
  busy?: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const copy = welcomeConfig.copy;
  const Icon = enabled ? ShieldCheck : Shield;
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || busy}
      aria-pressed={enabled}
      aria-label={copy.shieldAria(enabled)}
      title={enabled ? copy.shieldOnTitle : copy.shieldOffTitle}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 rounded-full border px-2.5 text-xs transition-colors cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:opacity-50 disabled:pointer-events-none",
        enabled
          ? "border-accent bg-accent/15 text-foreground"
          : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/50",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span>{enabled ? copy.shieldOnLabel : copy.shieldOffLabel}</span>
    </button>
  );
}

/**
 * The Shield chip for the OpenCode composer row.
 *
 * Bound conversation: renders from `conversation.opencodeAutoApprove` (the
 * authoritative source) and writes through `persistAutoApprove`. Draft: renders
 * from the welcome-engine store and writes through `setAutoApprove`, so the
 * selection survives draft → conversation materialization. A local mirror keeps
 * the button current immediately after a successful write without waiting for a
 * config refetch; a failed write leaves the mirror (and the UI) on the old
 * state — never a false ON.
 */
export function OpenCodeShieldChip() {
  const { agentId } = useParams();
  const conversationId = agentId ?? "";
  const draft = !conversationId;
  const runtime = useOpenCodeRuntimeContext();
  const config = useOpenCodeConversationConfig(conversationId);
  const draftAutoApprove = useWelcomeEngineStore((s) => s.autoApprove);
  const setDraftAutoApprove = useWelcomeEngineStore((s) => s.setAutoApprove);

  // Authoritative value: the persisted conversation config (bound) or the
  // welcome-engine draft. Never the runtime policy cache.
  const authoritative = draft ? draftAutoApprove : (config?.opencodeAutoApprove ?? false);
  const [enabled, setEnabled] = useState(authoritative);
  const [busy, setBusy] = useState(false);

  // Mirror the authoritative source whenever it changes (initial load, or a
  // draft store update). The mirror is what lets a successful toggle reflect
  // immediately without waiting for a config refetch.
  useEffect(() => {
    setEnabled(authoritative);
  }, [authoritative]);

  // Bound conversations need the config loaded AND a real session id before the
  // toggle can be meaningfully applied; the draft needs neither.
  const canToggle = draft || (config != null && runtime?.sessionId != null);

  const handleToggle = async () => {
    if (busy || !canToggle) return;
    setBusy(true);
    try {
      const next = await runShieldToggle(enabled, {
        draft,
        conversationId,
        sessionId: runtime?.sessionId,
        reconcile: runtime?.reconcileAutoApprove,
        persist: persistAutoApprove,
        setDraftAutoApprove,
      });
      setEnabled(next);
    } catch (e) {
      // A failed write leaves the authoritative value unchanged, so the mirror
      // (and the UI) stays on the old state — never a false ON. Log, don't
      // swallow silently.
      logger.debug("opencode", "shield.toggle_failed", {
        conversationId,
        errorType: e instanceof Error ? e.name : typeof e,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <OpenCodeShieldButton
      enabled={enabled}
      busy={busy}
      disabled={!canToggle}
      onToggle={() => void handleToggle()}
    />
  );
}