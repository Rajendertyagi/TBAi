/**
 * What is actually inside the main bundle?
 *
 * The renderer profile blamed per-frame streaming work, but a real trace shows
 * 2.4s of Script Evaluation attributed to ONE 3.5 MB chunk with ~75% of its
 * bytes unused. That is a bundle-composition question, not a hot-path question.
 *
 * Answers it from the sourcemap the profiling build already emits, without
 * decoding mappings or adding a trace-mapping dependency: `sources` names every
 * module that went into the chunk, and `sourcesContent[i].length` is a good
 * proxy for its share of the output (the profiling build is unminified, so
 * source length and generated length track closely).
 *
 * Usage: bun run scripts/bundle-contents.ts [dist-profile]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const dirName = process.argv[2] ?? path.join(process.cwd(), "web", "dist-profile", "assets");
const dir = path.resolve(dirName);

const maps = readdirSync(dir).filter((f) => f.endsWith(".map"));
if (maps.length === 0) {
  console.error(`no .map files in ${dir}`);
  process.exit(1);
}

/** Collapse a module path to its owning package, e.g. node_modules/a/b/c.js -> a/b. */
function owner(source: string): string {
  const norm = source.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("node_modules/");
  if (idx === -1) return norm.startsWith("../") ? norm.replace(/^(\.\.\/)+/, "") : norm;
  const rest = norm.slice(idx + "node_modules/".length);
  const parts = rest.split("/");
  return parts[0].startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

interface Row {
  pkg: string;
  bytes: number;
  files: number;
  top: string;
}

const rows: Row[] = [];
for (const file of maps) {
  const raw = readFileSync(path.join(dir, file), "utf8");
  const map = JSON.parse(raw) as { sources?: string[]; sourcesContent?: (string | null)[] };
  const sources = map.sources ?? [];
  const content = map.sourcesContent ?? [];
  const byPkg = new Map<string, Row>();

  sources.forEach((src, i) => {
    const size = (content[i] ?? "").length;
    if (size === 0) return;
    const pkg = owner(src);
    const row = byPkg.get(pkg) ?? { pkg, bytes: 0, files: 0, top: src };
    row.bytes += size;
    row.files += 1;
    byPkg.set(pkg, row);
  });

  const total = [...byPkg.values()].reduce((a, r) => a + r.bytes, 0);
  rows.push(...byPkg.values());
  console.log(`\n=== ${file}  (${sources.length} modules, ${(total / 1024 / 1024).toFixed(2)} MB of source) ===`);
  for (const r of [...byPkg.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 22)) {
    const mb = (r.bytes / 1024 / 1024).toFixed(2).padStart(6);
    const pct = ((r.bytes / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${mb} MB  ${pct.padStart(5)}%  ${r.files.toString().padStart(4)} files  ${r.pkg}`);
  }
}

/**
 * First-party sources, biggest first, for the chunk that carries the app.
 *
 * Grouping by package hides the decision that actually needs making. The
 * libraries in the main chunk are mostly genuinely required - React, the AI
 * SDK, assistant-ui all run on first paint. The avoidable weight is OUR route
 * components: a router with no `lazy()` ships every settings page, the
 * scheduler and the whole OpenCode Code mode to a user who opened a chat, and
 * none of that is visible until they navigate to it.
 */
function isFirstParty(source: string): boolean {
  return !source.includes("node_modules/");
}

if (rows.length > 0) {
  const merged = new Map<string, Row>();
  for (const r of rows) {
    const m = merged.get(r.pkg) ?? { pkg: r.pkg, bytes: 0, files: 0, top: r.top };
    m.bytes += r.bytes;
    m.files += r.files;
    merged.set(r.pkg, m);
  }
  const total = [...merged.values()].reduce((a, r) => a + r.bytes, 0);
  console.log(`\n=== ALL MAPS COMBINED (${(total / 1024 / 1024).toFixed(2)} MB of source) ===`);
  for (const r of [...merged.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 28)) {
    const mb = (r.bytes / 1024 / 1024).toFixed(2).padStart(6);
    const pct = ((r.bytes / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${mb} MB  ${pct.padStart(5)}%  ${r.files.toString().padStart(4)} files  ${r.pkg}`);
  }
}

// The main chunk specifically, because "what does the app evaluate on launch"
// is a different question from "what exists in the build". Selected by SIZE,
// not by name: several chunks are called `index-*.js`, and picking the first
// one alphabetically reported the mermaid chunk as "the main chunk" and
// attributed zero first-party files to a chunk that contains 1121 of them.
const mainMap = maps
  .filter((f) => f.startsWith("index-") && f.endsWith(".js.map"))
  .sort((a, b) => statSync(path.join(dir, b)).size - statSync(path.join(dir, a)).size)[0];
if (mainMap) {
  const map = JSON.parse(readFileSync(path.join(dir, mainMap), "utf8")) as {
    sources?: string[];
    sourcesContent?: (string | null)[];
  };
  const sources = map.sources ?? [];
  const content = map.sourcesContent ?? [];
  const own = sources
    .map((src, i) => ({ src, bytes: (content[i] ?? "").length }))
    .filter((r) => r.bytes > 0 && isFirstParty(r.src));
  const ownTotal = own.reduce((a, r) => a + r.bytes, 0);
  console.log(
    `\n=== FIRST-PARTY IN THE MAIN CHUNK (${mainMap}, ${own.length} files, ${(ownTotal / 1024 / 1024).toFixed(2)} MB) ===`,
  );
  for (const r of own.sort((a, b) => b.bytes - a.bytes).slice(0, 25)) {
    const kb = (r.bytes / 1024).toFixed(1).padStart(7);
    console.log(`  ${kb} KB  ${r.src.replace(/^(\.\.\/)+/, "")}`);
  }
}
