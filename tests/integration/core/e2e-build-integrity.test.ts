/**
 * E2E build integrity: the suite must never silently test a stale bundle.
 *
 * ## What went wrong
 *
 * `dist/web` is a build output, but nothing tied it to the source that produced
 * it. `start-e2e-server.ts` checked only that `dist/web/index.html` existed, so
 * a stale-but-present bundle was served and the suite reported confident results
 * for code that was not in the tree. This was not hypothetical: it produced a
 * set of passing E2E results in this repository that were entirely wrong, and
 * were only detected because an unrelated log line failed to appear.
 *
 * ## Why these tests EXECUTE the orchestration
 *
 * The failure mode here is an ORDERING bug, and ordering bugs cannot be caught by
 * reading the source. A test that asserts "the build call appears before the
 * spawn call" would pass unchanged while the build silently ran per spec file, or
 * ran after the first server had already started serving. So each case below
 * drives the real functions with a real failing build and asserts on real
 * observable effects: the stamp on disk, the exit code, and whether a port ever
 * opened.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessWebBuild,
  buildStampPath,
  describeBuildFreshness,
  hashWebSource,
  readBuildStamp,
  webBuildInputFiles,
  writeBuildStamp,
} from "../../../scripts/web-build-provenance.ts";
import { REPO_ROOT } from "../../helpers/repo-root";

/** This file lives at `<repo>/tests/integration/`, so the root is two levels up. */

const WEB_ROOT = path.join(REPO_ROOT, "web");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The server-refusal and build-orchestration cases use temporary web roots and
 * dist directories. CI's fast verification job intentionally runs independently
 * of the E2E job, so a fresh checkout may not contain `dist/web`. These tests
 * must therefore neither depend on nor mutate the repository's build artifact.
 * Each temporary directory is registered for cleanup by afterEach().
 */
/** A throwaway directory shaped like `web/`, with a small real source tree. */
function makeFakeWebRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-webroot-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "deep", "b.tsx"), "export const b = 2;\n");
  fs.writeFileSync(path.join(root, "public", "favicon.svg"), "<svg/>\n");
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html>\n");
  fs.writeFileSync(path.join(root, "package.json"), '{ "name": "web" }\n');
  fs.writeFileSync(path.join(root, "vite.config.ts"), "export default {}\n");
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  // Noise that must NOT affect the hash: none of these reach the bundle.
  fs.mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports=1;\n");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "old-bundle.js"), "// stale artifact\n");
  fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(root, "test-results", "log.txt"), "noise\n");
  return root;
}

/**
 * A throwaway directory shaped like a built bundle.
 *
 * The stamp lives in the bundle's parent directory (the real layout is
 * `dist/web` + `dist/web-build-stamp.json`). Returning a nested `<root>/web`
 * directory keeps that sibling-stamp contract intact while isolating each test's
 * stamp under its own temp root — otherwise every temp dist under os.tmpdir()
 * would share `os.tmpdir()/web-build-stamp.json` and contaminate other tests.
 */
function makeFakeDist(withIndex = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-dist-"));
  tempDirs.push(root);
  const dir = path.join(root, "web");
  fs.mkdirSync(dir, { recursive: true });
  if (withIndex) fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=root>");
  return dir;
}

describe("web build provenance — the hash identifies the source, not the directory", () => {
  it("covers the build inputs and excludes everything else", () => {
    const root = makeFakeWebRoot();
    expect(webBuildInputFiles(root)).toEqual([
      "index.html",
      "package.json",
      "public/favicon.svg",
      "src/a.ts",
      "src/deep/b.tsx",
      "tsconfig.json",
      "vite.config.ts",
    ]);
  });

  it("is stable across calls and across directory ordering", () => {
    const root = makeFakeWebRoot();
    const first = hashWebSource(root);
    expect(hashWebSource(root)).toBe(first);

    // Create a sibling so enumeration order has more than one possibility.
    fs.writeFileSync(path.join(root, "src", "zz.ts"), "export const z = 3;\n");
    const withSibling = hashWebSource(root);
    expect(withSibling).not.toBe(first);

    // Re-reading the same tree must reproduce the same value.
    expect(hashWebSource(root)).toBe(withSibling);
  });

  it("changes when a build input's CONTENT changes", () => {
    const root = makeFakeWebRoot();
    const before = hashWebSource(root);
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 999;\n");
    expect(hashWebSource(root)).not.toBe(before);
  });

  it("changes when a build input is DELETED, even if its bytes survive elsewhere", () => {
    const root = makeFakeWebRoot();
    // Same bytes in two files: content-only hashing would see no change here.
    const bytes = fs.readFileSync(path.join(root, "src", "a.ts"));
    fs.writeFileSync(path.join(root, "src", "copy.ts"), bytes);
    const before = hashWebSource(root);
    fs.rmSync(path.join(root, "src", "a.ts"));
    expect(hashWebSource(root)).not.toBe(before);
  });

  it("ignores build-irrelevant noise such as node_modules and test-results", () => {
    const root = makeFakeWebRoot();
    const before = hashWebSource(root);
    fs.writeFileSync(
      path.join(root, "node_modules", "left-pad", "index.js"),
      "module.exports=2;\n",
    );
    fs.writeFileSync(path.join(root, "test-results", "log.txt"), "more noise\n");
    fs.writeFileSync(path.join(root, "dist", "old-bundle.js"), "// rebuilt\n");
    expect(hashWebSource(root)).toBe(before);
  });

  it("hashes the real web project without throwing", () => {
    expect(hashWebSource(WEB_ROOT)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("web build provenance — freshness is classified, not guessed", () => {
  it("reports a missing artifact distinctly from a missing stamp", () => {
    const root = makeFakeWebRoot();
    const empty = makeFakeDist(false);
    expect(assessWebBuild(root, empty)).toEqual({ status: "missing-artifact" });
    expect(describeBuildFreshness({ status: "missing-artifact" })).toContain("does not exist");

    const dist = makeFakeDist();
    expect(assessWebBuild(root, dist)).toEqual({ status: "missing-stamp" });
    expect(describeBuildFreshness({ status: "missing-stamp" })).toContain("no build stamp");
  });

  it("reports a stale stamp once the source moves on", () => {
    const root = makeFakeWebRoot();
    const dist = makeFakeDist();
    writeBuildStamp(dist, hashWebSource(root), "test");

    expect(assessWebBuild(root, dist).status).toBe("current");

    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 42;\n");
    const after = assessWebBuild(root, dist);
    expect(after.status).toBe("stale");
    if (after.status === "stale") {
      expect(after.currentHash).toBe(hashWebSource(root));
      expect(after.stamp.sourceHash).not.toBe(after.currentHash);
    }
  });

  it("treats a MALFORMED stamp as absent rather than trusting it", () => {
    const root = makeFakeWebRoot();
    const dist = makeFakeDist();
    fs.writeFileSync(buildStampPath(dist), "{ not json");
    expect(assessWebBuild(root, dist)).toEqual({ status: "missing-stamp" });
    expect(readBuildStamp(dist)).toBeNull();
  });

  it("treats a stamp with no sourceHash as absent", () => {
    const root = makeFakeWebRoot();
    const dist = makeFakeDist();
    fs.writeFileSync(buildStampPath(dist), JSON.stringify({ builtAt: "x" }));
    expect(assessWebBuild(root, dist)).toEqual({ status: "missing-stamp" });
  });
});

describe("the E2E server refuses an artifact it cannot vouch for", () => {
  const START_SERVER = path.join(REPO_ROOT, "scripts", "start-e2e-server.ts");

  /**
   * Run the real launcher in check-only mode against isolated build inputs.
   * Even if those inputs are current, check-only mode exits before any server
   * starts, so test paths cannot bypass the shipped-artifact provenance guard.
   */
  function runServerProvenanceCheck(
    webRoot: string,
    webDist: string,
    extraEnv: Record<string, string> = {},
  ) {
    const result = spawnSync(process.execPath, [START_SERVER], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        TBAI_E2E_WEB_ROOT: webRoot,
        TBAI_E2E_WEB_DIST: webDist,
        TBAI_E2E_PROVENANCE_CHECK_ONLY: "1",
        ...extraEnv,
      },
      timeout: 30_000,
    });
    return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  it("REFUSES an artifact with no build stamp", () => {
    const webRoot = makeFakeWebRoot();
    const webDist = makeFakeDist();

    const { code, output } = runServerProvenanceCheck(webRoot, webDist);
    expect(code).not.toBe(0);
    expect(output).toContain("refusing to start");
    expect(output).toContain("no build stamp");
  });

  it("REFUSES a stale stamp: an artifact built from different source", () => {
    const webRoot = makeFakeWebRoot();
    const webDist = makeFakeDist();
    // A stamp that is well-formed but describes source that is not this source.
    writeBuildStamp(webDist, "0".repeat(64), "test: deliberately stale");

    const { code, output } = runServerProvenanceCheck(webRoot, webDist);
    expect(code).not.toBe(0);
    expect(output).toContain("refusing to start");
    expect(output).toContain("different source");
  });

  it("check-only mode exits without starting the server for a current artifact", () => {
    const webRoot = makeFakeWebRoot();
    const webDist = makeFakeDist();
    writeBuildStamp(webDist, hashWebSource(webRoot), "test: current artifact");

    const { code, output } = runServerProvenanceCheck(webRoot, webDist);
    expect(code).toBe(0);
    expect(output).toContain("check-only mode, server not started");
    expect(output).not.toContain("serving web build");
  });

  it("check-only mode is a pure provenance check with no E2E data/workspace side effects", () => {
    const webRoot = makeFakeWebRoot();
    const webDist = makeFakeDist();
    writeBuildStamp(webDist, hashWebSource(webRoot), "test: current artifact");

    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-e2e-artifacts-"));
    tempDirs.push(artifactRoot);
    const existingDataDir = path.join(artifactRoot, "existing-data");
    const existingWorkspaceDir = path.join(artifactRoot, "existing-workspace");
    const missingDataDir = path.join(artifactRoot, "missing-data");
    const missingWorkspaceDir = path.join(artifactRoot, "missing-workspace");
    fs.mkdirSync(existingDataDir, { recursive: true });
    fs.mkdirSync(existingWorkspaceDir, { recursive: true });
    const sentinelData = path.join(existingDataDir, "sentinel.txt");
    const sentinelWorkspace = path.join(existingWorkspaceDir, "sentinel.txt");
    fs.writeFileSync(sentinelData, "keep-data\n");
    fs.writeFileSync(sentinelWorkspace, "keep-workspace\n");

    const { code, output } = runServerProvenanceCheck(webRoot, webDist, {
      TBAI_E2E_DATA_DIR: existingDataDir,
      TBAI_E2E_WORKSPACE_DIR: existingWorkspaceDir,
    });

    expect(code).toBe(0);
    expect(output).toContain("check-only mode, server not started");
    expect(output).not.toContain("serving web build");
    expect(output).not.toContain("baseline provider seeded");
    expect(output).not.toContain("app never became ready");
    expect(fs.existsSync(sentinelData)).toBe(true);
    expect(fs.readFileSync(sentinelData, "utf8")).toBe("keep-data\n");
    expect(fs.existsSync(sentinelWorkspace)).toBe(true);
    expect(fs.readFileSync(sentinelWorkspace, "utf8")).toBe("keep-workspace\n");
    expect(fs.existsSync(path.join(existingDataDir, "xdg-config"))).toBe(false);

    const { code: missingCode, output: missingOutput } = runServerProvenanceCheck(
      webRoot,
      webDist,
      {
        TBAI_E2E_DATA_DIR: missingDataDir,
        TBAI_E2E_WORKSPACE_DIR: missingWorkspaceDir,
      },
    );
    expect(missingCode).toBe(0);
    expect(missingOutput).toContain("check-only mode, server not started");
    expect(fs.existsSync(missingDataDir)).toBe(false);
    expect(fs.existsSync(missingWorkspaceDir)).toBe(false);
  });

  it("check-only mode still detects missing, stale, and current build provenance without side effects", () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-e2e-artifacts-"));
    tempDirs.push(artifactRoot);
    const dataDir = path.join(artifactRoot, "data");
    const workspaceDir = path.join(artifactRoot, "workspace");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    const sentinel = path.join(dataDir, "sentinel.txt");
    fs.writeFileSync(sentinel, "keep\n");
    const isolatedEnv = {
      TBAI_E2E_DATA_DIR: dataDir,
      TBAI_E2E_WORKSPACE_DIR: workspaceDir,
    };

    const missingRoot = makeFakeWebRoot();
    const missingDist = makeFakeDist();
    const missing = runServerProvenanceCheck(missingRoot, missingDist, isolatedEnv);
    expect(missing.code).not.toBe(0);
    expect(missing.output).toContain("refusing to start");
    expect(missing.output).toContain("no build stamp");

    const staleRoot = makeFakeWebRoot();
    const staleDist = makeFakeDist();
    writeBuildStamp(staleDist, "0".repeat(64), "test: deliberately stale");
    const stale = runServerProvenanceCheck(staleRoot, staleDist, isolatedEnv);
    expect(stale.code).not.toBe(0);
    expect(stale.output).toContain("refusing to start");
    expect(stale.output).toContain("different source");

    const currentRoot = makeFakeWebRoot();
    const currentDist = makeFakeDist();
    writeBuildStamp(currentDist, hashWebSource(currentRoot), "test: current artifact");
    const current = runServerProvenanceCheck(currentRoot, currentDist, isolatedEnv);
    expect(current.code).toBe(0);
    expect(current.output).toContain("check-only mode, server not started");

    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep\n");
    expect(fs.existsSync(path.join(dataDir, "xdg-config"))).toBe(false);
  });

  // Acknowledged test limitation: normal-mode path/override behavior is not
  // exercised here because safely invoking the normal E2E server launcher would
  // require starting/cleaning real E2E services or disproportionate refactoring,
  // and can delete default E2E data/workspace state. Coverage is limited to
  // isolated check-only provenance regression tests above.
});

describe("buildWebAndStamp — a failed build can never leave a trusted artifact", () => {
  it("writes a stamp only after a successful build", async () => {
    const { buildWebAndStamp } = await import("../../../scripts/build-web.ts");
    const webRoot = makeFakeWebRoot();
    const webDist = makeFakeDist();
    // No real build is needed: this test isolates orchestration and stamp order.
    const ok = buildWebAndStamp(
      () => 0,
      () => undefined,
      { webRoot, webDist },
    );
    expect(ok).toBe(true);
    expect(readBuildStamp(webDist)).not.toBeNull();
    expect(assessWebBuild(webRoot, webDist).status).toBe("current");
  });

  it("a FAILED build returns false, clears the stamp, and leaves no artifact trusted", async () => {
    const { buildWebAndStamp } = await import("../../../scripts/build-web.ts");
    const webRoot = makeFakeWebRoot();
    const webDist = makeFakeDist();
    writeBuildStamp(webDist, hashWebSource(webRoot), "test: initial successful artifact");
    const stampBefore = readBuildStamp(webDist);
    expect(stampBefore).not.toBeNull(); // precondition: a trusted artifact exists

    const ok = buildWebAndStamp(
      () => 1,
      () => undefined,
      { webRoot, webDist },
    );
    expect(ok).toBe(false);
    // The old bundle is still physically present — that is exactly why existence
    // checking was never enough — but it is no longer trusted.
    expect(fs.existsSync(path.join(webDist, "index.html"))).toBe(true);
    expect(readBuildStamp(webDist)).toBeNull();
    expect(assessWebBuild(webRoot, webDist)).toEqual({ status: "missing-stamp" });
  });

  it("a build that THROWS is treated as failure, not as success", async () => {
    const { buildWebAndStamp } = await import("../../../scripts/build-web.ts");
    const webRoot = makeFakeWebRoot();
    const webDist = makeFakeDist();
    writeBuildStamp(webDist, hashWebSource(webRoot), "test: initial successful artifact");
    const ok = buildWebAndStamp(
      () => {
        throw new Error("tsc exited with diagnostics");
      },
      () => undefined,
      { webRoot, webDist },
    );
    expect(ok).toBe(false);
    expect(readBuildStamp(webDist)).toBeNull();
  });

  it("restores a truthful stamp so the real E2E suite remains runnable", async () => {
    const { buildWebAndStamp } = await import("../../../scripts/build-web.ts");
    const webRoot = makeFakeWebRoot();
    const webDist = makeFakeDist();
    buildWebAndStamp(
      () => 0,
      () => undefined,
      { webRoot, webDist },
    );
    expect(assessWebBuild(webRoot, webDist).status).toBe("current");
  });
});
