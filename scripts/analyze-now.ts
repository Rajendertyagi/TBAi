// SCRATCH: structural analysis of captured Gemini body (redacted).
import fs from "fs";
const file = process.argv[2] ?? "D:\\Temp\\gemini-capture-z6.json";
const calls = JSON.parse(fs.readFileSync(file, "utf8"));
for (const { url, body } of calls) {
  console.log("URL:", String(url).split("?")[0].split("/").slice(-1)[0]);
  const b = body as Record<string, any>;
  const contents = b.contents ?? [];
  console.log(`nContents=${contents.length}`);
  contents.forEach((m: any, i: number) => {
    const parts = (m.parts ?? []).map((p: any) => {
      const k = Object.keys(p).join("+");
      let extra = "";
      if (p.functionCall) extra = ` fn=${p.functionCall.name}`;
      if (p.functionResponse) extra = ` fr=${p.functionResponse.name}`;
      if (p.text !== undefined) extra = ` textLen=${String(p.text).length}`;
      return `${k}${extra}`;
    });
    console.log(` [${i}] role=${m.role} parts: ${parts.join(" | ") || "(EMPTY)"}`);
  });
}
