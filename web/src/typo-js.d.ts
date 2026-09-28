/**
 * Ambient types for `typo-js`, which ships no typings of its own.
 *
 * `@types/typo-js` exists but declares this package with `export =` (CommonJS).
 * `web/tsconfig.json` compiles with `module: "ESNext"` and no
 * `esModuleInterop`, so a CJS-style declaration is unusable here and the
 * `esModuleInterop` escape hatch would change resolution for the entire web
 * build — far wider than the one caller that needs the library. This local
 * declaration keeps the dependency surface to `typo-js` alone.
 *
 * Only the members TBAi actually calls are declared. `check`/`suggest` are
 * the documented single-word entry points; the compound APIs (`lookupCompound`,
 * `wordSegmentation`) are intentionally absent because the composer checks one
 * word at a time, and an undeclared member is a type error rather than an
 * accident.
 */
declare module "typo-js" {
  /**
   * A Hunspell-style dictionary. Constructed with preloaded `affData` and
   * `wordsData`, which is what lets it run offline in the browser: Typo.js
   * only reaches for `XMLHttpRequest`/`fs` when those two arguments are
   * omitted.
   */
  export default class Typo {
    /**
     * @param dictionary - Locale code of the dictionary, e.g. `"en_US"`. Only
     *   used for logging/auto-load when data is preloaded.
     * @param affData - Contents of the dictionary's `.aff` file.
     * @param wordsData - Contents of the dictionary's `.dic` file.
     */
    constructor(
      dictionary?: string,
      affData?: string | null,
      wordsData?: string | null,
    );

    /** True once the `.aff` and `.dic` data have been parsed into the table. */
    loaded: boolean;

    /**
     * Whether the word is spelled correctly, allowing for capitalisation
     * variants (an ALL-CAPS or Capitalised spelling of a known word passes).
     *
     * @throws If called before the dictionary finished loading.
     */
    check(word: string): boolean;

    /**
     * Ranked corrections for a misspelling. Returns `[]` when the word is
     * already correct.
     *
     * @throws If called before the dictionary finished loading.
     */
    suggest(word: string, limit?: number): string[];
  }
}
