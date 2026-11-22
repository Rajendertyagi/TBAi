/**
 * Direct model/reasoning selection routing (Fix 3).
 *
 * An existing conversation's pick goes ONLY to its `custom`; the global one-shot
 * override is untouched, so another chat's next send is unaffected. A draft's
 * pick goes ONLY to the global one-shot override, which materialization captures
 * into the new conversation row.
 */
import { describe, it, expect } from "bun:test";
import {
  applyDirectModelSelection,
  applyDirectReasoningSelection,
  type DirectSelectionCustom,
} from "@web/features/chat/state/directSelection";

interface Spy {
  oneShotModel: Array<[string, string]>;
  oneShotReasoning: string[];
  customUpdates: Array<Record<string, unknown>>;
}

function spies() {
  const s: Spy = { oneShotModel: [], oneShotReasoning: [], customUpdates: [] };
  return {
    state: s,
    modelTargets: {
      setOneShotProviderModel: (p: string, m: string) => s.oneShotModel.push([p, m]),
      updateCustom: (c: Record<string, unknown>) => s.customUpdates.push(c),
    },
    reasoningTargets: {
      setOneShotReasoning: (level: string) => s.oneShotReasoning.push(level),
      updateCustom: (c: Record<string, unknown>) => s.customUpdates.push(c),
    },
  };
}

const EXISTING: DirectSelectionCustom = {
  providerId: "old-provider",
  modelId: "old-model",
  reasoningLevel: "low",
  engine: "direct",
};

describe("applyDirectModelSelection", () => {
  it("existing conversation: writes custom only, never the global one-shot", () => {
    const { state, modelTargets } = spies();
    applyDirectModelSelection({
      isDraft: false,
      custom: EXISTING,
      providerId: "new-provider",
      modelId: "new-model",
      targets: modelTargets,
    });
    expect(state.oneShotModel).toEqual([]);
    expect(state.customUpdates).toHaveLength(1);
    expect(state.customUpdates[0]).toMatchObject({
      providerId: "new-provider",
      modelId: "new-model",
      reasoningLevel: "low",
      engine: "direct",
    });
  });

  it("draft: sets the global one-shot only, never custom", () => {
    const { state, modelTargets } = spies();
    applyDirectModelSelection({
      isDraft: true,
      custom: EXISTING,
      providerId: "draft-provider",
      modelId: "draft-model",
      targets: modelTargets,
    });
    expect(state.oneShotModel).toEqual([["draft-provider", "draft-model"]]);
    expect(state.customUpdates).toEqual([]);
  });

  it("one chat's pick cannot change another chat's next send", () => {
    const { state, modelTargets } = spies();
    // Chat A (existing) picks a model — must not set a global override.
    applyDirectModelSelection({
      isDraft: false,
      custom: EXISTING,
      providerId: "chat-A-provider",
      modelId: "chat-A-model",
      targets: modelTargets,
    });
    // Chat B's next send reads the global one-shot, which is still empty.
    expect(state.oneShotModel).toEqual([]);
  });
});

describe("applyDirectReasoningSelection", () => {
  it("existing conversation: writes custom only, never the global one-shot", () => {
    const { state, reasoningTargets } = spies();
    applyDirectReasoningSelection({
      isDraft: false,
      custom: EXISTING,
      level: "high",
      targets: reasoningTargets,
    });
    expect(state.oneShotReasoning).toEqual([]);
    expect(state.customUpdates).toHaveLength(1);
    expect(state.customUpdates[0]).toMatchObject({
      reasoningLevel: "high",
      providerId: "old-provider",
      modelId: "old-model",
    });
  });

  it("draft: sets the global one-shot only, never custom", () => {
    const { state, reasoningTargets } = spies();
    applyDirectReasoningSelection({
      isDraft: true,
      custom: EXISTING,
      level: "medium",
      targets: reasoningTargets,
    });
    expect(state.oneShotReasoning).toEqual(["medium"]);
    expect(state.customUpdates).toEqual([]);
  });
});
