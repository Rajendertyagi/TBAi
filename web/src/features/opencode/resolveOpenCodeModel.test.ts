import { describe, expect, it } from "bun:test";
import { resolveOpenCodeModel } from "./resolveOpenCodeModel";
import type { OpenCodeDefaultModel, OpenCodeModelOption } from "./useOpenCodeCapabilities";

/**
 * Which model a Code turn runs on.
 *
 * ## The defect this pins
 *
 * With nothing stored, this used to return `undefined` on the stated assumption
 * that the server's own default would apply. It did not: the session was created
 * with no model bound, the composer sat at "Select a model", and every turn did
 * nothing. The fix is to resolve the server's advertised default and send it
 * explicitly — so the test that matters most is the FIRST one: with no stored
 * preference, something real comes back.
 *
 * The second thing that matters is that the default is a FALLBACK. A reader who
 * chose a model keeps it, and the server cannot quietly override a choice.
 */

const MODELS: OpenCodeModelOption[] = [
  { id: "agnes-3.0-flash", name: "Agnes 3 Flash", providerID: "agnes", variants: [] },
  { id: "perceptron/perceptron-mk1.5", name: "Perceptron", providerID: "openrouter", variants: [] },
];

const SERVER_DEFAULT: OpenCodeDefaultModel = {
  providerID: "openrouter",
  modelID: "perceptron/perceptron-mk1.5",
  name: "Perceptron Mk1.5",
};

describe("resolveOpenCodeModel — nothing stored", () => {
  it("resolves the server's advertised default, so a new conversation can run", () => {
    // THE regression. Undefined here meant a blank composer and a dead turn.
    const resolved = resolveOpenCodeModel(null, MODELS, SERVER_DEFAULT);
    expect(resolved).toBeDefined();
    expect(resolved?.providerID).toBe("openrouter");
    expect(resolved?.modelID).toBe("perceptron/perceptron-mk1.5");
  });

  it("prefers the live catalogue's spelling of the default when it carries it", () => {
    // The catalogue is canonical: matching against it means the reference sent
    // matches exactly what the server calls the model, whatever the default
    // response spelled it.
    const resolved = resolveOpenCodeModel(undefined, MODELS, SERVER_DEFAULT);
    expect(resolved).toEqual({ providerID: "openrouter", modelID: "perceptron/perceptron-mk1.5" });
  });

  it("still uses a default the catalogue does not carry", () => {
    // A default the live list has not caught up with is still server-authoritative
    // and better than nothing. Rejecting it would reintroduce the blank state.
    const stale: OpenCodeDefaultModel = { providerID: "agnes", modelID: "agnes-9-future", name: "Future" };
    expect(resolveOpenCodeModel(null, [], stale)).toEqual({ providerID: "agnes", modelID: "agnes-9-future" });
  });

  it("resolves to nothing when the server advertises no default either", () => {
    // Both sources empty is the genuinely unconfigured case, and the honest
    // answer is still "unknown" — the reader picks. Not an error.
    expect(resolveOpenCodeModel(null, MODELS, undefined)).toBeUndefined();
    expect(resolveOpenCodeModel("", MODELS, undefined)).toBeUndefined();
  });
});

describe("resolveOpenCodeModel — a stored choice always wins", () => {
  it("keeps a provider-qualified stored choice over the default", () => {
    const resolved = resolveOpenCodeModel("agnes/agnes-3.0-flash", MODELS, SERVER_DEFAULT);
    expect(resolved).toEqual({ providerID: "agnes", modelID: "agnes-3.0-flash" });
    // Non-vacuity: this is a different model from the default.
    expect(resolved?.modelID).not.toBe(SERVER_DEFAULT.modelID);
  });

  it("keeps a bare stored id, resolved through the live catalogue", () => {
    expect(resolveOpenCodeModel("agnes-3.0-flash", MODELS, SERVER_DEFAULT))
      .toEqual({ providerID: "agnes", modelID: "agnes-3.0-flash" });
  });

  it("keeps a stored choice the catalogue has not caught up with", () => {
    const resolved = resolveOpenCodeModel("agnes/agnes-9-future", [], SERVER_DEFAULT);
    expect(resolved).toEqual({ providerID: "agnes", modelID: "agnes-9-future" });
  });
});
