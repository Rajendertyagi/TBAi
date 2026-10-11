const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WT = "D:/Temp/ai-chat-app";
const S4 = "C:/Users/RTPC/.opencode/plan/tbai-recovery/scratch/proposed-commit2";
const norm = (s) => s.replace(/\r\n/g, "\n");
const h = (s) => crypto.createHash("sha256").update(norm(s)).digest("hex");
const rel = process.argv.slice(2);
let eolOnly = 0, real = [];
for (const r of rel) {
  const a = fs.readFileSync(path.join(S4, r), "utf8");
  const b = fs.readFileSync(path.join(WT, r), "utf8");
  if (h(a) !== h(b)) real.push(r);
  else eolOnly++;
}
console.log("  EOL-only differences (semantically identical): " + eolOnly);
console.log("  REAL content differences: " + real.length);
for (const r of real) console.log("    " + r);