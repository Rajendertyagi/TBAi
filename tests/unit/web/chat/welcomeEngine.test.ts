import { describe, it, expect, beforeEach } from "bun:test";
import {
  useWelcomeEngineStore,
  getWelcomeEngineSnapshot,
  type WelcomeEngine,
} from "@web/features/chat/state/welcomeEngine.ts";

/**
 * Welcome engine store (canonical): `engine` is SQLite-authoritative shared
 * portable state (defaults before hydration; patched via preferences). Agent,
 * model, variant, and autoApprove are local/session state (not shared portable).
 * No localStorage authority.
 */

function defaultState() {
  return {
    engine: "direct" as WelcomeEngine,
    agent: "",
    model: "",
    variant: "",
    autoApprove: false,
  };
}

describe("welcome engine store — engine switch semantics", () => {
  beforeEach(() => {
    useWelcomeEngineStore.setState(defaultState());
  });

  it("defaults to the Direct engine with empty agent/model", () => {
    expect(useWelcomeEngineStore.getState().engine).toBe("direct");
    expect(useWelcomeEngineStore.getState().agent).toBe("");
    expect(useWelcomeEngineStore.getState().model).toBe("");
  });

  it("setEngine('opencode') clears a prior agent + model pick (no stale leak)", () => {
    useWelcomeEngineStore.getState().setAgent("coder");
    useWelcomeEngineStore.getState().setModel("openai/gpt-4o");
    expect(useWelcomeEngineStore.getState().agent).toBe("coder");

    useWelcomeEngineStore.getState().setEngine("opencode");
    expect(useWelcomeEngineStore.getState().engine).toBe("opencode");
    expect(useWelcomeEngineStore.getState().agent).toBe("");
    expect(useWelcomeEngineStore.getState().model).toBe("");
  });

  it("setEngine back to 'direct' also clears agent + model", () => {
    useWelcomeEngineStore.getState().setEngine("opencode");
    useWelcomeEngineStore.getState().setAgent("planner");
    useWelcomeEngineStore.getState().setEngine("direct");
    expect(useWelcomeEngineStore.getState().engine).toBe("direct");
    expect(useWelcomeEngineStore.getState().agent).toBe("");
    expect(useWelcomeEngineStore.getState().model).toBe("");
  });

  it("setAgent persists the agent without touching engine", () => {
    useWelcomeEngineStore.getState().setEngine("opencode");
    useWelcomeEngineStore.getState().setAgent("coder");
    const s = useWelcomeEngineStore.getState();
    expect(s.engine).toBe("opencode");
    expect(s.agent).toBe("coder");
    expect(s.model).toBe("");
  });

  it("setAgent('') explicitly clears the agent (toggle-off)", () => {
    useWelcomeEngineStore.getState().setEngine("opencode");
    useWelcomeEngineStore.getState().setAgent("coder");
    useWelcomeEngineStore.getState().setAgent("");
    expect(useWelcomeEngineStore.getState().agent).toBe("");
    expect(useWelcomeEngineStore.getState().engine).toBe("opencode");
  });

  it("setModel persists the model without touching engine/agent", () => {
    useWelcomeEngineStore.getState().setEngine("opencode");
    useWelcomeEngineStore.getState().setAgent("coder");
    useWelcomeEngineStore.getState().setModel("openai/gpt-4o");
    const s = useWelcomeEngineStore.getState();
    expect(s.engine).toBe("opencode");
    expect(s.agent).toBe("coder");
    expect(s.model).toBe("openai/gpt-4o");
  });

  it("setModel('') explicitly clears the model (toggle-off)", () => {
    useWelcomeEngineStore.getState().setEngine("opencode");
    useWelcomeEngineStore.getState().setModel("openai/gpt-4o");
    useWelcomeEngineStore.getState().setModel("");
    expect(useWelcomeEngineStore.getState().model).toBe("");
  });

  it("setAutoApprove flips the draft shield and survives an engine switch", () => {
    useWelcomeEngineStore.getState().setEngine("opencode");
    useWelcomeEngineStore.getState().setAutoApprove(true);
    expect(useWelcomeEngineStore.getState().autoApprove).toBe(true);

    // The shield is a session permission preference, not engine config.
    useWelcomeEngineStore.getState().setEngine("direct");
    expect(useWelcomeEngineStore.getState().autoApprove).toBe(true);
    useWelcomeEngineStore.getState().setAutoApprove(false);
    expect(useWelcomeEngineStore.getState().autoApprove).toBe(false);
  });
});

describe("getWelcomeEngineSnapshot — non-React caller shape", () => {
  beforeEach(() => {
    useWelcomeEngineStore.setState(defaultState());
  });

  it("returns the full { engine, agent, model, variant, autoApprove } shape", () => {
    useWelcomeEngineStore.getState().setEngine("opencode");
    useWelcomeEngineStore.getState().setAgent("coder");
    useWelcomeEngineStore.getState().setModel("openai/gpt-4o");
    const snap = getWelcomeEngineSnapshot();
    expect(snap).toEqual({
      engine: "opencode",
      agent: "coder",
      model: "openai/gpt-4o",
      variant: "",
      autoApprove: false,
    });
    useWelcomeEngineStore.getState().setAgent("");
    expect(getWelcomeEngineSnapshot().agent).toBe("");
    expect(getWelcomeEngineSnapshot().engine).toBe("opencode");
  });

  it("returns empty strings for a fresh Direct default", () => {
    const snap = getWelcomeEngineSnapshot();
    expect(snap.engine).toBe("direct");
    expect(snap.agent).toBe("");
    expect(snap.model).toBe("");
  });
});

describe("welcome engine store — no localStorage authority", () => {
  it("does not read or write tbai:welcome-engine as authority", async () => {
    const src = await Bun.file(
      new URL("../../../../web/src/features/chat/state/welcomeEngine.ts", import.meta.url),
    ).text();
    expect(src).not.toContain("tbai:welcome-engine");
    expect(src).not.toContain("localStorage");
  });
});
