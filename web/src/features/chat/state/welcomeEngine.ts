import { create } from "zustand";

export type WelcomeEngine = "direct" | "opencode";

interface WelcomeEngineState {
  engine: WelcomeEngine;
  agent: string;
  model: string;
  variant: string;
  /**
   * The Auto Approval shield for the draft.
   *
   * A **session permission preference**, not engine-specific configuration — so
   * unlike `agent`/`model`/`variant` it is deliberately NOT cleared by
   * `setEngine`. Its only job is to survive draft → conversation
   * materialization, where it becomes `conversation.opencodeAutoApprove`; from
   * then on the conversation config is the single source of truth.
   *
   * Defaults to `false` and fails closed: anything that is not literally `true`
   * reads as manual.
   */
  autoApprove: boolean;
  setEngine: (engine: WelcomeEngine) => void;
  setAgent: (agent: string) => void;
  setModel: (model: string) => void;
  setVariant: (variant: string) => void;
  setAutoApprove: (autoApprove: boolean) => void;
}

const STORAGE_KEY = "tbai:welcome-engine";

function load(): {
  engine: WelcomeEngine;
  agent: string;
  model: string;
  variant: string;
  autoApprove: boolean;
} {
  const fallback: {
    engine: WelcomeEngine;
    agent: string;
    model: string;
    variant: string;
    autoApprove: boolean;
  } = {
    engine: "direct",
    agent: "",
    model: "",
    variant: "",
    autoApprove: false,
  };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<{
      engine: WelcomeEngine;
      agent: string;
      model: string;
      variant: string;
      autoApprove: boolean;
    }>;
    return {
      engine: parsed.engine === "opencode" ? "opencode" : "direct",
      agent: typeof parsed.agent === "string" ? parsed.agent : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      variant: typeof parsed.variant === "string" ? parsed.variant : "",
      // Strictly boolean: a legacy `"true"`/`1`/absent value must not arm Auto.
      autoApprove: typeof parsed.autoApprove === "boolean" ? parsed.autoApprove : false,
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
  autoApprove: boolean;
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
  // change. `autoApprove` is NOT cleared — it is a session permission
  // preference rather than engine configuration, and silently disarming the
  // shield on an engine switch would be invisible to the user. Hence the spread:
  // the current value is carried through rather than rebuilt from scratch.
  setEngine: (engine) => {
    const next = { ...useWelcomeEngineStore.getState(), engine, agent: "", model: "", variant: "" };
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
  setAutoApprove: (autoApprove) => {
    const next = { ...useWelcomeEngineStore.getState(), autoApprove };
    persist(next);
    set({ autoApprove });
  },
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
