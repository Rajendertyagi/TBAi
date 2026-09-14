import { describe, it, expect } from "bun:test";
import {
  buildModelGroups,
  filterModelGroups,
  resolveModelOwner,
} from "./model-groups";
import type { ProviderConfig } from "../types";

function provider(
  id: string,
  name: string,
  models: Array<{ id: string; label?: string }>,
): ProviderConfig {
  return {
    id,
    name,
    type: "openai",
    model: models[0]?.id ?? "m",
    models: models.map((m) => ({ id: m.id, label: m.label, provider: "openai" })),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const groups = () =>
  buildModelGroups(
    [
      provider("p1", "Agnes", [{ id: "agnes-3.0-flash", label: "Flash" }]),
      provider("p2", "Codex", [{ id: "gpt-5" }, { id: "gpt-5-mini" }]),
    ],
    "p1",
  );

describe("buildModelGroups", () => {
  it("groups every provider's models and marks the default", () => {
    const g = groups();
    expect(g).toHaveLength(2);
    expect(g[0].isDefault).toBe(true);
    expect(g[1].isDefault).toBe(false);
    expect(g[1].models.map((m) => m.id)).toEqual(["gpt-5", "gpt-5-mini"]);
  });
});

describe("filterModelGroups", () => {
  it("returns everything on a blank query", () => {
    expect(filterModelGroups(groups(), "  ")).toHaveLength(2);
  });

  it("matches model id, label, and provider name", () => {
    expect(filterModelGroups(groups(), "flash")).toHaveLength(1);
    expect(filterModelGroups(groups(), "gpt-5-mini")[0].models).toHaveLength(1);
    const byProvider = filterModelGroups(groups(), "codex");
    expect(byProvider).toHaveLength(1);
    expect(byProvider[0].providerId).toBe("p2");
  });

  it("drops groups with no matches", () => {
    expect(filterModelGroups(groups(), "zzz")).toHaveLength(0);
  });
});

describe("resolveModelOwner", () => {
  it("finds the owning provider for a model id", () => {
    expect(resolveModelOwner(groups(), "gpt-5-mini")).toEqual({
      providerId: "p2",
      modelId: "gpt-5-mini",
    });
    expect(resolveModelOwner(groups(), "nope")).toBeNull();
  });
});
