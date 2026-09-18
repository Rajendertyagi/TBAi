/**
 * TEMPORARY live write/edit verification (deleted after the run).
 *
 * A gated `write` to an absolute path OUTSIDE the project (external_directory:
 * ask), approved through the UI, must create the file. A following gated `edit`
 * of that same file, approved, must change it and produce
 * `state.metadata.filediff.patch` plus a rendered diff.
 */
import { chromium } from "playwright";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const APP = "http://127.0.0.1:3000";
const CONV = "x9i31ff5kqi2i4mk83r9awx2";
const SID = "ses_f5141d7d0ffeLriWiDlrYrpl5k";
const TARGET = "C:\\Users\\RTPC\\AppData\\Local\\Temp\\opencode\\v2-live-write.txt";
const OUT = "C:\\Users\\RTPC\\AppData\\Local\\Temp\\opencode";
const LOG = `${OUT}\\live-write-edit.log`;

const traffic: Array<{ method: string; url: string; status?: number; body?: string }> = [];
const log = (...a: unknown[]) => {
  const line = `[we ${new Date().toISOString()}] ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`;
  appendFileSync(LOG, line);
  console.log(line.trimEnd());
};

type ToolPart = { tool?: string; callID?: string; state?: { status?: string; metadata?: unknown } };

const toolParts = async (): Promise<ToolPart[]> => {
  const r = await fetch(`${APP}/api/opencode/session/${SID}/message`);
  const j = (await r.json()) as Array<{ parts?: ToolPart[] }>;
  const out: ToolPart[] = [];
  for (const m of j) for (const p of m.parts ?? []) if ((p as { type?: string }).type === "tool") out.push(p);
  return out;
};

const prompt = async (text: string) => {
  const r = await fetch(`${APP}/api/opencode/session/${SID}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text }],
      model: { providerID: "opencode", modelID: "union-alpha" },
      agent: "build",
    }),
  });
  log("prompt", r.status, text.slice(0, 60));
};

async function main() {
  appendFileSync(LOG, "");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  page.on("request", (r) => {
    if (r.url().includes("/api/opencode/")) traffic.push({ method: r.method(), url: r.url(), body: r.postData() ?? undefined });
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/opencode/")) traffic.push({ method: r.request().method(), url: r.url(), status: r.status() });
  });
  await page.goto(`${APP}/#/code/${CONV}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea", { timeout: 90_000 });
  log("page ready");

  const approve = page.getByRole("button", { name: /^(approve|allow)\b/i }).first();
  const clickApprove = async (label: string, ms: number): Promise<boolean> => {
    try {
      await approve.waitFor({ timeout: ms });
    } catch {
      log(label, "card did NOT appear");
      return false;
    }
    await page.screenshot({ path: `${OUT}\\${label}-card.png`, fullPage: true });
    await approve.click();
    log(label, "clicked Approve");
    return true;
  };
  const waitTool = async (tool: string, ms: number): Promise<string> => {
    const deadline = Date.now() + ms;
    let status = "";
    while (Date.now() < deadline) {
      const p = (await toolParts()).filter((x) => x.tool === tool).pop();
      status = p?.state?.status ?? "";
      if (status && status !== "running") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    return status;
  };

  // ---------- WRITE (external => gated) ----------
  await prompt(
    `Use the write tool to create the absolute path ${TARGET} with the exact single-line contents V2_WRITE_OK. That path is outside the project directory. Then reply DONE.`,
  );
  const writeCard = await clickApprove("write", 420_000);
  const writeStatus = writeCard ? await waitTool("write", 180_000) : "no-card";
  const writeExists = existsSync(TARGET);
  const writeContent = writeExists ? readFileSync(TARGET, "utf8") : "";
  log("write", { writeCard, writeStatus, writeExists, writeContent: JSON.stringify(writeContent) });

  // ---------- EDIT (external => gated, produces a diff) ----------
  await prompt(
    `Use the edit tool on the absolute path ${TARGET} to replace the text V2_WRITE_OK with V2_EDIT_OK. That path is outside the project directory. Then reply DONE.`,
  );
  const editCard = await clickApprove("edit", 420_000);
  const editStatus = editCard ? await waitTool("edit", 180_000) : "no-card";
  const editContent = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
  const editPart = (await toolParts()).filter((x) => x.tool === "edit").pop();
  const metadata = (editPart?.state?.metadata ?? {}) as { filediff?: { patch?: string } };
  const patch = metadata.filediff?.patch ?? "";
  log("edit", { editCard, editStatus, editContent: JSON.stringify(editContent), patchLength: patch.length });
  log("patch", patch.slice(0, 800));

  const domDiff = await page.evaluate(() => {
    const t = document.body.innerText;
    return { hasHunks: t.includes("@@"), hasEditOk: t.includes("V2_EDIT_OK") };
  });
  log("domDiff", domDiff);
  await page.screenshot({ path: `${OUT}\\write-edit-final.png`, fullPage: true });

  const replies = traffic.filter((t) => /\/permission\/[^/]+\/reply/.test(t.url));
  const report = {
    write: { writeCard, writeStatus, writeExists, writeContent },
    edit: { editCard, editStatus, editContent, patchLength: patch.length, patch, domDiff },
    replies,
    repliesWithoutDirectory: replies.filter((t) => !t.url.includes("directory=")),
    fallbackCalls: traffic.filter((t) => /\/permissions\//.test(t.url)),
  };
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

main().catch((e) => {
  log("FAILED", String(e));
  process.exitCode = 1;
});
