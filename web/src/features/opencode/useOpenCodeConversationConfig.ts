"use client";

import { useEffect, useState } from "react";

/**
 * OpenCode configuration for a bound conversation: the persisted agent, model,
 * and thinking level (variant) the session was created with. The OpenCode
 * runtime derives its prompt-level defaults from these so a session never
 * falls back to a server-implicit default.
 */
export interface OpenCodeConversationConfig {
  opencodeAgent: string | null;
  opencodeModel: string | null;
  opencodeVariant: string | null;
  /**
   * The Auto Approval shield for **this conversation**.
   *
   * Read straight off the same conversation record as the three fields above,
   * so the session's shield has exactly one source of truth — no global flag,
   * no `localStorage`, no second persistence layer. It is **per conversation**:
   * enabling it on session A cannot affect session B.
   *
   * **Fails closed.** Only an explicit `true` activates Auto; missing, null or
   * malformed values read as `false` (manual), matching `restoreMode` in
   * `features/permissions/permissionPolicy.ts`.
   */
  opencodeAutoApprove: boolean;
}

/**
 * Reads the conversation's OpenCode agent/model/variant configuration from the
 * TBAi conversation API (the same source `OpenCodeSessionRow` displays). No
 * value leaks into the normal-chat runtime: this hook is only mounted under the
 * OpenCode feature tree.
 */
export function useOpenCodeConversationConfig(
  conversationId: string | undefined,
): OpenCodeConversationConfig | null {
  const [config, setConfig] = useState<OpenCodeConversationConfig | null>(null);

  useEffect(() => {
    if (!conversationId) {
      setConfig(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/conversations/${conversationId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setConfig({
          opencodeAgent: data.opencodeAgent ?? null,
          opencodeModel: data.opencodeModel ?? null,
          opencodeVariant: data.opencodeVariant ?? null,
          // `=== true`, not a truthy check: fail closed to manual for anything
          // that is not an explicit true (see the field's doc).
          opencodeAutoApprove: data.opencodeAutoApprove === true,
        });
      })
      .catch(() => {
        /* leave config null — runtime falls back to no explicit default */
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return config;
}
