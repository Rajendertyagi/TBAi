"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAvailabilityStore } from "../availability/availabilityStore";

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
 *
 * Freshness: the server fetch runs once per conversationId, but successful
 * chip writes also land in a module-level override map via
 * {@link updateConversationConfig}, merged over the fetched value in EVERY
 * instance (chips, `OpenCodeView` runtime defaults, session rows). Without
 * this, a PATCH would update the server while every mounted reader kept
 * showing — and sending with — the stale pick until reload. Overrides are
 * keyed by conversationId, so switching conversations can never leak one
 * chat's picks into another; they only ever hold last-confirmed server
 * writes, so a failed PATCH changes nothing visible.
 */
export function useOpenCodeConversationConfig(
  conversationId: string | undefined,
): OpenCodeConversationConfig | null {
  const [config, setConfig] = useState<OpenCodeConversationConfig | null>(null);
  // Re-render every instance when any override lands.
  const version = useSyncExternalStore(subscribeOverrides, getOverrideVersion);

  // Coordinated recovery (Phase 3.8): re-read authoritative config when the
  // backend returns. Failure retains the previous config (catch below).
  const recoveryEpoch = useAvailabilityStore((s) => s.recoveryEpoch);

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
  }, [conversationId, recoveryEpoch]);

  return useMemo(() => {
    if (!config || !conversationId) return config;
    const override = configOverrides.get(conversationId);
    if (!override) return config;
    return { ...config, ...override };
  }, [config, conversationId, version]);
}

type ConfigPatch = Partial<
  Pick<
    OpenCodeConversationConfig,
    "opencodeAgent" | "opencodeModel" | "opencodeVariant" | "opencodeAutoApprove"
  >
>;

/** Last-confirmed server writes, keyed by conversation. Never fail-closed data. */
const configOverrides = new Map<string, ConfigPatch>();
let overrideVersion = 0;
const overrideListeners = new Set<() => void>();

function getOverrideVersion(): number {
  return overrideVersion;
}

function subscribeOverrides(notify: () => void): () => void {
  overrideListeners.add(notify);
  return () => {
    overrideListeners.delete(notify);
  };
}

/**
 * Record a successfully persisted conversation-config write so every mounted
 * reader (chips, runtime defaults) reflects it immediately instead of waiting
 * for a reload. Call ONLY after the PATCH succeeded — a failed write must
 * leave the visible state untouched.
 */
export function updateConversationConfig(
  conversationId: string,
  patch: ConfigPatch,
): void {
  const prev = configOverrides.get(conversationId) ?? {};
  configOverrides.set(conversationId, { ...prev, ...patch });
  overrideVersion++;
  overrideListeners.forEach((notify) => {
    notify();
  });
}
