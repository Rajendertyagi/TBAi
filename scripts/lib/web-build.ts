/**
 * The gate that keeps a driver from serving a stale web bundle.
 *
 * Two drivers serve `dist/web`: the G3 orchestrator (its TBAi app serves the
 * bundle to Playwright) and the G2 dev observation (the backend that
 * `beforeDevCommand` starts serves it to the WebView). Both must refuse a stale
 * or unstamped bundle for the same reason — a run against the previous bundle
 * reports a confident, wrong result — and a gate kept in two places drifts into
 * one that checks and one that merely hopes. The build itself stays in
 * `scripts/build-web.ts`, which owns the stamp.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebAndStamp, runWebBuild } from "../build-web";
import { assessWebBuild, describeBuildFreshness } from "../web-build-provenance";

/** Anchored to the checkout, never to the caller's cwd. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB_ROOT = path.join(REPO_ROOT, "web");
const WEB_DIST = path.join(REPO_ROOT, "dist", "web");

export interface WebBuildCheck {
  readonly ok: boolean;
  /** Operator-facing reason, or null when the bundle is current. */
  readonly error: string | null;
}

/**
 * Builds (unless `TBAI_E2E_SKIP_BUILD=1`) and confirms `dist/web` is current.
 *
 * @param logPrefix - Driver name for progress lines, e.g. `"g3"`.
 * @returns Whether the bundle may be served, and why not when it may not.
 */
export function ensureFreshWebBuild(logPrefix: string): WebBuildCheck {
  const root = `${WEB_ROOT}`;
  const dist = `${WEB_DIST}`;
  if (process.env.TBAI_E2E_SKIP_BUILD === "1") {
    const freshness = assessWebBuild(root, dist);
    console.log(`[${logPrefix}] TBAI_E2E_SKIP_BUILD=1 — ${describeBuildFreshness(freshness)}`);
    return freshness.status === "current"
      ? { ok: true, error: null }
      : {
          ok: false,
          error: `the web bundle is not current: ${describeBuildFreshness(freshness)}`,
        };
  }

  console.log(`[${logPrefix}] building the web bundle that will be served…`);
  if (!buildWebAndStamp(runWebBuild, (message) => console.log(`[${logPrefix}] ${message}`))) {
    console.error(
      `[${logPrefix}] build FAILED — refusing to run against a stale or unstamped bundle. ` +
        "Fix the build and re-run.",
    );
    return { ok: false, error: "the web build failed and left dist/web unstamped" };
  }
  const freshness = assessWebBuild(root, dist);
  console.log(`[${logPrefix}] ${describeBuildFreshness(freshness)}`);
  return freshness.status === "current"
    ? { ok: true, error: null }
    : { ok: false, error: `the web bundle is not current: ${describeBuildFreshness(freshness)}` };
}
