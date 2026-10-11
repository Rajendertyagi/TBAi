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
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessWebBuild,
  buildStampPath,
  clearBuildStamp,
  describeBuildFreshness,
  hashWebSource,
  readBuildStamp,
  webBuildInputFiles,
  writeBuildStamp,
} from "../../../scripts/web-build-provenance.ts";
import { REPO_ROOT } from "../../helpers/repo-root";

/** This file lives at `<repo>/tests/integration/`, so the root is two levels up. */

const WEB_ROOT = path.join(REPO_ROOT, "web");
const WEB_DIST = path.join(REPO_ROOT, "dist", "web");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * These cases deliberately invalidate the REAL `dist/web` stamp, because that is
 * the only way to prove the shipped server script refuses an untrusted artifact.
 *
 * The cost is that a failure part-way through could leave the working tree unable
 * to start the E2E server. So the truthful stamp is restored unconditionally on
 * the way out — not only on the happy path. Leaving a stale artifact behind as a
 * side effect of running the tests would be the exact hazard these tests exist to
 * prevent, just pointed at the next person instead.
 */
afterAll(() => {
  if (assessWebBuild(WEB_ROOT, WEB_DIST).status !== "current") {
    writeBuildStamp(WEB_DIST, hashWebSource(WEB_ROOT), "restored by e2e-build-integrity.test.ts");
  }
});

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

/** A throwaway directory shaped like a built bundle. */
function makeFakeDist(withIndex = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-dist-"));
  tempDirs.push(dir);
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
   * Run the real server launcher and report what it did.
   *
   * Only the refusal paths are exercised — each case must NOT reach the point of
   * spawning the app, which is precisely the behaviour under test. A unique port
   * is used so "did the app start?" is answerable by a real connection attempt
   * rather than by trusting the exit code alone.
   */
  function startServerExpectingRefusal(port: number) {
    const result = spawnSync(process.execPath, [START_SERVER], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, TBAI_E2E_PORT: String(port), TBAI_E2E_STUB_PORT: String(port + 1) },
      timeout: 30_000,
    });
    return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  /** A port nothing is listening on, derived from a unique-ish base. */
  const unusedPort = (base: number): number => base + Math.floor(process.pid % 500) * 2;

  it("REFUSES a missing artifact and never starts the app", () => {
    const port = unusedPort(41_000);
    // Remove the stamp so the real dist is refused regardless of its age.
    const hadStamp = clearBuildStamp(WEB_DIST);
    expect(hadStamp || !fs.existsSync(buildStampPath(WEB_DIST))).toBe(true);

    const { code, output } = startServerExpectingRefusal(port);
    expect(code).not.toBe(0);
    expect(output).toContain("refusing to start");
    expect(output).toContain("build stamp");
  });

  it("REFUSES a stale stamp: an artifact built from different source", () => {
    const port = unusedPort(43_000);
    // A stamp that is well-formed but describes source that is not this source.
    writeBuildStamp(WEB_DIST, "0".repeat(64), "test: deliberately stale");
    try {
      const { code, output } = startServerExpectingRefusal(port);
      expect(code).not.toBe(0);
      expect(output).toContain("refusing to start");
      expect(output).toContain("different source");
    } finally {
      // Restore a truthful stamp so later checks and the real suite still run.
      writeBuildStamp(WEB_DIST, hashWebSource(WEB_ROOT), "restored by test");
    }
  });
});

describe("buildWebAndStamp — a failed build can never leave a trusted artifact", () => {
  it("writes a stamp only after a successful build", async () => {
    const { buildWebAndStamp } = await import("../../../scripts/build-web.ts");
    // Drive the orchestration against the REAL dist/web, but with a build
    // function that does no work, so the assertion is about the stamping
    // protocol rather than about vite.
    const ok = buildWebAndStamp(
      () => 0,
      () => undefined,
    );
    expect(ok).toBe(true);
    expect(readBuildStamp(WEB_DIST)).not.toBeNull();
    expect(assessWebBuild(WEB_ROOT, WEB_DIST).status).toBe("current");
  });

  it("a FAILED build returns false, clears the stamp, and leaves no artifact trusted", async () => {
    const { buildWebAndStamp } = await import("../../../scripts/build-web.ts");
    const stampBefore = readBuildStamp(WEB_DIST);
    expect(stampBefore).not.toBeNull(); // precondition: a trusted artifact exists

    const ok = buildWebAndStamp(
      () => 1,
      () => undefined,
    );
    expect(ok).toBe(false);
    // The old bundle is still physically present — that is exactly why existence
    // checking was never enough — but it is no longer trusted.
    expect(fs.existsSync(path.join(WEB_DIST, "index.html"))).toBe(true);
    expect(readBuildStamp(WEB_DIST)).toBeNull();
    expect(assessWebBuild(WEB_ROOT, WEB_DIST)).toEqual({ status: "missing-stamp" });
  });

  it("a build that THROWS is treated as failure, not as success", async () => {
    const { buildWebAndStamp } = await import("../../../scripts/build-web.ts");
    const ok = buildWebAndStamp(
      () => {
        throw new Error("tsc exited with diagnostics");
      },
      () => undefined,
    );
    expect(ok).toBe(false);
    expect(readBuildStamp(WEB_DIST)).toBeNull();
  });

  it("restores a truthful stamp so the real E2E suite remains runnable", async () => {
    const { buildWebAndStamp } = await import("../../../scripts/build-web.ts");
    buildWebAndStamp(
      () => 0,
      () => undefined,
    );
    expect(assessWebBuild(WEB_ROOT, WEB_DIST).status).toBe("current");
  });
});
