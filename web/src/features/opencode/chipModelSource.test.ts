import { describe, expect, test } from "bun:test";
import {
  findChipModelInfo,
  qualifyChipModel,
  resolveChipModelSource,
  type ChipModelSourceInput,
} from "./chipModelSource";

/**
 * Regression coverage for the model chip's display source.
 *
 * THE EXACT BUG. The chip used to read only the conversation's persisted
 * `opencodeModel`. A session can be bound to a real model without ever writing
 * that column — the server-default path assigns the server's advertised
 * default during session creation. The verified symptom was a native session on
 * `openrouter/perceptron/perceptron-mk1.5` with `opencodeModel = null`,
 * rendering "Select a model".
 *
 * Every case below therefore sets the two sources DIFFERENTLY, or leaves the
 * stored one null. A test that put the same model in both would pass against the
 * buggy code and prove nothing.
 */

/** A bound-thread input, i.e. the state where the bug was observed. */
function bound(overrides: Partial<ChipModelSourceInput> = {}): ChipModelSourceInput {
  return { draft: false, storedModel: null, nativeModel: null, draftModel: "", ...overrides };
}

describe("resolveChipModelSource — the reported bug", () => {
  test("shows the native session model when the stored column is null", () => {
    // The exact verified state: conversation field empty, session bound.
    const shown = resolveChipModelSource(
      bound({ nativeModel: { providerID: "openrouter", modelID: "perceptron/perceptron-mk1.5" } }),
    );
    expect(shown).toBe("openrouter/perceptron/perceptron-mk1.5");
    // Non-vacuity: this is a real model id, not the unbound empty string that
    // the buggy code produced.
    expect(shown).not.toBe("");
  });

  test("treats an empty-string stored value as absent", () => {
    // The column is nullable but a previous write could leave "" — that must
    // not shadow the session's real model.
    expect(
      resolveChipModelSource(
        bound({ storedModel: "", nativeModel: { providerID: "anthropic", modelID: "claude-x" } }),
      ),
    ).toBe("anthropic/claude-x");
  });
});

describe("resolveChipModelSource — stored choice stays authoritative", () => {
  test("prefers the stored model when the native session reports a different one", () => {
    const shown = resolveChipModelSource(
      bound({
        storedModel: "google/gemini-pro",
        nativeModel: { providerID: "openrouter", modelID: "perceptron/perceptron-mk1.5" },
      }),
    );
    expect(shown).toBe("google/gemini-pro");
  });

  test("keeps the stored model even when the session is bound to nothing", () => {
    expect(resolveChipModelSource(bound({ storedModel: "google/gemini-pro" }))).toBe(
      "google/gemini-pro",
    );
  });
});

describe("resolveChipModelSource — the honest unbound state", () => {
  test("resolves to nothing when neither source has a model", () => {
    // "" is what makes the chip fall through to its existing "Select a model".
    expect(resolveChipModelSource(bound())).toBe("");
  });

  test("resolves to nothing for a stale or unavailable session", () => {
    // A stale session hydrates no native model, so the chip must NOT fabricate
    // one for display — the existing unbound state is the truthful answer.
    expect(resolveChipModelSource(bound({ nativeModel: undefined }))).toBe("");
  });

  test("ignores a native model missing its provider or id", () => {
    // Half a reference cannot be matched against the catalogue, and inventing
    // the missing half would be a guess presented as fact.
    expect(resolveChipModelSource(bound({ nativeModel: { providerID: "", modelID: "m" } }))).toBe("");
    expect(resolveChipModelSource(bound({ nativeModel: { providerID: "p", modelID: "" } }))).toBe("");
  });
});

describe("resolveChipModelSource — the draft surface is untouched", () => {
  test("uses the welcome-draft pick when no conversation is bound", () => {
    expect(
      resolveChipModelSource({
        draft: true,
        storedModel: null,
        nativeModel: { providerID: "p", modelID: "m" },
        draftModel: "google/gemini-pro",
      }),
    ).toBe("google/gemini-pro");
  });

  test("an empty draft pick stays empty even with a native model present", () => {
    expect(
      resolveChipModelSource({
        draft: true,
        storedModel: null,
        nativeModel: { providerID: "p", modelID: "m" },
        draftModel: "",
      }),
    ).toBe("");
  });
});

describe("findChipModelInfo — resolution through the live catalogue", () => {
  // Stands in for the real capabilities list, including a namespaced model id.
  const models = [
    { id: "perceptron/perceptron-mk1.5", providerID: "openrouter", name: "Perceptron 1.5" },
    { id: "gemini-pro", providerID: "google", name: "Gemini Pro" },
  ];

  test("resolves a native session model through the catalogue", () => {
    // The end-to-end display chain for the reported bug: native ref → qualified
    // id → catalogue entry with its display name.
    const shown = resolveChipModelSource(
      bound({ nativeModel: { providerID: "openrouter", modelID: "perceptron/perceptron-mk1.5" } }),
    );
    expect(findChipModelInfo(models, shown)?.name).toBe("Perceptron 1.5");
  });

  test("resolves a stored model through the catalogue", () => {
    expect(findChipModelInfo(models, resolveChipModelSource(bound({ storedModel: "google/gemini-pro" })))?.name).toBe(
      "Gemini Pro",
    );
  });

  test("falls back to a bare model id when the qualified form does not match", () => {
    expect(findChipModelInfo(models, "gemini-pro")?.providerID).toBe("google");
  });

  test("returns null for an unknown id instead of inventing metadata", () => {
    // A session bound to a model this install no longer lists: no name, no
    // provider, no crash — the chip shows the raw id, which is truthful.
    const shown = resolveChipModelSource(bound({ nativeModel: { providerID: "gone", modelID: "model" } }));
    expect(findChipModelInfo(models, shown)).toBeNull();
    expect(shown).toBe("gone/model");
  });

  test("returns null for the unbound state", () => {
    expect(findChipModelInfo(models, "")).toBeNull();
  });
});

describe("qualifyChipModel", () => {
  test("joins provider and id", () => {
    expect(qualifyChipModel({ providerID: "openrouter", modelID: "perceptron/perceptron-mk1.5" })).toBe(
      "openrouter/perceptron/perceptron-mk1.5",
    );
  });

  test("preserves a model id that itself contains a slash", () => {
    // OpenCode namespaces some models (`provider/sub/model`), so the join must
    // not split or flatten the id.
    expect(qualifyChipModel({ providerID: "openrouter", modelID: "a/b/c" })).toBe("openrouter/a/b/c");
  });

  test("returns empty for null, undefined, and partial references", () => {
    expect(qualifyChipModel(null)).toBe("");
    expect(qualifyChipModel(undefined)).toBe("");
    expect(qualifyChipModel({ providerID: "", modelID: "m" })).toBe("");
    expect(qualifyChipModel({ providerID: "p", modelID: "" })).toBe("");
  });
});
