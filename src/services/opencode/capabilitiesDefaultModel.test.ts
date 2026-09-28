import { describe, expect, it, mock } from "bun:test";

/**
 * The default-model half of capability discovery.
 *
 * Separate from `capabilities.test.ts` because that file's stub client predates
 * the `model.default` call and answers without it. Two seams, same as there:
 * `openCodeServerManager.ensureBaseUrl` for process ownership and
 * `./client` for the official V2 client. No process is spawned, no network I/O.
 *
 * What is pinned:
 *  1. The default is resolved and carried — without it a brand-new Code
 *     conversation has no model bound and its turn does nothing.
 *  2. A missing or failing default must not take the picker with it.
 *  3. The descriptor must not carry `settings`, which is where
 *     `/api/model/default` puts the provider's API key in plaintext.
 */

const secret = "sk-must-not-escape-this-module";

let listModels: unknown[] = [];
let defaultModel: unknown = null;
let defaultShouldThrow = false;

mock.module("./client", () => ({
  createOpenCodeClient: () => ({
    agent: { list: async () => ({ data: [{ id: "build", name: "Build" }] }) },
    model: {
      list: async () => ({ data: listModels }),
      default: async () => {
        if (defaultShouldThrow) throw new Error("no default here");
        return { data: defaultModel };
      },
    },
  }),
}));

const { openCodeServerManager } = await import("./serverManager");
const { getOpenCodeCapabilities } = await import("./capabilities");

(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> })
  .ensureBaseUrl = () => Promise.resolve("http://127.0.0.1:0");

function reset() {
  listModels = [];
  defaultModel = null;
  defaultShouldThrow = false;
}

const model = (over: Record<string, unknown> = {}) => ({
  id: "perceptron/perceptron-mk1.5",
  name: "Perceptron Mk1.5",
  providerID: "openrouter",
  ...over,
});

describe("the server's advertised default model", () => {
  it("is carried, so a conversation with no stored choice can still run", async () => {
    reset();
    defaultModel = model();
    const caps = await getOpenCodeCapabilities();
    expect(caps.defaultModel).toEqual({
      providerID: "openrouter",
      modelID: "perceptron/perceptron-mk1.5",
      name: "Perceptron Mk1.5",
    });
  });

  it("never carries the credentials the default response includes", async () => {
    // `/api/model/default` returns `settings.apiKey` in the body. The descriptor
    // is the only thing allowed across this boundary.
    reset();
    defaultModel = model({ settings: { apiKey: secret, baseURL: "https://example.invalid" } });
    const caps = await getOpenCodeCapabilities();
    expect(JSON.stringify(caps)).not.toContain(secret);
    expect(caps.defaultModel).not.toHaveProperty("settings");
  });

  it("falls back to the id when the default has no usable name", async () => {
    reset();
    defaultModel = model({ name: "" });
    const caps = await getOpenCodeCapabilities();
    expect(caps.defaultModel?.name).toBe("perceptron/perceptron-mk1.5");
  });

  it("is omitted when the server reports none — and the picker survives", async () => {
    reset();
    listModels = [model()];
    defaultModel = null;
    const caps = await getOpenCodeCapabilities();
    expect(caps.defaultModel).toBeUndefined();
    // Non-vacuity: the models really did arrive. Losing the default cost the
    // convenience, never the picker.
    expect(caps.models).toHaveLength(1);
    expect(caps.agents).toHaveLength(1);
  });

  it("is omitted when the endpoint fails — and the picker survives", async () => {
    reset();
    listModels = [model(), model({ id: "agnes-3.0-flash", providerID: "agnes" })];
    defaultShouldThrow = true;
    const caps = await getOpenCodeCapabilities();
    expect(caps.defaultModel).toBeUndefined();
    expect(caps.models).toHaveLength(2);
  });

  it("is omitted for a response that is not a usable model", async () => {
    reset();
    for (const bad of [{ providerID: "openrouter" }, { modelID: "x" }, { providerID: "", modelID: "x" }, "nope", 42]) {
      defaultModel = bad;
      expect((await getOpenCodeCapabilities()).defaultModel).toBeUndefined();
    }
  });
});
