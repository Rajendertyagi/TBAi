import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const log = (...args: unknown[]) => {
  try {
    appendFileSync(path.join(process.cwd(), "post-package.log"), args.join(" ") + "\n");
  } catch {
    // ignore logging failures
  }
};

log("post-package start", new Date().toISOString(), "cwd=", process.cwd());

const buildRoot = path.join(process.cwd(), "build");
if (!existsSync(buildRoot)) {
  log("no build dir at", buildRoot);
  process.exit(0);
}

// Find the <channel>-win-x64 output directory produced by `hutch electrobun build`.
// Prefer the one that actually contains the installer payload archive.
let outDir: string | null = null;
for (const ent of readdirSync(buildRoot)) {
  const p = path.join(buildRoot, ent);
  if (statSync(p).isDirectory() && ent.endsWith("-win-x64")) {
    if (existsSync(path.join(p, "TBAi-Setup.tar.zst"))) {
      outDir = p;
      break;
    }
    if (!outDir) outDir = p;
  }
}
if (!outDir) {
  log("no <channel>-win-x64 dir under", buildRoot);
  process.exit(0);
}

// Hutch emits a self-extracting installer (TBAi-Setup.exe) plus its payload
// (TBAi-Setup.tar.zst). The portable app lives INSIDE that archive, not in the
// TBAi/ self-extractor folder. Extract the tar.zst to recover the real app.
const archive = path.join(outDir, "TBAi-Setup.tar.zst");
if (!existsSync(archive)) {
  log("no TBAi-Setup.tar.zst in", outDir);
  process.exit(0);
}

const extractDir = path.join(outDir, "app-extract");
if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });

const tar = spawnSync("tar", ["-xf", archive, "-C", extractDir], { stdio: "inherit" });
log("tar exit code:", tar.status ?? tar.signal);
if (tar.status !== 0) {
  log("tar extraction failed");
  process.exit(tar.status ?? 1);
}

// The archive's top-level folder is "TBAi/".
const appFolder = path.join(extractDir, "TBAi");
if (!existsSync(appFolder)) {
  log("TBAi folder not found after extraction");
  process.exit(1);
}

const zipPath = path.join(outDir, "TBAi-win-x64-portable.zip");
if (existsSync(zipPath)) rmSync(zipPath, { force: true });

const safe = (s: string) => s.replace(/'/g, "''");
const result = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${safe(appFolder)}' -DestinationPath '${safe(zipPath)}' -CompressionLevel Optimal`,
  ],
  { stdio: "inherit" },
);
log("compress exit code:", result.status ?? result.signal);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Remove installer artifacts so the output is portable-only (no installer).
for (const name of [
  "TBAi-Setup.exe",
  "TBAi-Setup.tar.zst",
  "TBAi-Setup.metadata.json",
  "TBAi",
  "app-extract",
]) {
  const fp = path.join(outDir, name);
  if (existsSync(fp)) {
    rmSync(fp, { recursive: true, force: true });
    log("removed", name);
  }
}

log("done:", zipPath);
process.exit(0);
