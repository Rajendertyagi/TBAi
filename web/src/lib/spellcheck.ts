/**
 * Local, offline spelling for the composer.
 *
 * Owns `typo-js` end to end: the UI never imports the library, and only the
 * four members TBAi uses are exposed here. The dictionary ships with the
 * package and is inlined by Vite, so nothing leaves the machine and no
 * spell-check service is contacted.
 *
 * The dictionary is ~552 KB of text that has to be parsed into a lookup table,
 * which is far too much work to do just because a menu component was
 * imported. It is therefore loaded on demand by {@link ensureSpellchecker} and
 * awaited by the caller, after which the lookup helpers below are
 * synchronous — see `word-suggestions.ts` for the word/caret arithmetic that
 * pairs with them.
 */
import Typo from "typo-js";

/**
 * The dictionary payload, loaded on demand.
 *
 * Both files are dynamic `?raw` imports rather than top-level ones. A static
 * import would be inlined into the main entry chunk, so the 552 KB `.dic` would
 * ship in the initial bundle and be downloaded by every visitor whether or not
 * they ever right-click a word. As dynamic imports Vite emits them as separate
 * chunks that are only fetched when {@link ensureSpellchecker} first runs.
 *
 * `en_US` is the only dictionary read: the package also ships `it`, and the
 * compound/bigram machinery Typo.js loads for `lookupCompound` is never used
 * because the composer checks a single word.
 */
async function loadDictionaryData(): Promise<{ aff: string; dic: string }> {
  const [aff, dic] = await Promise.all([
    import("typo-js/dictionaries/en_US/en_US.aff?raw"),
    import("typo-js/dictionaries/en_US/en_US.dic?raw"),
  ]);
  return { aff: aff.default, dic: dic.default };
}

/** The only locale shipped for the composer's dictionary. */
const DICTIONARY_LOCALE = "en_US";

/**
 * How many suggestions a lookup returns unless the caller asks for fewer.
 * Kept at the value the menu actually renders, so the common path allocates
 * one small array instead of one plus a slice.
 */
export const DEFAULT_SUGGESTION_COUNT = 4;

/**
 * Words shorter than this produce nothing. Below roughly three letters the
 * dictionary's own distance-1 candidates are mostly unrelated (`co` → `co`,
 * `do`, `go`, `so`), which is noise rather than a correction.
 */
export const MIN_SUGGESTIBLE_LENGTH = 3;

/**
 * The loaded dictionary, or `null` until {@link ensureSpellchecker} has built
 * it. Module scope rather than component state: the dictionary is a
 * process-wide singleton and rebuilding it per menu open would re-parse half a
 * megabyte on every right-click.
 */
let dictionary: Typo | null = null;

/**
 * The in-flight load, shared so that two menus opening at once trigger one
 * parse rather than two. Cleared on failure so a transient error does not
 * permanently disable spelling.
 */
let loading: Promise<Typo> | null = null;

/**
 * Loads and parses the dictionary, or returns the already-loaded one.
 *
 * Idempotent and safe to call concurrently: the first caller starts the work
 * and every later caller awaits the same promise.
 *
 * @returns The ready dictionary.
 * @throws If the dictionary data cannot be imported or parsed. Callers treat
 *   this as "no suggestions available" — a missing dictionary degrades the
 *   menu, it does not break the composer.
 */
export async function ensureSpellchecker(): Promise<Typo> {
  if (dictionary) return dictionary;
  if (loading) return loading;
  loading = (async () => {
    // The `.aff`/`.dic` pairs arrive as already-resolved strings from Vite's
    // `?raw` imports, which is precisely the constructor path that skips
    // Typo.js's `XMLHttpRequest`/`fs` file reading and stays offline.
    const { aff, dic } = await loadDictionaryData();
    const loaded = new Typo(DICTIONARY_LOCALE, aff, dic);
    dictionary = loaded;
    return loaded;
  })();
  try {
    return await loading;
  } catch (error) {
    loading = null;
    throw error;
  } finally {
    // The promise is only needed to dedupe in-flight callers; a resolved
    // dictionary is served by the `dictionary` check above.
    loading = null;
  }
}

/** Test seam: forget any loaded dictionary. Not used by application code. */
export function resetSpellcheckerForTests(): void {
  dictionary = null;
  loading = null;
}

/**
 * The capitalisation of a word, as a shape to reapply to a correction.
 *
 * Typo.js preserves capitalisation internally, but it only recognises
 * lowercase, Capitalised and ALL-CAPS. Anything mixed (`iPhone`, `eBay`) falls
 * through its own logic and comes back lowercased, so the shape is tracked
 * here and reapplied afterwards.
 */
type WordCase = "lower" | "capitalized" | "upper" | "mixed";

/**
 * Classifies a word's capitalisation. `mixed` covers words that are neither
 * all-lower, Capitalised, nor ALL-CAPS; those keep whatever the dictionary
 * returned, since inventing a casing for them would be a guess.
 */
function detectCase(word: string): WordCase {
  if (word === word.toLowerCase()) return "lower";
  if (word === word.toUpperCase()) return "upper";
  if (word[0] === word[0]?.toUpperCase() && word.slice(1) === word.slice(1).toLowerCase()) {
    return "capitalized";
  }
  return "mixed";
}

/**
 * Reapplies the original word's capitalisation to a correction.
 *
 * Deterministic and applied outside the dictionary, so the shipped word list is
 * never mutated to suit a caller.
 */
function applyCase(suggestion: string, wordCase: WordCase, original: string): string {
  switch (wordCase) {
    case "lower":
      return suggestion.toLowerCase();
    case "upper":
      return suggestion.toUpperCase();
    case "capitalized":
      return suggestion.charAt(0).toUpperCase() + suggestion.slice(1).toLowerCase();
    case "mixed":
      // Keep the correction as the dictionary ranked it, but never let it
      // silently drop the original's interior capitals.
      return suggestion.length === original.length ? suggestion : original;
  }
}

/**
 * Whether a word is spelled correctly.
 *
 * Capitalisation variants of a known word count as correct (`Custom` for
 * `custom`), matching Typo.js. Words carrying digits or code punctuation are
 * reported correct so that identifiers like `utf8` are never offered a
 * "correction" — see {@link getSpellingSuggestions}.
 *
 * @param word - The word to check. Compared case-insensitively by the
 *   dictionary's own rules.
 * @returns `true` when the dictionary knows the word.
 * @throws If the dictionary is not loaded. Call {@link ensureSpellchecker}
 *   first.
 */
export function isWordCorrect(word: string): boolean {
  if (!couldBeMisspelling(word)) return true;
  const loaded = requireDictionary();
  return loaded.check(word);
}

/**
 * Ranked spelling corrections for a single word.
 *
 * Returns `[]` for a word that is already correct, for a word too short to
 * correct meaningfully, and for a word the dictionary has nothing useful to
 * offer. That last case is what keeps technical terms quiet: the shipped
 * `en_US` list is general English, so a product name like `Supabase` is simply
 * unknown to it, and the fix here is to show nothing rather than to bolt on a
 * custom dictionary.
 *
 * @param word - The misspelled word.
 * @param maxCount - Maximum suggestions to return, defaulting to
 *   {@link DEFAULT_SUGGESTION_COUNT}.
 * @returns Up to `maxCount` corrections, each carrying the original word's
 *   capitalisation. Empty when there is no useful correction.
 * @throws If the dictionary is not loaded. Call {@link ensureSpellchecker}
 *   first.
 */
export function getSpellingSuggestions(
  word: string,
  maxCount: number = DEFAULT_SUGGESTION_COUNT,
): string[] {
  if (!couldBeMisspelling(word)) return [];
  const loaded = requireDictionary();
  if (loaded.check(word)) return [];
  const wordCase = detectCase(word);
  // Ask for a couple more than we need so that dropping near-duplicates
  // (case variants of one candidate) can still fill the requested count.
  const candidates = loaded.suggest(word, maxCount * 2);
  const seen = new Set<string>();
  const results: string[] = [];
  for (const candidate of candidates) {
    const cased = applyCase(candidate, wordCase, word);
    const key = cased.toLowerCase();
    // Never offer the word the user already typed, in any casing.
    if (key === word.toLowerCase() || seen.has(key)) continue;
    seen.add(key);
    results.push(cased);
    if (results.length >= maxCount) break;
  }
  return results;
}

/** Longest all-caps run still treated as a word rather than an acronym. */
export const MAX_ACRONYM_LENGTH = 4;

/**
 * Whether a token could be a misspelling at all, using only its shape.
 *
 * Deliberately dictionary-free: this runs BEFORE the dictionary is loaded, so a
 * right-click on `TypeScript` or `utf8` is answered without fetching half a
 * megabyte. The rules are only about the shape of the token:
 *
 * - anything but letters and apostrophes is an identifier (`utf8`,
 *   `some_identifier`);
 * - an internal capital marks a camelCase identifier (`ChatWindow`,
 *   `TypeScript`, `OpenCode`);
 * - a short all-caps run is an acronym (`API`, `POST`), not a misspelling.
 *
 * Capitalised-only (`Coztom`) and longer all-caps words pass, because those are
 * ordinary prose that the user may well have mistyped.
 */
export function couldBeMisspelling(word: string): boolean {
  if (!/^[\p{L}']+$/u.test(word)) return false;
  if (word.length < MIN_SUGGESTIBLE_LENGTH) return false;
  if (word !== word.toLowerCase() && word !== word.toUpperCase()) {
    const isCapitalised =
      word[0] === word[0]?.toUpperCase() && word.slice(1) === word.slice(1).toLowerCase();
    if (!isCapitalised) return false;
  }
  if (word === word.toUpperCase() && word.length <= MAX_ACRONYM_LENGTH) return false;
  return true;
}

/**
 * Reads the loaded dictionary.
 *
 * @throws If called before {@link ensureSpellchecker} resolves. A clear error
 *   beats a silent "always misspelled", which would surface a bogus
 *   suggestion list.
 */
function requireDictionary(): Typo {
  if (!dictionary) {
    throw new Error("Spellcheck dictionary not loaded. Call ensureSpellchecker() first.");
  }
  return dictionary;
}
