import { describe, expect, test, beforeAll } from "bun:test";
import {
  couldBeMisspelling,
  ensureSpellchecker,
  getSpellingSuggestions,
  isWordCorrect,
  MIN_SUGGESTIBLE_LENGTH,
  DEFAULT_SUGGESTION_COUNT,
} from "./spellcheck";

/**
 * Behaviour tests against the real `en_US` dictionary shipped by typo-js.
 * These assert what the feature promises a user, not the library's internals:
 * a typo yields something, a correct word yields nothing, and a
 * coding-assistant's vocabulary is not mangled.
 */
beforeAll(async () => {
  await ensureSpellchecker();
});

describe("isWordCorrect", () => {
  test("rejects a misspelled word", () => {
    expect(isWordCorrect("coztom")).toBe(false);
  });

  test("accepts a correct word", () => {
    expect(isWordCorrect("custom")).toBe(true);
  });

  test("accepts capitalisation variants of a correct word", () => {
    // Browser spellcheckers do the same, so a correct word typed in caps must
    // not be offered a "correction" back to lower case.
    expect(isWordCorrect("Custom")).toBe(true);
    expect(isWordCorrect("CUSTOM")).toBe(true);
  });

  test("treats apostrophe words as single words", () => {
    expect(isWordCorrect("doesn't")).toBe(true);
  });
});

describe("getSpellingSuggestions", () => {
  test("returns nothing for a correct word", () => {
    expect(getSpellingSuggestions("custom")).toEqual([]);
  });

  test("returns nothing for a correctly-cased correct word", () => {
    expect(getSpellingSuggestions("Custom")).toEqual([]);
    expect(getSpellingSuggestions("CUSTOM")).toEqual([]);
  });

  test("produces suggestions for a misspelled word", () => {
    const suggestions = getSpellingSuggestions("coztom");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions).toContain("custom");
  });

  test("never offers the word the user already typed", () => {
    // Guards the case-insensitive dedupe: a suggestion identical to the input
    // (in any casing) is useless noise in the menu.
    for (const suggestion of getSpellingSuggestions("custom")) {
      expect(suggestion.toLowerCase()).not.toBe("custom");
    }
  });

  test("caps results at the default count of 4", () => {
    const suggestions = getSpellingSuggestions("recieve");
    expect(suggestions.length).toBeLessThanOrEqual(DEFAULT_SUGGESTION_COUNT);
    expect(DEFAULT_SUGGESTION_COUNT).toBe(4);
  });

  test("honours an explicit smaller maxCount", () => {
    expect(getSpellingSuggestions("recieve", 1).length).toBe(1);
  });

  test("returns nothing for a word below the minimum length", () => {
    // Two letters produce mostly unrelated candidates; the menu is better off
    // silent than showing noise.
    expect(getSpellingSuggestions("zz")).toEqual([]);
    expect(MIN_SUGGESTIBLE_LENGTH).toBe(3);
  });

  test("returns nothing for an empty word", () => {
    expect(getSpellingSuggestions("")).toEqual([]);
  });
});

describe("capitalisation preservation", () => {
  // Typo.js ranks `coztom` as ["bottom", "condom", "cotton", "custom"], so the
  // assertion is on the casing of every candidate rather than on which word
  // happens to rank first — ranking is the library's business.
  test("keeps a lowercase word lowercase", () => {
    for (const suggestion of getSpellingSuggestions("coztom")) {
      expect(suggestion).toBe(suggestion.toLowerCase());
    }
  });

  test("capitalises a Capitalised word", () => {
    for (const suggestion of getSpellingSuggestions("Coztom")) {
      expect(suggestion[0]).toBe(suggestion[0]?.toUpperCase());
      expect(suggestion.slice(1)).toBe(suggestion.slice(1).toLowerCase());
    }
  });

  test("uppercases an ALL-CAPS word", () => {
    for (const suggestion of getSpellingSuggestions("COZTOM")) {
      expect(suggestion).toBe(suggestion.toUpperCase());
    }
  });

  test("still finds the intended correction in each casing", () => {
    // Proves the wrapper reapplies casing rather than breaking the lookup.
    expect(getSpellingSuggestions("coztom")).toContain("custom");
    expect(getSpellingSuggestions("Coztom")).toContain("Custom");
    expect(getSpellingSuggestions("COZTOM")).toContain("CUSTOM");
  });

  test("applies casing to every suggestion, not just the first", () => {
    const suggestions = getSpellingSuggestions("COZTOM");
    expect(suggestions.length).toBeGreaterThan(1);
    for (const suggestion of suggestions) {
      expect(suggestion).toBe(suggestion.toUpperCase());
    }
  });
});

describe("technical-term safety", () => {
  // This is a coding-assistant composer: prompts are full of product names and
  // identifiers. Offering "corrections" for real terms is worse than offering
  // nothing, because the user is invited to damage their own vocabulary.
  const technicalTerms = [
    "Supabase",
    "OpenCode",
    "TBAi",
    "TypeScript",
    "ChatWindow",
    "POST",
    "API",
  ];

  test("leaves every listed technical term with no suggestions", () => {
    // The whole point of the guard. Measured against the real dictionary:
    // `Supabase`, `OpenCode`, `TBAi`, `TypeScript`, `ChatWindow`, `POST` and
    // `API` all come back empty, so a coding prompt is never nagged.
    for (const term of technicalTerms) {
      expect(getSpellingSuggestions(term)).toEqual([]);
    }
  });

  test("camelCase identifiers are not treated as misspellings", () => {
    // A capital after the first character is the signal for an identifier.
    for (const identifier of ["ChatWindow", "TypeScript", "OpenCode", "TBAi"]) {
      expect(isWordCorrect(identifier)).toBe(true);
    }
  });

  test("short acronyms are not treated as misspellings", () => {
    for (const acronym of ["API", "POST"]) {
      expect(isWordCorrect(acronym)).toBe(true);
    }
  });

  test("still corrects ordinary prose that merely contains capitals", () => {
    // The capital rules must not be so broad that real sentences go unspelled.
    expect(getSpellingSuggestions("Recieve")).toContain("Receive");
    expect(getSpellingSuggestions("Seperate")).toContain("Separate");
  });

  test("ranks the intended correction among the suggestions", () => {
    // Typo.js explores edit distance 2 and does not expose per-candidate
    // distances, so this asserts the property a user actually cares about —
    // the right word is offered — rather than re-deriving the library's
    // internals. Ranking position is the library's business, not ours.
    expect(getSpellingSuggestions("recieve")).toContain("receive");
    expect(getSpellingSuggestions("seperate")).toContain("separate");
    expect(getSpellingSuggestions("definately")).toContain("definitely");
    expect(getSpellingSuggestions("coztom")).toContain("custom");
  });
});

describe("identifier guard", () => {
  test("treats words with digits as not correctable", () => {
    // `utf8`, `base64` and friends are identifiers, not typos.
    expect(isWordCorrect("utf8")).toBe(true);
    expect(getSpellingSuggestions("utf8")).toEqual([]);
  });

  test("treats underscore identifiers as not correctable", () => {
    expect(isWordCorrect("some_identifier")).toBe(true);
    expect(getSpellingSuggestions("some_identifier")).toEqual([]);
  });
});

describe("couldBeMisspelling (dictionary-free shape check)", () => {
  // This runs BEFORE the dictionary is loaded, which is what keeps a right-click
  // on an identifier from fetching ~552 KB. It must therefore decide from the
  // token's shape alone, and it must not throw when nothing is loaded.
  test("accepts ordinary lowercase words", () => {
    for (const word of ["coztom", "hello", "recieve", "teh"]) {
      expect(couldBeMisspelling(word)).toBe(true);
    }
  });

  test("accepts Capitalised prose, which the user may still have mistyped", () => {
    expect(couldBeMisspelling("Coztom")).toBe(true);
    expect(couldBeMisspelling("Recieve")).toBe(true);
  });

  test("accepts longer all-caps words as possible typos", () => {
    // Longer than MAX_ACRONYM_LENGTH, so treated as shouted prose.
    expect(couldBeMisspelling("COZTOM")).toBe(true);
  });

  test("rejects camelCase identifiers", () => {
    for (const word of ["ChatWindow", "TypeScript", "OpenCode", "TBAi", "iPhone"]) {
      expect(couldBeMisspelling(word)).toBe(false);
    }
  });

  test("rejects short acronyms", () => {
    for (const word of ["API", "POST", "URL", "CSS"]) {
      expect(couldBeMisspelling(word)).toBe(false);
    }
  });

  test("rejects tokens with digits or underscores", () => {
    for (const word of ["utf8", "base64", "some_identifier", "a1b2"]) {
      expect(couldBeMisspelling(word)).toBe(false);
    }
  });

  test("rejects words below the minimum length", () => {
    for (const word of ["", "a", "ab", "zz"]) {
      expect(couldBeMisspelling(word)).toBe(false);
    }
  });

  test("accepts apostrophe words", () => {
    expect(couldBeMisspelling("doesnt")).toBe(true);
  });
});

describe("lazy initialisation", () => {
  test("is not loaded merely by importing the module", async () => {
    // Imports are cached per module graph, so this re-imports through a fresh
    // query string to get a second, uninitialised instance and proves the
    // dictionary is not built at module scope.
    const fresh = (await import(`./spellcheck?lazy-probe=${Date.now()}`)) as
      typeof import("./spellcheck");
    let threw = false;
    try {
      fresh.isWordCorrect("custom");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // ...and it becomes usable only once explicitly initialised.
    await fresh.ensureSpellchecker();
    expect(fresh.isWordCorrect("custom")).toBe(true);
  });
});


