import { describe, it, expect, beforeEach } from "bun:test";
import { useSettingsStore } from "./index";
import type { ProviderConfig } from "../types";

function makeProvider(id: string, isActive: boolean): ProviderConfig {
  return {
    id,
    name: id,
    type: "openai",
    model: `model-${id}`,
    isActive,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("settings store — per-message target selection", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      providers: [],
      activeProviderId: null,
      selectedProviderId: null,
      selectedModelId: null,
      selectedReasoningLevel: null,
    });
  });

  it("setProviders seeds the active provider from isActive", () => {
    const a = makeProvider("a", true);
    const b = makeProvider("b", false);
    useSettingsStore.getState().setProviders([a, b]);
    expect(useSettingsStore.getState().activeProviderId).toBe("a");
  });

  it("selectChatTarget points the next message elsewhere WITHOUT mutating saved defaults", () => {
    const a = makeProvider("a", true);
    const b = makeProvider("b", false);
    useSettingsStore.getState().setProviders([a, b]);

    // Per-message pick of provider b's model.
    useSettingsStore.getState().selectChatTarget("b", "model-b");
    const s = useSettingsStore.getState();
    expect(s.activeProviderId).toBe("a");
    expect(s.selectedProviderId).toBe("b");
    expect(s.selectedModelId).toBe("model-b");
    // Saved defaults untouched:
    expect(s.providers.find((p) => p.id === "a")?.isActive).toBe(true);
    expect(s.providers.find((p) => p.id === "b")?.isActive).toBe(false);
    expect(s.providers.find((p) => p.id === "a")?.model).toBe("model-a");
  });

  it("revertChatTarget restores the saved default and clears one-shot overrides", () => {
    const a = makeProvider("a", true);
    const b = makeProvider("b", false);
    useSettingsStore.getState().setProviders([a, b]);
    useSettingsStore.getState().selectChatTarget("b", "model-b");
    useSettingsStore.getState().setSelectedReasoningLevel("medium");

    useSettingsStore.getState().revertChatTarget();
    const s = useSettingsStore.getState();
    expect(s.activeProviderId).toBe("a");
    expect(s.selectedProviderId).toBeNull();
    expect(s.selectedModelId).toBeNull();
    expect(s.selectedReasoningLevel).toBeNull();
    // Still not mutating the stored default model:
    expect(s.providers.find((p) => p.id === "a")?.model).toBe("model-a");
  });

  it("protocol selection is never part of the per-message state", () => {
    const a = makeProvider("a", true);
    useSettingsStore.getState().setProviders([a]);
    useSettingsStore.getState().selectChatTarget("a", "model-a");
    useSettingsStore.getState().revertChatTarget();
    const keys = Object.keys(useSettingsStore.getState());
    expect(keys).not.toContain("apiProtocol");
    expect(keys).not.toContain("selectedProtocol");
  });

  it("revertChatTarget clears ALL THREE one-shot overrides (provider, model, reasoning) — none persist", () => {
    const a = makeProvider("a", true);
    useSettingsStore.getState().setProviders([a]);

    // Set every one-shot channel, as a composer pick would.
    useSettingsStore.getState().selectChatTarget("a", "model-a");
    useSettingsStore.getState().setSelectedReasoningLevel("high");
    const before = useSettingsStore.getState();
    expect(before.selectedProviderId).toBe("a");
    expect(before.selectedModelId).toBe("model-a");
    expect(before.selectedReasoningLevel).toBe("high");

    // The transport calls this after consuming the pick on send.
    useSettingsStore.getState().revertChatTarget();
    const after = useSettingsStore.getState();
    expect(after.selectedProviderId).toBeNull();
    expect(after.selectedModelId).toBeNull();
    expect(after.selectedReasoningLevel).toBeNull();

    // The one-shots are a cache of the NEXT send's override only — they are
    // never the source of truth and never survive a revert. The saved
    // provider default is untouched throughout.
    expect(after.activeProviderId).toBe("a");
    expect(after.providers.find((p) => p.id === "a")?.model).toBe("model-a");
  });
});
