import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../helpers/repo-root.ts";

/**
 * PT1–PT3 — the platform claim the runtime document makes, asserted against the
 * two files that define it.
 *
 * These are executable assertions, not a source-text grep: each file is PARSED
 * (JSON and YAML), so a comment, a reformat, or a reordered key cannot satisfy
 * them, and a value that changes to another platform fails them. The claim is
 * deliberately narrow — the shipped desktop build is a Windows x64 artifact —
 * which is why PT3 refuses any token naming another platform.
 */

const TAURI_CONFIG = join(REPO_ROOT, "src-tauri", "tauri.conf.json");
const TAURI_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "tauri-build.yml");

/** Platforms the document does NOT claim; PT3 fails if either file names one. */
const OTHER_PLATFORM_TOKENS = [
  "macos",
  "darwin",
  "ubuntu",
  "linux",
  "appimage",
  "aarch64",
] as const;

/** The non-Windows bundle targets Tauri would produce for another platform. */
const NON_WINDOWS_TARGETS = ["app", "dmg", "deb", "rpm", "appimage", "updater"] as const;

interface TauriConfig {
  bundle: { targets: string[] };
}

interface TauriWorkflow {
  jobs: Record<
    string,
    { "runs-on": string; steps: { uses?: string; with?: Record<string, unknown> }[] }
  >;
}

function readTauriConfig(): TauriConfig {
  return JSON.parse(readFileSync(TAURI_CONFIG, "utf8")) as TauriConfig;
}

function readTauriWorkflow(): TauriWorkflow {
  return Bun.YAML.parse(readFileSync(TAURI_WORKFLOW, "utf8")) as TauriWorkflow;
}

describe("PT1 — the bundle declares the NSIS installer target", () => {
  it("lists nsis as the only bundle target", () => {
    const targets = readTauriConfig().bundle.targets;
    expect(targets).toContain("nsis");
    for (const other of NON_WINDOWS_TARGETS) {
      expect(targets).not.toContain(other);
    }
  });
});

describe("PT2 — the workflow builds Windows x64", () => {
  it("runs on windows-latest with the x86_64-pc-windows-msvc target", () => {
    const build = readTauriWorkflow().jobs.build;
    expect(build["runs-on"]).toBe("windows-latest");

    const rustToolchain = build.steps.find((step) =>
      (step.uses ?? "").includes("dtolnay/rust-toolchain"),
    );
    expect(rustToolchain).toBeDefined();
    expect(rustToolchain?.with?.targets).toBe("x86_64-pc-windows-msvc");
  });
});

describe("PT3 — neither file claims support for another platform", () => {
  it("the parsed configuration and workflow name no other platform", () => {
    const configuration = JSON.stringify(readTauriConfig()).toLowerCase();
    const workflow = JSON.stringify(readTauriWorkflow()).toLowerCase();
    for (const token of OTHER_PLATFORM_TOKENS) {
      expect(configuration).not.toContain(token);
      expect(workflow).not.toContain(token);
    }
  });
});
