/**
 * Record what the Playwright configuration ACTUALLY resolves to, per project.
 *
 * ## Why a separate dump instead of reading the config by eye
 *
 * The G5 comparison runs the same suite at two revisions and compares results.
 * That comparison is only meaningful if both legs ran the same harness: the same
 * projects, the same filters, the same retries, the same browser. The harness
 * reporter config deliberately imports the revision's own `playwright.config.ts`
 * — duplicating the settings inside the harness would silently diverge from the
 * app's real configuration — so the only way to know what was used is to ASK the
 * loaded config.
 *
 * This script does that: it imports `web/playwright.config.ts`, selects one
 * project, and writes a normalized JSON document plus its digest.
 *
 * ## What normalization is for
 *
 * Two revisions live in two different worktrees, so an absolute path legitimately
 * differs between them. Normalization removes exactly that class of noise —
 * absolute paths become `<abs>`, a launch executable becomes
 * `executablePathSet`, launch env becomes its key list, reporter is omitted
 * because the harness owns it — and keeps every field that changes WHAT RUNS,
 * including `use.channel` and `use.headless`. A project that differs only in its
 * browser would otherwise compare equal, which is the failure this guards.
 *
 * Keys are sorted at every level, so the digest is a function of the settings
 * and not of key insertion order.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = path.join(REPO_ROOT, "web");
const DEFAULT_CONFIG = path.join(WEB_ROOT, "playwright.config.ts");

/** Environment knobs that change what the harness runs; recorded, never guessed. */
const RECORDED_ENV = [
  "TBAI_E2E_LIVE",
  "TBAI_E2E_EXTERNAL_SERVER",
  "TBAI_E2E_BASE_URL",
  "TBAI_E2E_PORT",
  "TBAI_E2E_SKIP_BUILD",
  "TBAI_E2E_JSON_DIR",
] as const;

/** The `use` fields a comparison must not treat as equivalent. */
const USE_FIELDS = [
  "channel",
  "headless",
  "baseURL",
  "viewport",
  "deviceScaleFactor",
  "isMobile",
  "hasTouch",
  "locale",
  "timezoneId",
  "colorScheme",
  "trace",
  "video",
  "screenshot",
  "actionTimeout",
  "navigationTimeout",
] as const;

type Unknown = Record<string, unknown>;

/** A regular expression as its source; everything else unchanged. */
function plain(value: unknown): unknown {
  if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
  if (Array.isArray(value)) return value.map(plain);
  return value;
}

/** `undefined` is dropped, not serialized as null, so absent and null differ. */
function defined(entries: Record<string, unknown>): Unknown {
  const out: Unknown = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function normalizePath(value: unknown): unknown {
  if (typeof value !== "string") return plain(value);
  return path.isAbsolute(value) ? "<abs>" : value;
}

/** The browser-facing half of a `use` block. */
export function normalizeUse(use: Unknown | undefined): Unknown {
  if (!use) return {};
  const launch = (use.launchOptions ?? {}) as Unknown;
  return defined({
    ...Object.fromEntries(USE_FIELDS.map((field) => [field, plain(use[field])])),
    launchOptions: Object.keys(launch).length
      ? defined({
          args: plain(launch.args),
          executablePathSet: "executablePath" in launch,
          envKeys: launch.env ? Object.keys(launch.env as Unknown).sort() : undefined,
        })
      : undefined,
    // Recorded as a flag rather than as contents: the device descriptor expands
    // into many `use` fields, and those fields are already captured above.
    device: use.device !== undefined ? true : undefined,
  });
}

/** The execution-relevant subset of the top-level config (projects excluded). */
export function normalizeTopLevel(config: Unknown): Unknown {
  return defined({
    testDir: normalizePath(config.testDir),
    testMatch: plain(config.testMatch),
    testIgnore: plain(config.testIgnore),
    grep: plain(config.grep),
    grepInvert: plain(config.grepInvert),
    fullyParallel: config.fullyParallel,
    forbidOnly: config.forbidOnly,
    maxFailures: config.maxFailures,
    retries: config.retries,
    workers: config.workers,
    timeout: config.timeout,
    expectTimeout: (config.expect as Unknown | undefined)?.timeout,
    outputDir: normalizePath(config.outputDir),
    // The runner supplies TBAI_E2E_EXTERNAL_SERVER=1, so the block's contents are
    // inert; its presence is still recorded because it explains the env value.
    webServerPresent: config.webServer !== undefined,
    projectNames: ((config.projects ?? []) as Unknown[]).map((p) => p.name),
  });
}

/** The normalized settings for one named project. */
export function normalizeProject(config: Unknown, projectName: string): Unknown {
  const projects = ((config.projects ?? []) as Unknown[]).filter(Boolean);
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    const names = projects.map((p) => p.name).join(", ") || "(none)";
    throw new Error(`project "${projectName}" is not in the config; projects: ${names}`);
  }
  return {
    top: normalizeTopLevel(config),
    project: defined({
      name: project.name,
      testMatch: plain(project.testMatch),
      testIgnore: plain(project.testIgnore),
      grep: plain(project.grep),
      use: normalizeUse(project.use as Unknown | undefined),
    }),
  };
}

/** JSON with keys sorted at every level: the digest's canonical form. */
export function canonicalJson(value: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (node && typeof node === "object") {
      const out: Unknown = {};
      for (const key of Object.keys(node as Unknown).sort()) {
        out[key] = sort((node as Unknown)[key]);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(sort(value));
}

/** Hex SHA-256 of the canonical form of `settings`. */
export function settingsDigest(settings: unknown): string {
  return createHash("sha256").update(canonicalJson(settings)).digest("hex");
}

/** The environment record written beside the settings. */
export function recordedEnvironment(env: NodeJS.ProcessEnv = process.env): Unknown {
  const out: Unknown = {};
  for (const key of RECORDED_ENV) out[key] = env[key] ?? null;
  return out;
}

/** Load a Playwright config module and return its resolved object. */
export async function loadConfig(configPath: string): Promise<Unknown> {
  const module = (await import(pathToFileURL(configPath).href)) as { default?: Unknown };
  if (!module.default || typeof module.default !== "object") {
    throw new Error(`${configPath} did not export a config object`);
  }
  return module.default;
}

async function main(argv: readonly string[]): Promise<number> {
  const option = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: bun scripts/dump-playwright-settings.ts --project=<name> --out=<file> " +
        "[--revision=<sha>] [--config=<path>]",
    );
    return 0;
  }

  const project = option("project");
  const out = option("out");
  if (!project || !out) {
    console.error("[settings] --project and --out are required");
    return 1;
  }
  const configPath = option("config") ?? DEFAULT_CONFIG;

  let settings: Unknown;
  try {
    settings = normalizeProject(await loadConfig(configPath), project);
  } catch (error) {
    console.error(`[settings] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const document = {
    schemaVersion: 1 as const,
    project,
    revision: option("revision") ?? null,
    configPath,
    env: recordedEnvironment(),
    digest: settingsDigest(settings),
    settings,
  };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`[settings] ${project}: ${document.digest}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
