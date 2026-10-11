const fs = require("fs");
// 1. Did codeCompactConformance already fail in the PRE-INTEGRATION isolated capture?
const E = "C:/Users/RTPC/.opencode/plan/tbai-recovery/evidence/junit-E-fixAB.xml";
const xml = fs.readFileSync(E, "utf8");
const parts = xml.split("<testcase");
const attr = (s, k) => { const r = new RegExp(k + '="([^"]*)"').exec(s); return r ? r[1] : ""; };
let found = [];
for (let i = 1; i < parts.length; i++) {
  const chunk = parts[i];
  const gt = chunk.indexOf(">");
  if (gt === -1) continue;
  const attrs = chunk.slice(0, gt);
  if (!/codeCompactConformance/.test(attrs)) continue;
  const selfClosing = attrs.trimEnd().endsWith("/");
  let st = "pass";
  if (!selfClosing) {
    const end = chunk.indexOf("</testcase>");
    const body = end === -1 ? chunk.slice(gt) : chunk.slice(gt, end);
    if (/<skipped\b/.test(body)) st = "skip";
    else if (/<failure\b/.test(body)) st = "fail";
  }
  found.push({ st, name: attr(attrs, "name") });
}
console.log("PRE-INTEGRATION capture (junit-E-fixAB.xml = isolated copy, Fix A+B, no integration):");
console.log("  codeCompactConformance testcases: " + found.length);
for (const f of found) console.log("    " + f.st.toUpperCase() + "  " + f.name.slice(0, 90));