/**
 * One-off migration: rewrite every standalone colour value in `globals.css` from
 * hex / rgb() to `oklch()`, so the whole stylesheet speaks one format.
 *
 * Scope is deliberately narrow: it only rewrites a declaration whose entire value
 * is a single parseable colour. Multi-line values (the elevation shadows, which
 * contain `rgb(0 0 0 / .10)` inside a longer shadow list) and non-colour values
 * (`--radius: 0.625rem`, `--glass-blur: 22px`) are left exactly as they are.
 *
 * The conversion is lossless — same colour, different notation — which is why it
 * is safe to run against the built-in Classic palette that users already see.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoWeb = resolve(import.meta.dirname, "..");
const { formatColor, parseColor } = await import(
  pathToFileURL(resolve(repoWeb, "src/features/appearance/theme-color.ts")).href
);

const target = resolve(repoWeb, "src/styles/globals.css");
const source = readFileSync(target, "utf8");

let converted = 0;
let skipped = 0;

// Only single-line `--token: <one colour>;` declarations.
const output = source.replace(
  /^(\s*--[a-z0-9-]+:\s*)([^;{}]+?)(;)(\s*(?:\/\*.*)?)$/gim,
  (match, prefix, value, semi, trailing) => {
    const trimmed = value.trim();
    // Never touch anything that references another token or is a calc chain.
    if (/var\(|calc\(|url\(|gradient/i.test(trimmed)) {
      skipped++;
      return match;
    }
    const parsed = parseColor(trimmed);
    if (!parsed) {
      skipped++;
      return match;
    }
    const next = formatColor(trimmed);
    if (next === trimmed) return match;
    converted++;
    return `${prefix}${next}${semi}${trailing}`;
  },
);

writeFileSync(target, output);

const remaining = {
  hex: (output.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length,
  oklch: (output.match(/oklch\(/g) ?? []).length,
  rgb: (output.match(/\brgba?\(/g) ?? []).length,
};
console.log(`converted ${converted} declarations, skipped ${skipped}`);
console.log("remaining:", JSON.stringify(remaining));