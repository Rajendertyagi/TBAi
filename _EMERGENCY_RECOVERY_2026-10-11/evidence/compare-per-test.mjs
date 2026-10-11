/**
 * Per-test comparison of two `bun test --reporter=junit` captures.
 *
 * WHY junit and not the console reporter: bun's console reporter TRUNCATES long
 * test names (~80 chars). Two distinct tests can then share an identity string,
 * which would silently hide a regression. junit XML carries the full name plus
 * the classname (file), so identity is exact.
 *
 * Aggregate counts cannot prove that no individual test regressed: an unrelated
 * fail->pass and an unrelated pass->fail cancel out and still show "+16/-16".
 * This compares by identity and reports every category.
 *
 * Usage: bun compare-per-test.mjs <configA.xml> <configB.xml>
 */
import { readFileSync } from "node:fs";

const UNESC = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const unescape = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => UNESC[m]).replace(/&#(\d+);/g, (_, d) =>
    String.fromCharCode(Number(d))
  );

/** Parse junit XML into a Map<"classname :: name", "pass"|"fail"|"skip">. */
function parse(file) {
  const out = new Map();
  const ids = new Map();
  const xml = readFileSync(file, "utf8");

  const attr = (s, k) => {
    const r = new RegExp(`${k}="([^"]*)"`).exec(s);
    return r ? unescape(r[1]) : "";
  };

  // Bun emits MOST testcases self-closing (<testcase ... />) and only the
  // non-passing ones as an open/close pair. A regex that expects a closing tag
  // for every case therefore matches almost nothing, so split on the opening
  // tag instead and decide self-closing vs paired by what follows it.
  const parts = xml.split("<testcase");
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    // The attribute text runs to the first '>' that ends the opening tag.
    const gt = chunk.indexOf(">");
    if (gt === -1) continue;
    const attrs = chunk.slice(0, gt);
    const selfClosing = attrs.trimEnd().endsWith("/");

    let status = "pass";
    if (!selfClosing) {
      // Only non-passing cases have children; find the case's own closing tag.
      const end = chunk.indexOf("</testcase>");
      const body = end === -1 ? chunk.slice(gt) : chunk.slice(gt, end);
      if (/<skipped\b/.test(body)) status = "skip";
      else if (/<failure\b/.test(body)) status = "fail";
      else if (/<error\b/.test(body)) status = "error";
    }

    // Tests can share classname+name (parametrised suites, nested describes), so
    // collapse them with an occurrence index. Without this, distinct tests merge
    // into one id and the comparison silently loses them.
    const key = `${attr(attrs, "file") || attr(attrs, "classname") || "?"} :: ${
      attr(attrs, "classname") || "?"
    } :: ${attr(attrs, "name")}`;
    const n = (out.get(key) ?? 0) + 1;
    out.set(key, n);
    ids.set(`${key}#${n}`, status);
  }
  return ids;
}

const [, , aPath, bPath] = process.argv;
if (!aPath || !bPath) {
  console.error("usage: bun compare-per-test.mjs <configA.xml> <configB.xml>");
  process.exit(2);
}

const a = parse(aPath);
const b = parse(bPath);

const failToPass = [];
const passToFail = [];
const added = [];
const removed = [];
const skipChanges = [];
const other = [];

for (const [id, sa] of a) {
  const sb = b.get(id);
  if (sb === undefined) {
    removed.push(`${id}  (was ${sa})`);
    continue;
  }
  if (sa === sb) continue;
  if (sa === "fail" && sb === "pass") failToPass.push(id);
  else if (sa === "pass" && sb === "fail") passToFail.push(id);
  else if (sa === "skip" || sb === "skip") skipChanges.push(`${id}  ${sa} -> ${sb}`);
  else other.push(`${id}  ${sa} -> ${sb}`);
}
for (const [id, sb] of b) if (!a.has(id)) added.push(`${id}  (${sb})`);

const show = (label, arr) => {
  console.log(`\n=== ${label}: ${arr.length} ===`);
  for (const x of arr.slice(0, 40)) console.log("  " + x);
  if (arr.length > 40) console.log(`  ... and ${arr.length - 40} more`);
};

console.log("A = " + aPath + "  tests=" + a.size);
console.log("B = " + bPath + "  tests=" + b.size);
console.log("\n(NOTE: A is the FIXED config, B is the UNFIXED config. A test that");
console.log(" passes in A and fails in B is one the fix REPAIRS, not a regression.)");

show("repaired by the fix (pass in A -> fail in B)", passToFail);
show("BROKEN by the fix (fail in A -> pass in B)", failToPass);
show("added in B", added);
show("removed in B", removed);
show("skip-state changes", skipChanges);
show("other status changes", other);

console.log("\n=== VERDICT ===");
console.log("  repaired by fix : " + passToFail.length);
console.log("  broken by fix   : " + failToPass.length);
console.log("  added in B      : " + added.length);
console.log("  removed in B    : " + removed.length);
console.log(
  failToPass.length === 0 && added.length === 0 && removed.length === 0
    ? "  CLEAN: the fix broke nothing, added nothing, removed nothing."
    : "  NOT CLEAN: see the categories above."
);