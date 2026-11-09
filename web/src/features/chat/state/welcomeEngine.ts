import { create } from "zustand";
import { usePreferencesStore } from "../../preferences/state/preferencesStore";

export type WelcomeEngine = "direct" | "opencode";

interface WelcomeEngineState {
  engine: WelcomeEngine;
  agent: string;
  model: string;
  variant: string;
  /**
   * Session permission preference (local/fail-closed), not shared portable config.
   * Survives draft → conversation materialization; conversation config becomes
   * source of truth after materialization.
   */
  autoApprove: boolean;
  setEngine: (engine: WelcomeEngine) => void;
  setAgent: (agent: string) => void;
  setModel: (model: string) => void;
  setVariant: (variant: string) => void;
  setAutoApprove: (autoApprove: boolean) => void;
}

export const useWelcomeEngineStore = create<WelcomeEngineState>((set) => ({
  // engine: SQLite authoritative (defaults before hydration). Others: local/session.
  engine: "direct",
  agent: "",
  model: "",
  variant: "",
  autoApprove: false,
  setEngine: (engine) => {
    set({ engine, agent: "", model: "", variant: "" });
    void usePreferencesStore
      .getState()
      .patchPreferences({ welcome: { engine } })
      .catch(() => {});
  },
  setAgent: (agent) => set({ agent }),
  setModel: (model) => set({ model }),
  setVariant: (variant) => set({ variant }),
  setAutoApprove: (autoApprove) => set({ autoApprove: autoApprove === true }),
}));

/** Snapshot for non-React callers (adapter initialize). */
export function getWelcomeEngineSnapshot(): {
  engine: WelcomeEngine;
  agent: string;
  model: string;
  variant: string;
  autoApprove: boolean;
} {
  const { engine, agent, model, variant, autoApprove } = useWelcomeEngineStore.getState();
  return { engine, agent, model, variant, autoApprove };
}
