import { create } from "zustand";

export type WelcomeEngine = "direct" | "opencode";

interface WelcomeEngineState {
  engine: WelcomeEngine;
  agent: string;
  model: string;
  variant: string;
  setEngine: (engine: WelcomeEngine) => void;
  setAgent: (agent: string) => void;
  setModel: (model: string) => void;
  setVariant: (variant: string) => void;
}

const STORAGE_KEY = "tbai:welcome-engine";

function load(): {
  engine: WelcomeEngine;
  agent: string;
  model: string;
  variant: string;
} {
  const fallback: {
    engine: WelcomeEngine;
    agent: string;
    model: string;
    variant: string;
  } = {
    engine: "direct",
    agent: "",
    model: "",
    variant: "",
  };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<{
      engine: WelcomeEngine;
      agent: string;
      model: string;
      variant: string;
    }>;
    return {
      engine: parsed.engine === "opencode" ? "opencode" : "direct",
      agent: typeof parsed.agent === "string" ? parsed.agent : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      variant: typeof parsed.variant === "string" ? parsed.variant : "",
    };
  } catch {
    return fallback;
  }
}

function persist(state: {
  engine: WelcomeEngine;
  agent: string;
  model: string;
  variant: string;
}): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — session-only */
  }
}

export const useWelcomeEngineStore = create<WelcomeEngineState>((set) => ({
  ...load(),
  // Switching engine clears agent/model/variant: they are engine-specific and
  // locked at creation, so a stale selection must never leak across an engine
  // change.
  setEngine: (engine) => {
    const next = { engine, agent: "", model: "", variant: "" };
    persist(next);
    set(next);
  },
  setAgent: (agent) => {
    const next = { ...useWelcomeEngineStore.getState(), agent };
    persist(next);
    set({ agent });
  },
  setModel: (model) => {
    const next = { ...useWelcomeEngineStore.getState(), model };
    persist(next);
    set({ model });
  },
  setVariant: (variant) => {
    const next = { ...useWelcomeEngineStore.getState(), variant };
    persist(next);
    set({ variant });
  },
}));

/** Snapshot for non-React callers (adapter initialize). */
export function getWelcomeEngineSnapshot(): {
  engine: WelcomeEngine;
  agent: string;
  model: string;
  variant: string;
} {
  const { engine, agent, model, variant } = useWelcomeEngineStore.getState();
  return { engine, agent, model, variant };
}
