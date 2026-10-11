const fs = require("fs");
const file = "C:/Users/RTPC/.opencode/plan/tbai-recovery/evidence/junit-F-sharedtree.xml";
const xml = fs.readFileSync(file, "utf8");
const parts = xml.split("<testcase");
const unesc = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const attr = (s, k) => { const r = new RegExp(k + '="([^"]*)"').exec(s); return r ? unesc(r[1]) : ""; };
let pass = 0, skip = 0, fail = 0;
for (let i = 1; i < parts.length; i++) {
  const chunk = parts[i];
  const gt = chunk.indexOf(">");
  if (gt === -1) continue;
  const attrs = chunk.slice(0, gt);
  const selfClosing = attrs.trimEnd().endsWith("/");
  let st = "pass";
  if (!selfClosing) {
    const end = chunk.indexOf("</testcase>");
    const body = end === -1 ? chunk.slice(gt) : chunk.slice(gt, end);
    if (/<skipped\b/.test(body)) st = "skip";
    else if (/<failure\b/.test(body)) st = "fail";
    else if (/<error\b/.test(body)) st = "error";
  }
  if (st === "pass") pass++; else if (st === "skip") skip++;
  else {
    fail++;
    console.log("FAIL  file : " + attr(attrs, "file"));
    console.log("      suite: " + attr(attrs, "classname"));
    console.log("      test : " + attr(attrs, "name"));
  }
}
console.log("\nparsed: pass=" + pass + " skip=" + skip + " fail=" + fail);