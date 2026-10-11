const fs = require("fs");
const path = require("path");
const WT = "D:/Temp/ai-chat-app";
const changed = ["routes/chat","routes/chat.ts","mcp/manager","context/limits","services/todos","config/providers","cache/verification","modelDiscovery","historyReconciler","schedulerExecution","routes/providers","sqliteResumableStore","direct-compact-command"];
const failing = [
  "tests/integration/core/e2e-build-integrity.test.ts",
  "tests/unit/services/browser.test.ts",
  "tests/unit/tooling/check-test-location.test.ts",
  "tests/unit/web/opencode/codeCompactConformance.test.ts",
];
for (const f of failing) {
  const p = path.join(WT, f);
  console.log("--- " + f);
  if (!fs.existsSync(p)) { console.log("    (absent)"); continue; }
  const src = fs.readFileSync(p, "utf8");
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m; const imps = [];
  while ((m = re.exec(src)) !== null) imps.push(m[1]);
  const hits = imps.filter((i) => changed.some((c) => i.includes(c)));
  if (hits.length) hits.forEach((h) => console.log("    TOUCHES: " + h));
  else console.log("    imports none of the 16 changed files (" + imps.length + " imports checked)");
}