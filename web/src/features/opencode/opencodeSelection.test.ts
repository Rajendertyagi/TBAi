import { describe, it, expect } from "bun:test";

type SelectionState = {
  readonly agent: string;
  readonly model: string;
  readonly variant: string;
};

type SelectionPatch = {
  readonly opencodeAgent?: string | null;
  readonly opencodeModel?: string | null;
  readonly opencodeVariant?: string | null;
};

type MergeSelection = (
  current: SelectionState,
  patch: SelectionPatch,
) => SelectionState;

async function mergeSelection(
  current: SelectionState,
  patch: SelectionPatch,
): Promise<SelectionState> {
  const module = await import("./opencodeSelection");
  const merge = module.mergeOpenCodeSelectionState as MergeSelection;
  return merge(current, patch);
}

describe("mergeOpenCodeSelectionState", () => {
  it("updates only the agent while preserving model and variant", async () => {
    expect(
      await mergeSelection(
        { agent: "build", model: "model-1", variant: "high" },
        { opencodeAgent: "plan" },
      ),
    ).toEqual({ agent: "plan", model: "model-1", variant: "high" });
  });

  it("updates only the model while preserving agent and variant", async () => {
    expect(
      await mergeSelection(
        { agent: "build", model: "model-1", variant: "high" },
        { opencodeModel: "model-2" },
      ),
    ).toEqual({ agent: "build", model: "model-2", variant: "high" });
  });

  it("updates only the variant while preserving agent and model", async () => {
    expect(
      await mergeSelection(
        { agent: "build", model: "model-1", variant: "high" },
        { opencodeVariant: "low" },
      ),
    ).toEqual({ agent: "build", model: "model-1", variant: "low" });
  });

  it("maps null updates to empty defaults without mutating current", async () => {
    const current = Object.freeze({ agent: "build", model: "model-1", variant: "high" });
    const snapshot = { ...current };
    expect(
      await mergeSelection(current, {
        opencodeAgent: null,
        opencodeModel: null,
        opencodeVariant: null,
      }),
    ).toEqual({ agent: "", model: "", variant: "" });
    expect(current).toEqual(snapshot);
  });
});
