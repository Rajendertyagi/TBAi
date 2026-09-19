import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { useSettingsStore } from "./index";
import type { ProviderConfig } from "../types";

const realFetch = globalThis.fetch;

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

function providerIds(): string[] {
  return useSettingsStore.getState().providers.map((p) => p.id);
}

beforeEach(() => {
  useSettingsStore.setState({
    providers: [],
    activeProviderId: null,
    selectedProviderId: null,
    selectedModelId: null,
    selectedReasoningLevel: null,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useSettingsStore.setState({
    providers: [],
    activeProviderId: null,
    selectedProviderId: null,
    selectedModelId: null,
    selectedReasoningLevel: null,
  });
});

describe("loadProviders failure retention (Phase 3.5)", () => {
  it("[P3-08a] network throw retains the previous providers (resolves, never throws)", async () => {
    useSettingsStore.getState().setProviders([makeProvider("p1", true)]);
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(
      useSettingsStore.getState().loadProviders(),
    ).resolves.toBeUndefined();
    expect(providerIds()).toEqual(["p1"]);
    expect(useSettingsStore.getState().activeProviderId).toBe("p1");
  });

  it("[P3-08b] !ok response retains data and never calls setProviders", async () => {
    useSettingsStore.getState().setProviders([makeProvider("p1", true)]);
    const origSet = useSettingsStore.getState().setProviders;
    let setCalls = 0;
    useSettingsStore.setState({
      setProviders: (p) => {
        setCalls += 1;
        origSet(p);
      },
    });
    try {
      globalThis.fetch = (async () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({ error: "x" }),
        }) as Response) as unknown as typeof fetch;
      await useSettingsStore.getState().loadProviders();
      expect(setCalls).toBe(0);
      expect(providerIds()).toEqual(["p1"]);
      expect(useSettingsStore.getState().activeProviderId).toBe("p1");
    } finally {
      useSettingsStore.setState({ setProviders: origSet });
    }
  });

  it("[P3-08c] confirmed ok response still replaces (control)", async () => {
    useSettingsStore.getState().setProviders([makeProvider("p1", true)]);
    const next = [makeProvider("p2", true)];
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => next,
      }) as Response) as unknown as typeof fetch;
    await useSettingsStore.getState().loadProviders();
    expect(providerIds()).toEqual(["p2"]);
    expect(useSettingsStore.getState().activeProviderId).toBe("p2");
  });
});
