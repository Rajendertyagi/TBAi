/**
 * G1: read the origin the PACKAGED Tauri WebView actually runs with, and prove
 * the app's own API is readable from that origin.
 *
 * ## What was missing
 *
 * The `tauri` CI job already builds the real packaged app, starts it, and reads
 * `/api/server/instance` — but every one of those requests comes from the test
 * process on `127.0.0.1`. It therefore proves the packaged SERVER runs; it does
 * not observe the WebView's origin, and it does not prove the WebView can read a
 * response from the API across the custom-protocol boundary. `http://app.localhost`
 * is Tauri's documented Windows form for a custom `app` protocol page
 * (`docs/architecture.md`, "Windows WebView2 produces the origin
 * `http://app.localhost`"), and the CORS policy is pinned by a unit test — but
 * neither is an observation of the running app.
 *
 * ## How the observation is taken
 *
 * The app is driven by `tauri-driver` (Tauri's WebDriver bridge, paired with the
 * Microsoft Edge WebDriver that matches the installed WebView2 runtime; both are
 * provisioned by the `tauri` job). One WebDriver session is created with the
 * `tauri:options.application` capability, and the values come FROM THE WEBVIEW:
 *
 *   1. `session-create` — the driver accepts a session for the packaged exe;
 *   2. `port-wait`     — the app's sidecar writes `<DATA_DIR>/port`;
 *   3. `executeScript` — `window.location.origin` in the page, read only once the
 *                        document has left `about:blank` (see below);
 *   4. `fetch`         — `fetch()` of `/api/server/instance` executed INSIDE that
 *                        origin, recording status and body;
 *   5. `zoom-hotkeys`  — `window.devicePixelRatio` is read, then each chord
 *                        (`Ctrl+=`, `Ctrl+Shift+=`, `Ctrl+-`, `Ctrl+0`) is sent
 *                        on its own via the WebDriver Actions API with a read
 *                        taken immediately before AND immediately after it.
 *                        With `zoomHotkeysEnabled: false` (pinned in
 *                        `src-tauri/tauri.conf.json`) the WebView ignores the
 *                        chords, so each pair must be identical.
 *
 * ## Why the zoom probe reads devicePixelRatio, and per chord
 *
 * Page zoom is a WebView2 property, not an application one: it moves
 * `window.devicePixelRatio` and leaves the CSS root font-size alone. A probe
 * that compared only the app's inline `style.zoom` or the computed root
 * font-size would therefore report a pass while the WebView zoomed freely.
 * Comparing one read before all three chords against one read after them is
 * equally weak — `Ctrl+0` resets the zoom, so a working `Ctrl+=` followed by
 * `Ctrl+0` ends exactly where it started. Each chord is consequently judged on
 * its own before/after pair, and the app's inline `zoom` plus computed
 * font-size are asserted separately as the application-scale half.
 *
 * ## Why step 3 waits
 *
 * WebView2 exposes the page target before Tauri commits the navigation to
 * `app://localhost`, and the port mirror is written by the Bun sidecar as it
 * boots — measured 2026-10-29: run 40871453744 read `href: about:blank` and
 * `origin: "null"` while the same app answered `/api/server/instance` on
 * `127.0.0.1`. A single read straight after `port-wait` is therefore a race
 * against the document load, not an observation of the app. Step 3 polls until
 * the document has a real URL, bounded by `NAVIGATION_TIMEOUT_MS`, and records
 * how many reads it took. The acceptance test is unchanged: the origin that is
 * assessed is still whatever the WebView reports, and it must equal
 * `EXPECTED_PACKAGED_ORIGIN` exactly.
 *
 * ## Identity is required evidence, not corroboration
 *
 * The direct `127.0.0.1` probe reads the instance id of the backend the packaged
 * app launched, and that id is what makes the in-origin answer attributable. An
 * origin plus a 200 prove only that SOME server answered from the app's origin;
 * they do not prove the page reached the server this launch started. So the
 * `fetch` stage passes only when all four hold:
 *
 *   - the WebView's origin is exactly `EXPECTED_PACKAGED_ORIGIN`;
 *   - the in-origin `GET /api/server/instance` returned 200;
 *   - both that response and the direct read carried a non-empty `instanceId`;
 *   - the two ids are equal.
 *
 * A missing direct id fails the run and is reported as missing evidence — with
 * the direct read's status or error as its cause — never as a mismatch, because
 * nothing was compared. The same rule the development observation (G2) already
 * enforces applies here: "a backend answered" is not "the backend this launch
 * started answered".
 *
 * ## Evidence on every path
 *
 * `packaged.json` is written whatever happens, with the stage that failed, so a
 * red CI step names where the observation stopped instead of just "no output".
 * The uploaded copies of the driver log and the application log are sanitized
 * (see `scripts/lib/sanitize.ts`); the data directory itself is never uploaded.
 *
 * ## What this is not
 *
 * It is Windows-only by construction: the driver, the WebView2 runtime and the
 * `http://app.localhost` form are all Windows facts. On any other platform the
 * script fails at `session-create` and says so.
 *
 * Usage:
 *   bun run verify:packaged-origin [--app=<exe>] [--out=<dir>]
 *                                  [--driver=<tauri-driver>] [--native-driver=<msedgedriver>]
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allocateFreePort,
  errorMessage,
  sleep,
  stopProcessTree,
  type ProcessStopResult,
} from "./lib/process";
import { sanitizeLogFile, sanitizeLogText } from "./lib/sanitize";
import {
  httpJson,
  sequentialStages,
  tailText,
  writeEvidenceFile,
  type StageResult,
} from "./lib/webview-observation";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_APP = path.join(REPO_ROOT, "TBAi-windows-x64-portable", "TBAi.exe");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "tests", ".artifacts", "origin");

/**
 * The origin a Windows WebView2 page gets for a custom protocol: `http://<scheme>.localhost`.
 * Tauri registers the protocol as `app` (`src-tauri/tauri.conf.json` `frontendDist`).
 */
export const EXPECTED_PACKAGED_ORIGIN = "http://app.localhost";

const DRIVER_READY_TIMEOUT_MS = 60_000;
const PORT_MIRROR_TIMEOUT_MS = 120_000;
const CDP_STEP_TIMEOUT_MS = 30_000;
/**
 * How long the WebView is given to leave `about:blank` once the sidecar has
 * written its port. The port file is a backend fact, not a page fact; the
 * document load follows it. Cold WebView2 start on a loaded runner is seconds,
 * so this is headroom, not an expected wait.
 */
const NAVIGATION_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const LOG_TAIL_CHARS = 8_000;

export const PACKAGED_STAGES = [
  "session-create",
  "port-wait",
  "executeScript",
  "fetch",
  "fonts",
  "zoom-hotkeys",
] as const;
export type PackagedStage = (typeof PACKAGED_STAGES)[number];

/**
 * The zoom chords a packaged WebView must ignore, in the order they are sent.
 * `Ctrl+Shift+=` is the real "zoom in" a user presses; `Ctrl+=` is the bare-key
 * form Windows also accepts, so both are covered.
 */
export const ZOOM_SHORTCUTS = [
  { label: "Ctrl+=", key: "=", shift: false },
  { label: "Ctrl+Shift+=", key: "=", shift: true },
  { label: "Ctrl+-", key: "-", shift: false },
  { label: "Ctrl+0", key: "0", shift: false },
] as const;

/**
 * The faces the packaged app must actually render, as (family, weight) pairs.
 *
 * Inter and JetBrains Mono ship as variable families (one face spanning 100–900
 * / 100–800), so two representative weights each are enough to prove the axis is
 * live. Lato is static: every weight is a separate `@font-face`, and a missing
 * stylesheet import is invisible unless each one is asked for by name.
 */
export const REQUIRED_FONT_FACES = [
  { family: "Inter Variable", weight: "400" },
  { family: "Inter Variable", weight: "700" },
  { family: "JetBrains Mono Variable", weight: "400" },
  { family: "JetBrains Mono Variable", weight: "700" },
  { family: "Lato", weight: "100" },
  { family: "Lato", weight: "300" },
  { family: "Lato", weight: "400" },
  { family: "Lato", weight: "700" },
  { family: "Lato", weight: "900" },
] as const;

/**
 * The two probe glyphs. `A` is Latin Basic; `Ž` is Latin Extended-A (U+017D),
 * which only renders from the family itself when its `latin-ext` subset is
 * present. A font that covers only `A` is a font whose European text silently
 * falls back glyph by glyph.
 */
export const FONT_PROBE_TEXTS = ["A", "Ž"] as const;

/** A family that is registered by nothing: the probe's own failure control. */
export const MISSING_FONT_CONTROL = "TBAi Missing Face";

/** One `FontFace` as the page reports it. */
export interface FontProbeFace {
  readonly family: string;
  readonly weight: string;
  readonly style: string;
  readonly status: string;
  readonly unicodeRange: string;
}

/** What the canvas rendered for one request, versus the generic fallback. */
export interface FontGlyphEvidence {
  /** The custom-family render put ink on the canvas. */
  readonly ink: boolean;
  /**
   * The custom-family pixels differ from `sans-serif` at the same weight and
   * size. This is SHAPE evidence, not a width comparison: a missing face renders
   * exactly the fallback pixels, so `distinct` is false even when widths coincidentally
   * differ from another glyph.
   */
  readonly distinctFromFallback: boolean;
}

/** One family/weight/text request and everything the page observed for it. */
export interface FontProbeReading {
  readonly family: string;
  readonly weight: string;
  readonly text: string;
  readonly loadedFaces: readonly FontProbeFace[];
  readonly computedFamily: string | null;
  readonly computedWeight: string | null;
  readonly glyph: FontGlyphEvidence | null;
  readonly error: string | null;
}

/** The whole in-page probe result. */
export interface FontProbePayload {
  readonly readings: readonly FontProbeReading[];
  readonly missingControl: {
    readonly family: string;
    readonly loadedFaces: readonly FontProbeFace[];
  };
}

/** Lower-case a family name with quotes and surrounding whitespace removed. */
export function normalizeFontFamily(family: string | null): string | null {
  if (family === null) return null;
  const value = family
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
  return value.length > 0 ? value : null;
}

/** The FIRST family in a computed `font-family` list, normalized. */
export function firstFontFamily(computed: string | null): string | null {
  if (computed === null) return null;
  const first = computed.split(",")[0] ?? "";
  return normalizeFontFamily(first);
}

/**
 * Whether a `FontFace.weight` descriptor serves `weight`.
 *
 * The descriptor is either one value (`"400"`) or a variable-font range
 * (`"100 900"`). A range's endpoints are inclusive. Anything unreadable is false:
 * a descriptor the probe cannot interpret is not evidence of coverage.
 */
export function fontFaceWeightCovers(descriptor: string | null, weight: string): boolean {
  if (descriptor === null) return false;
  const requested = Number.parseInt(weight, 10);
  if (!Number.isFinite(requested)) return false;
  const parts = descriptor
    .trim()
    .split(/\s+/)
    .map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return false;
  if (parts.length === 1) return parts[0] === requested;
  if (parts.length !== 2) return false;
  const low = Math.min(parts[0], parts[1]);
  const high = Math.max(parts[0], parts[1]);
  return requested >= low && requested <= high;
}

/**
 * Whether a CSS `unicode-range` descriptor covers `codePoint`.
 *
 * An empty descriptor means "no restriction" (all code points), which is how the
 * CSS Font Loading API reports a face declared without `unicode-range`. Ranges
 * like `U+0100-02BA` are inclusive; wildcard ranges (`U+4??`) are supported.
 */
export function unicodeRangeCovers(descriptor: string | null, codePoint: number): boolean {
  if (descriptor === null) return false;
  const text = descriptor.trim();
  if (text === "") return true;
  for (const raw of text.split(",")) {
    const part = raw.trim();
    const match = /^U\+([0-9A-Fa-f?]{1,6})(?:-([0-9A-Fa-f]{1,6}))?$/.exec(part);
    if (match === null) continue;
    const startText = match[1];
    if (startText.includes("?")) {
      const low = Number.parseInt(startText.replace(/\?/g, "0"), 16);
      const high = Number.parseInt(startText.replace(/\?/g, "F"), 16);
      if (codePoint >= low && codePoint <= high) return true;
      continue;
    }
    const low = Number.parseInt(startText, 16);
    const high = match[2] === undefined ? low : Number.parseInt(match[2], 16);
    if (codePoint >= low && codePoint <= high) return true;
  }
  return false;
}

/** A readable description of one required face, for a failure line. */
function describeFontReading(reading: FontProbeReading): string {
  return `${reading.family} ${reading.weight} "${reading.text}"`;
}

/**
 * Every reason one probe reading is not evidence that the family rendered.
 *
 * Deliberately checks four independent signals. `document.fonts.check()` alone
 * can answer true for a fallback; a face count alone cannot show the face is the
 * right weight or that the glyph came from it; and a width comparison between
 * characters says nothing about which font drew them.
 */
export function assessFontReading(reading: FontProbeReading): string[] {
  const name = describeFontReading(reading);
  if (reading.error !== null) return [`${name}: the probe failed: ${reading.error}`];

  const requestedFamily = normalizeFontFamily(reading.family);
  const wantedWeight = Number.parseInt(reading.weight, 10);
  const codePoint = reading.text.codePointAt(0) ?? 0;
  const failures: string[] = [];

  const matchingFaces = reading.loadedFaces.filter(
    (face) =>
      normalizeFontFamily(face.family) === requestedFamily &&
      face.style === "normal" &&
      fontFaceWeightCovers(face.weight, reading.weight) &&
      unicodeRangeCovers(face.unicodeRange, codePoint) &&
      face.status === "loaded",
  );
  if (matchingFaces.length === 0) {
    const seen =
      reading.loadedFaces.length === 0
        ? "no face"
        : reading.loadedFaces
            .map((face) => `${face.family} ${face.weight} ${face.style} ${face.status}`)
            .join("; ");
    failures.push(
      `${name}: no loaded face matches family, normal style, weight ${reading.weight}, and U+${codePoint
        .toString(16)
        .toUpperCase()
        .padStart(4, "0")} coverage (saw ${seen})`,
    );
  }

  if (firstFontFamily(reading.computedFamily) !== requestedFamily) {
    failures.push(
      `${name}: computed font-family starts with ${JSON.stringify(
        firstFontFamily(reading.computedFamily),
      )}, not ${JSON.stringify(requestedFamily)}`,
    );
  }

  if (
    reading.computedWeight === null ||
    !Number.isFinite(wantedWeight) ||
    Number.parseInt(reading.computedWeight, 10) !== wantedWeight
  ) {
    failures.push(
      `${name}: computed font-weight is ${JSON.stringify(
        reading.computedWeight,
      )}, not ${JSON.stringify(reading.weight)}`,
    );
  }

  if (reading.glyph === null) {
    failures.push(`${name}: the probe rendered no glyph evidence`);
  } else {
    if (!reading.glyph.ink) failures.push(`${name}: the rendered glyph had no ink`);
    if (!reading.glyph.distinctFromFallback) {
      failures.push(
        `${name}: the rendered glyph is pixel-identical to the generic fallback, so the family did not draw it`,
      );
    }
  }

  return failures;
}

/**
 * Every reason the packaged font probe is not evidence, as stage failures.
 *
 * Requires a reading for every required (family, weight, text) combination — a
 * missing reading is a hole, not a pass — and requires the deliberately missing
 * family to remain unloaded, which is what makes the probe falsifiable in place.
 */
export function assessPackagedFonts(input: {
  readonly payload: FontProbePayload | null;
  readonly error: string | null;
}): string[] {
  if (input.error !== null) return [`the font probe failed: ${input.error}`];
  if (input.payload === null) return ["the font probe returned no result"];

  const failures: string[] = [];
  const missingFamily = normalizeFontFamily(input.payload.missingControl.family);
  if (normalizeFontFamily(MISSING_FONT_CONTROL) !== missingFamily) {
    failures.push(
      `the probe's failure control asked for ${JSON.stringify(
        missingFamily,
      )}, not ${JSON.stringify(normalizeFontFamily(MISSING_FONT_CONTROL))}`,
    );
  }
  if (input.payload.missingControl.loadedFaces.length > 0) {
    failures.push(
      `the probe reported ${input.payload.missingControl.loadedFaces.length} face(s) for the missing family ${MISSING_FONT_CONTROL}; the probe cannot distinguish a missing face`,
    );
  }

  for (const required of REQUIRED_FONT_FACES) {
    for (const text of FONT_PROBE_TEXTS) {
      const reading = input.payload.readings.find(
        (entry) =>
          normalizeFontFamily(entry.family) === normalizeFontFamily(required.family) &&
          entry.weight === required.weight &&
          entry.text === text,
      );
      if (reading === undefined) {
        failures.push(
          `no reading for ${required.family} ${required.weight} "${text}"; the probe did not test it`,
        );
        continue;
      }
      failures.push(...assessFontReading(reading));
    }
  }
  return failures;
}

/**
 * The in-page font probe, executed inside the packaged WebView.
 *
 * It runs through the same `execute/async` channel as the API probe, so it
 * observes the document the user is actually looking at, with the packaged
 * bundle's stylesheets applied. Four independent signals are recorded per
 * (family, weight, text) request:
 *
 *  - the faces `document.fonts.load()` actually loaded, with their `family`,
 *    `weight`, `style` and `unicode-range` descriptors;
 *  - the computed `font-family`/`font-weight` of an element that asks for the
 *    family by name;
 *  - canvas pixels drawn with `"Family", sans-serif` versus `sans-serif` at the
 *    same weight and size — identical pixels mean the family did not draw it;
 *  - ink, so a probe that rendered nothing cannot pass.
 *
 * `document.fonts.check()` is deliberately NOT used: it answers whether SOME
 * face can render the text, which a fallback satisfies just as well.
 */
export const FONT_PROBE_SCRIPT =
  "const done = arguments[arguments.length - 1];" +
  "(async () => {" +
  `  const required = ${JSON.stringify(REQUIRED_FONT_FACES)};` +
  `  const texts = ${JSON.stringify(FONT_PROBE_TEXTS)};` +
  `  const control = ${JSON.stringify(MISSING_FONT_CONTROL)};` +
  "  const SIZE = 40;" +
  "  const WIDTH = 96;" +
  "  const HEIGHT = 56;" +
  "  const describe = (face) => ({" +
  "    family: face.family," +
  "    weight: face.weight," +
  "    style: face.style," +
  "    status: face.status," +
  "    unicodeRange: face.unicodeRange," +
  "  });" +
  "  const loadFaces = async (family, weight, text) => {" +
  "    const spec = weight + ' 16px \"' + family + '\"';" +
  "    const faces = await document.fonts.load(spec, text);" +
  "    return faces.map(describe);" +
  "  };" +
  "  const raster = (fontSpec, text) => {" +
  "    const canvas = document.createElement('canvas');" +
  "    canvas.width = WIDTH;" +
  "    canvas.height = HEIGHT;" +
  "    const ctx = canvas.getContext('2d');" +
  "    if (!ctx) throw new Error('the page has no 2D canvas context');" +
  "    ctx.font = fontSpec;" +
  "    ctx.textBaseline = 'top';" +
  "    ctx.fillText(text, 4, 4);" +
  "    const data = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;" +
  "    let ink = false;" +
  "    for (let i = 3; i < data.length; i += 4) {" +
  "      if (data[i] !== 0) { ink = true; break; }" +
  "    }" +
  "    return { ink, data };" +
  "  };" +
  "  const glyph = (family, weight, text) => {" +
  "    const withFamily = raster('normal ' + weight + ' ' + SIZE + 'px \"' + family + '\", sans-serif', text);" +
  "    const fallback = raster('normal ' + weight + ' ' + SIZE + 'px sans-serif', text);" +
  "    let identical = withFamily.data.length === fallback.data.length;" +
  "    if (identical) {" +
  "      for (let i = 0; i < withFamily.data.length; i += 1) {" +
  "        if (withFamily.data[i] !== fallback.data[i]) { identical = false; break; }" +
  "      }" +
  "    }" +
  "    return { ink: withFamily.ink, distinctFromFallback: !identical };" +
  "  };" +
  "  await document.fonts.ready;" +
  "  const host = document.createElement('div');" +
  "  host.setAttribute('data-tbai-font-probe', '');" +
  "  host.style.position = 'fixed';" +
  "  host.style.left = '-10000px';" +
  "  host.style.top = '0';" +
  "  host.style.pointerEvents = 'none';" +
  "  document.body.appendChild(host);" +
  "  const readings = [];" +
  "  try {" +
  "    for (const face of required) {" +
  "      for (const text of texts) {" +
  "        const span = document.createElement('span');" +
  "        span.style.fontFamily = '\"' + face.family + '\"';" +
  "        span.style.fontWeight = face.weight;" +
  "        span.style.fontSize = '16px';" +
  "        span.textContent = text;" +
  "        host.appendChild(span);" +
  "        const computed = getComputedStyle(span);" +
  "        const computedFamily = computed.fontFamily;" +
  "        const computedWeight = computed.fontWeight;" +
  "        span.remove();" +
  "        let loadedFaces = [];" +
  "        let error = null;" +
  "        try {" +
  "          loadedFaces = await loadFaces(face.family, face.weight, text);" +
  "        } catch (e) {" +
  "          error = String((e && e.message) || e);" +
  "        }" +
  "        let glyphEvidence = null;" +
  "        try {" +
  "          glyphEvidence = glyph(face.family, face.weight, text);" +
  "        } catch (e) {" +
  "          error = error || String((e && e.message) || e);" +
  "        }" +
  "        readings.push({" +
  "          family: face.family," +
  "          weight: face.weight," +
  "          text: text," +
  "          loadedFaces: loadedFaces," +
  "          computedFamily: computedFamily," +
  "          computedWeight: computedWeight," +
  "          glyph: glyphEvidence," +
  "          error: error," +
  "        });" +
  "      }" +
  "    }" +
  "  } finally {" +
  "    host.remove();" +
  "  }" +
  "  const controlFaces = await loadFaces(control, '400', texts[0]);" +
  "  done({ readings: readings, missingControl: { family: control, loadedFaces: controlFaces } });" +
  "})().catch((error) => done({ probeError: String((error && error.stack) || error) }));";

/** Reads the in-page font probe result, or says why it is not one. */
export function readFontProbeValue(value: unknown): {
  payload: FontProbePayload | null;
  error: string | null;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { payload: null, error: "the font probe returned no result object" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.probeError === "string") {
    return { payload: null, error: `the in-page font probe failed: ${record.probeError}` };
  }
  if (!Array.isArray(record.readings)) {
    return { payload: null, error: "the font probe returned no readings" };
  }
  const readings: FontProbeReading[] = [];
  for (const entry of record.readings) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const facesValue = Array.isArray(item.loadedFaces) ? item.loadedFaces : [];
    const faces: FontProbeFace[] = [];
    for (const face of facesValue) {
      if (face === null || typeof face !== "object" || Array.isArray(face)) continue;
      const f = face as Record<string, unknown>;
      faces.push({
        family: typeof f.family === "string" ? f.family : "",
        weight: typeof f.weight === "string" ? f.weight : "",
        style: typeof f.style === "string" ? f.style : "",
        status: typeof f.status === "string" ? f.status : "",
        unicodeRange: typeof f.unicodeRange === "string" ? f.unicodeRange : "",
      });
    }
    const glyphValue = item.glyph;
    const glyph =
      glyphValue !== null && typeof glyphValue === "object" && !Array.isArray(glyphValue)
        ? {
            ink: (glyphValue as Record<string, unknown>).ink === true,
            distinctFromFallback:
              (glyphValue as Record<string, unknown>).distinctFromFallback === true,
          }
        : null;
    readings.push({
      family: typeof item.family === "string" ? item.family : "",
      weight: typeof item.weight === "string" ? item.weight : "",
      text: typeof item.text === "string" ? item.text : "",
      loadedFaces: faces,
      computedFamily: typeof item.computedFamily === "string" ? item.computedFamily : null,
      computedWeight: typeof item.computedWeight === "string" ? item.computedWeight : null,
      glyph,
      error: typeof item.error === "string" ? item.error : null,
    });
  }

  const controlValue = record.missingControl;
  const controlRecord =
    controlValue !== null && typeof controlValue === "object" && !Array.isArray(controlValue)
      ? (controlValue as Record<string, unknown>)
      : null;
  const controlFacesValue =
    controlRecord !== null && Array.isArray(controlRecord.loadedFaces)
      ? controlRecord.loadedFaces
      : [];
  const controlFaces: FontProbeFace[] = [];
  for (const face of controlFacesValue) {
    if (face === null || typeof face !== "object" || Array.isArray(face)) continue;
    const f = face as Record<string, unknown>;
    controlFaces.push({
      family: typeof f.family === "string" ? f.family : "",
      weight: typeof f.weight === "string" ? f.weight : "",
      style: typeof f.style === "string" ? f.style : "",
      status: typeof f.status === "string" ? f.status : "",
      unicodeRange: typeof f.unicodeRange === "string" ? f.unicodeRange : "",
    });
  }

  return {
    payload: {
      readings,
      missingControl: {
        family:
          controlRecord !== null && typeof controlRecord.family === "string"
            ? controlRecord.family
            : "",
        loadedFaces: controlFaces,
      },
    },
    error: null,
  };
}

/** `{ origin, href, title }` as read from the page, with nulls for anything missing. */
export interface PageRead {
  readonly origin: string | null;
  readonly href: string | null;
  readonly title: string | null;
}

/**
 * One read of the page's zoom signals, taken from the document root.
 *
 * `devicePixelRatio` is the browser-zoom signal: WebView2 page zoom changes
 * it, while the CSS root font-size does not move. `zoom` is the app's own
 * inline CSS scale and `fontSize` its computed root font-size — both belong to
 * application scaling and are asserted separately from the browser zoom.
 */
export interface ZoomRead {
  readonly devicePixelRatio: number;
  readonly zoom: string;
  readonly fontSize: string;
}

/** One zoom chord and the two reads taken either side of it. */
export interface ZoomStep {
  readonly shortcut: string;
  readonly before: ZoomRead | null;
  readonly after: ZoomRead | null;
}

/**
 * What the wait for the document observed. Recorded so a red run distinguishes
 * "the app never navigated" from "the driver was reading a page that had not
 * loaded yet" — and, via `windowHandles`, from "the session was attached
 * somewhere else".
 */
export interface PackagedNavigation {
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  /** True when the deadline ran out with the document still blank. */
  readonly timedOut: boolean;
  /** Window handles the driver reported while the document was still blank. */
  readonly windowHandles: readonly string[] | null;
  readonly windowHandlesError: string | null;
}

export interface PackagedOriginInput {
  readonly appPath: string;
  readonly appExists: boolean;
  readonly driver: {
    readonly spawnError: string | null;
    /** Non-null when the driver process ended before a session was created. */
    readonly exitCode: number | null;
  };
  readonly session: { readonly id: string | null; readonly error: string | null };
  readonly port: { readonly value: number | null; readonly error: string | null };
  readonly script: {
    readonly origin: string | null;
    readonly href: string | null;
    readonly error: string | null;
    readonly navigation: PackagedNavigation;
  };
  readonly probe: {
    readonly status: number | null;
    readonly body: string | null;
    readonly error: string | null;
  };
  /**
   * The in-WebView font probe: every shipped family/weight rendered with `A` and
   * `Ž`, plus a deliberately missing family as the probe's own failure control.
   */
  readonly fonts: {
    readonly payload: FontProbePayload | null;
    readonly error: string | null;
  };
  /**
   * The app's own instance id, read directly from `127.0.0.1`. Required
   * evidence: without it the in-origin answer cannot be attributed to the
   * backend this launch started.
   */
  readonly appInstanceId: string | null;
  /** How that direct read went, so an absent id is reported with its cause. */
  readonly directProbe: {
    readonly status: number | null;
    readonly error: string | null;
  };
  /**
   * The zoom-hotkey probe. `baseline` is the `devicePixelRatio` read taken
   * before any chord; `steps` holds one entry per chord, in the order sent,
   * each with the reads taken immediately before and after it. All null or
   * empty when the page never loaded (the fetch stage already fails then).
   */
  readonly zoomHotkeys: {
    readonly baseline: ZoomRead | null;
    readonly steps: readonly ZoomStep[];
    readonly error: string | null;
  };
}

export interface PackagedAssessment {
  readonly ok: boolean;
  readonly stage: PackagedStage | null;
  readonly failures: readonly string[];
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A usable instance id: trimmed, and blank counts as absent.
 *
 * Identity is never a whitespace string, so `"   "` is malformed evidence
 * rather than an id that happens not to match.
 */
function normalizeInstanceId(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function instanceIdOf(text: string | null): string | null {
  const value = parseJsonObject(text)?.instanceId;
  return typeof value === "string" ? normalizeInstanceId(value) : null;
}

/** Why the direct `127.0.0.1` read produced no instance id. */
function describeDirectProbe(directProbe: PackagedOriginInput["directProbe"]): string {
  if (directProbe.error !== null) return `the direct read failed: ${directProbe.error}`;
  if (directProbe.status === null) return "the direct read was not attempted";
  if (directProbe.status !== 200) return `the direct read returned ${directProbe.status}`;
  return "the direct response carried no usable instanceId";
}

/**
 * True while the WebView is still showing the driver's blank placeholder rather
 * than a document the app loaded.
 *
 * WebView2 exposes the page target before Tauri commits the navigation to
 * `app://localhost`; the sidecar, meanwhile, writes its port as it boots. A read
 * taken between those two moments sees `href: "about:blank"` and the opaque
 * `origin: "null"` — a document that has not loaded, not an origin the app
 * chose. Measured in run 40871453744.
 */
export function awaitsNavigation(href: string | null): boolean {
  if (href === null) return true;
  const trimmed = href.trim();
  return trimmed.length === 0 || /^about:blank(?:[#?].*)?$/i.test(trimmed);
}

function describeWindowHandles(navigation: PackagedNavigation): string {
  if (navigation.windowHandles !== null) {
    const list =
      navigation.windowHandles.length === 0 ? "none" : navigation.windowHandles.join(", ");
    return `the driver reported ${navigation.windowHandles.length} window handle(s): ${list}`;
  }
  return `window handles could not be read${
    navigation.windowHandlesError === null ? "" : `: ${navigation.windowHandlesError}`
  }`;
}

/**
 * Why a document that never loaded is not an origin, with the wait behind it.
 *
 * Names the window-handle count as well: if the session were attached to the
 * wrong WebView, the driver would report more than the one configured window,
 * and this line is where that would be visible.
 */
export function unloadedDocumentFailure(
  href: string | null,
  navigation: PackagedNavigation,
): string {
  const waited = navigation.timedOut
    ? `for ${navigation.timeoutMs} ms (${navigation.attempts} reads)`
    : `after ${navigation.attempts} read(s) over ${navigation.elapsedMs} ms`;
  const state =
    href === null
      ? "returned no document URL"
      : "was still on about:blank, so no app origin was observed";
  return `the WebView ${state} ${waited}; ${describeWindowHandles(navigation)}`;
}

/**
 * Every reason the run is not evidence of what it claims, and the first stage
 * that failed.
 *
 * Pure, so the whole failure matrix is testable without a driver, an app, or a
 * WebView.
 */
export function assessPackagedOrigin(input: PackagedOriginInput): PackagedAssessment {
  const sessionFailures: string[] = [];
  if (!input.appExists) {
    sessionFailures.push(`the packaged app does not exist at ${input.appPath}`);
  }
  if (input.driver.spawnError !== null) {
    sessionFailures.push(`the driver could not be started: ${input.driver.spawnError}`);
  }
  if (input.driver.exitCode !== null) {
    sessionFailures.push(
      `the driver exited with ${input.driver.exitCode} before a session was created`,
    );
  }
  if (input.session.error !== null) sessionFailures.push(input.session.error);
  if (sessionFailures.length === 0 && input.session.id === null) {
    sessionFailures.push("the driver returned no session id");
  }

  const portFailures: string[] = [];
  if (input.port.error !== null) portFailures.push(input.port.error);
  else if (input.port.value === null) {
    portFailures.push("the app never reported a usable port");
  }

  const scriptFailures: string[] = [];
  if (input.script.error !== null) {
    scriptFailures.push(input.script.error);
  } else if (awaitsNavigation(input.script.href)) {
    // Before the origin checks: a blank document's `origin` is the string
    // "null", and reporting that as a wrong origin would blame the app for a
    // read that happened too early.
    scriptFailures.push(unloadedDocumentFailure(input.script.href, input.script.navigation));
  } else if (input.script.origin === null) {
    scriptFailures.push("the WebView reported no origin");
  } else if (input.script.origin !== EXPECTED_PACKAGED_ORIGIN) {
    scriptFailures.push(
      `the WebView's origin is ${input.script.origin}, expected ${EXPECTED_PACKAGED_ORIGIN}`,
    );
  }

  const probeFailures: string[] = [];
  if (input.probe.error !== null) {
    probeFailures.push(input.probe.error);
  } else if (input.probe.status !== 200) {
    probeFailures.push(
      `the in-origin GET /api/server/instance returned ${input.probe.status ?? "no status"}`,
    );
  } else {
    const inOriginInstanceId = instanceIdOf(input.probe.body);
    const appInstanceId = normalizeInstanceId(input.appInstanceId);
    if (inOriginInstanceId === null) {
      probeFailures.push(
        `the in-origin GET /api/server/instance returned no instanceId: ${JSON.stringify(
          tailText(input.probe.body ?? "", 500),
        )}`,
      );
    } else if (appInstanceId === null) {
      probeFailures.push(
        `the app's own instance id was not read from 127.0.0.1 (${describeDirectProbe(
          input.directProbe,
        )}), so the in-origin read cannot be attributed to the launched backend`,
      );
    } else if (inOriginInstanceId !== appInstanceId) {
      probeFailures.push(
        "identity verification failed: the in-origin read reached a different server than the " +
          `app launched (${inOriginInstanceId} vs ${appInstanceId})`,
      );
    }
  }

  const zoomFailures: string[] = [];
  const zoom = input.zoomHotkeys;
  if (zoom.error !== null) {
    zoomFailures.push(zoom.error);
  } else if (zoom.baseline !== null || zoom.steps.length > 0) {
    // The probe ran (the page loaded). Every chord is judged on its OWN
    // before/after pair: a single read after all of them lets Ctrl+0 undo what
    // Ctrl+= did, which is a pass that proves nothing.
    if (zoom.baseline === null) {
      zoomFailures.push("the zoom-hotkey probe took no baseline devicePixelRatio read");
    }
    // Every chord must have been sent and measured; a partial probe is not
    // evidence about the chords it skipped.
    const probed = new Set(zoom.steps.map((step) => step.shortcut));
    for (const shortcut of ZOOM_SHORTCUTS) {
      if (!probed.has(shortcut.label)) {
        zoomFailures.push(`the zoom-hotkey probe did not send ${shortcut.label}`);
      }
    }
    for (const step of zoom.steps) {
      if (step.before === null || step.after === null) {
        zoomFailures.push(`the ${step.shortcut} probe did not complete both reads`);
        continue;
      }
      // Browser zoom: the only signal that actually moves when the WebView
      // handles a zoom chord.
      if (step.before.devicePixelRatio !== step.after.devicePixelRatio) {
        zoomFailures.push(
          `${step.shortcut} changed window.devicePixelRatio (${step.before.devicePixelRatio} → ${step.after.devicePixelRatio}); the packaged WebView must ignore zoom hotkeys (zoomHotkeysEnabled: false)`,
        );
      }
      // Application scaling: a separate contract, reported separately.
      if (step.before.zoom !== step.after.zoom) {
        zoomFailures.push(
          `${step.shortcut} changed the app's inline CSS zoom (${JSON.stringify(
            step.before.zoom,
          )} → ${JSON.stringify(step.after.zoom)})`,
        );
      }
      if (step.before.fontSize !== step.after.fontSize) {
        zoomFailures.push(
          `${step.shortcut} changed the computed root font size (${step.before.fontSize} → ${step.after.fontSize})`,
        );
      }
    }
  }
  // No baseline, no steps, no error: the page never loaded, so the fetch stage
  // fails first and sequentialStages returns it.

  const fontFailures = assessPackagedFonts(input.fonts);

  const stages: StageResult<PackagedStage>[] = [
    { stage: "session-create", failures: sessionFailures },
    { stage: "port-wait", failures: portFailures },
    { stage: "executeScript", failures: scriptFailures },
    { stage: "fetch", failures: probeFailures },
    { stage: "fonts", failures: fontFailures },
    { stage: "zoom-hotkeys", failures: zoomFailures },
  ];
  return sequentialStages(stages);
}

/** The WebDriver session id and capabilities from a `POST /session` body. */
export function parseSessionResponse(text: string | null): {
  sessionId: string | null;
  capabilities: unknown;
  error: string | null;
} {
  const record = parseJsonObject(text);
  if (record === null) {
    return {
      sessionId: null,
      capabilities: null,
      error: `the driver returned no readable session: ${JSON.stringify(tailText(text ?? "", 500))}`,
    };
  }
  const value = record.value;
  if (value !== null && typeof value === "object") {
    const body = value as Record<string, unknown>;
    if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
      return { sessionId: body.sessionId, capabilities: body.capabilities ?? null, error: null };
    }
    const message = typeof body.message === "string" ? body.message : JSON.stringify(body);
    return {
      sessionId: null,
      capabilities: null,
      error: `the driver refused the session: ${message}`,
    };
  }
  return {
    sessionId: null,
    capabilities: null,
    error: `the driver returned no session object: ${JSON.stringify(tailText(text ?? "", 500))}`,
  };
}

/**
 * The value a WebDriver execute call returned.
 *
 * A W3C command failure carries `value.error` plus `value.message`; a script's
 * own object never carries both, so the two cannot be confused.
 */
export function parseExecuteResponse(text: string | null): {
  value: unknown;
  error: string | null;
} {
  const record = parseJsonObject(text);
  if (record === null) {
    return {
      value: null,
      error: `the driver returned no readable response: ${tailText(text ?? "", 500)}`,
    };
  }
  const value = record.value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const body = value as Record<string, unknown>;
    if (typeof body.error === "string" && typeof body.message === "string") {
      return { value: null, error: `the driver rejected the script: ${body.message}` };
    }
  }
  return { value, error: null };
}

/** `{ origin, href, title }` from the origin script, with nulls for anything missing. */
export function readOriginValue(value: unknown): PageRead {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { origin: null, href: null, title: null };
  }
  const record = value as Record<string, unknown>;
  return {
    origin: typeof record.origin === "string" ? record.origin : null,
    href: typeof record.href === "string" ? record.href : null,
    title: typeof record.title === "string" ? record.title : null,
  };
}

/** The window handles from `GET /session/{id}/window/handles`. */
export function parseWindowHandles(text: string | null): {
  handles: string[] | null;
  error: string | null;
} {
  const value = parseJsonObject(text)?.value;
  if (!Array.isArray(value)) {
    return {
      handles: null,
      error: `the driver returned no window list: ${JSON.stringify(tailText(text ?? "", 300))}`,
    };
  }
  return {
    handles: value.filter((handle): handle is string => typeof handle === "string"),
    error: null,
  };
}

/** `{ status, body }` from the in-origin fetch script. */
export function readProbeValue(value: unknown): {
  status: number | null;
  body: string | null;
  error: string | null;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: null, body: null, error: "the in-origin script returned no result" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.fetchError === "string") {
    return { status: null, body: null, error: `the in-origin fetch failed: ${record.fetchError}` };
  }
  return {
    status: typeof record.status === "number" ? record.status : null,
    body: typeof record.body === "string" ? record.body : null,
    error: null,
  };
}

/** `{ devicePixelRatio, zoom, fontSize }` from the zoom-read script, or null. */
export function readZoomValue(value: unknown): ZoomRead | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.devicePixelRatio !== "number" || !Number.isFinite(record.devicePixelRatio)) {
    return null;
  }
  if (typeof record.zoom !== "string" || typeof record.fontSize !== "string") {
    return null;
  }
  return {
    devicePixelRatio: record.devicePixelRatio,
    zoom: record.zoom,
    fontSize: record.fontSize,
  };
}

/**
 * One read of the page, or why it could not be taken.
 *
 * Deliberately not a discriminated union: the backend test project compiles
 * with `strictNullChecks: false` (`tests/tsconfig.backend.json` states why), and
 * without it TypeScript does not narrow a union, so `result.read` would be
 * `PageRead | null` in one program and `PageRead` in the other.
 */
export type PageReadResult = {
  readonly read: PageRead | null;
  readonly error: string | null;
};

/**
 * Reads the page until it has left `about:blank`, or the deadline passes.
 *
 * A read that did not happen stops the loop immediately: a driver or script
 * failure is not a symptom of a document still loading, and continuing would
 * only delay a precise diagnosis. A real — if wrong — origin also stops it: that
 * is an answer, and rejecting it is the assessment's job, not the wait's.
 */
export async function waitForNavigation(
  readPage: () => Promise<PageReadResult>,
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<{
  readonly read: PageRead | null;
  readonly error: string | null;
  readonly navigation: PackagedNavigation;
}> {
  const timeoutMs = options.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let read: PageRead | null = null;
  let error: string | null = null;
  let timedOut = false;
  for (;;) {
    attempts += 1;
    const result = await readPage();
    if (result.read === null) {
      error = result.error ?? "the WebView read returned no value";
      break;
    }
    read = result.read;
    if (!awaitsNavigation(read.href)) break;
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    await sleep(pollMs);
  }
  return {
    read,
    error,
    navigation: {
      attempts,
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
      timedOut,
      windowHandles: null,
      windowHandlesError: null,
    },
  };
}

const ORIGIN_SCRIPT =
  "return { origin: window.location.origin, href: window.location.href, title: document.title };";

const ZOOM_READ_SCRIPT =
  "return { devicePixelRatio: window.devicePixelRatio, zoom: document.documentElement.style.zoom || '', fontSize: getComputedStyle(document.documentElement).fontSize };";

/** WebDriver spec key for Control (U+E009). */
const KEY_CONTROL = "\uE009";
/** WebDriver spec key for Shift (U+E008) — what turns Ctrl+= into Ctrl++. */
const KEY_SHIFT = "\uE008";

/**
 * Reads `window.devicePixelRatio` plus the app's inline CSS `zoom` and computed
 * root font-size. Taken immediately before and immediately after each chord:
 * the pixel ratio is the browser-zoom signal, the other two are application
 * scaling and are asserted separately.
 */
async function readZoomFromDriver(
  driverBaseUrl: string,
  sessionId: string,
): Promise<{ read: ZoomRead | null; error: string | null }> {
  const call = await httpJson(`${driverBaseUrl}/session/${sessionId}/execute/sync`, {
    method: "POST",
    body: { script: ZOOM_READ_SCRIPT, args: [] },
    timeoutMs: CDP_STEP_TIMEOUT_MS,
  });
  if (call.status === null) {
    return {
      read: null,
      error: `could not read the document root: ${call.error ?? "unknown error"}`,
    };
  }
  const executed = parseExecuteResponse(call.text);
  if (executed.error !== null) return { read: null, error: executed.error };
  const read = readZoomValue(executed.value);
  if (read === null) {
    return { read: null, error: "the zoom-read script returned no result" };
  }
  return { read, error: null };
}

/**
 * Sends one Ctrl+<key> chord to the WebView via the WebDriver Actions API,
 * then releases the keyboard state. With `zoomHotkeysEnabled: false` the
 * WebView ignores the chord; with it enabled, the pixel ratio would change and
 * the probe would fail.
 */
async function sendZoomHotkey(
  driverBaseUrl: string,
  sessionId: string,
  shortcut: (typeof ZOOM_SHORTCUTS)[number],
): Promise<{ error: string | null }> {
  const chord = [{ type: "keyDown", value: KEY_CONTROL }];
  if (shortcut.shift) chord.push({ type: "keyDown", value: KEY_SHIFT });
  chord.push({ type: "keyDown", value: shortcut.key });
  chord.push({ type: "keyUp", value: shortcut.key });
  if (shortcut.shift) chord.push({ type: "keyUp", value: KEY_SHIFT });
  chord.push({ type: "keyUp", value: KEY_CONTROL });

  const actions = { actions: [{ type: "key", id: "keyboard", actions: chord }] };
  const sent = await httpJson(`${driverBaseUrl}/session/${sessionId}/actions`, {
    method: "POST",
    body: actions,
    timeoutMs: CDP_STEP_TIMEOUT_MS,
  });
  if (sent.status === null) {
    return { error: `could not send ${shortcut.label}: ${sent.error ?? "unknown error"}` };
  }
  if (sent.status >= 400) {
    return {
      error: `the driver rejected ${shortcut.label} (HTTP ${sent.status}): ${tailText(sent.text ?? "", 300)}`,
    };
  }
  const released = await httpJson(`${driverBaseUrl}/session/${sessionId}/actions`, {
    method: "DELETE",
    timeoutMs: CDP_STEP_TIMEOUT_MS,
  });
  if (released.status === null || released.status >= 400) {
    return {
      error: `could not release the keyboard after ${shortcut.label}: ${released.error ?? `HTTP ${released.status}`}`,
    };
  }
  return { error: null };
}

async function readPageFromDriver(
  driverBaseUrl: string,
  sessionId: string,
): Promise<PageReadResult> {
  const call = await httpJson(`${driverBaseUrl}/session/${sessionId}/execute/sync`, {
    method: "POST",
    body: { script: ORIGIN_SCRIPT, args: [] },
    timeoutMs: CDP_STEP_TIMEOUT_MS,
  });
  if (call.status === null) {
    return {
      read: null,
      error: `could not execute in the WebView: ${call.error ?? "unknown error"}`,
    };
  }
  const executed = parseExecuteResponse(call.text);
  if (executed.error !== null) return { read: null, error: executed.error };
  return { read: readOriginValue(executed.value), error: null };
}

async function readWindowHandles(
  driverBaseUrl: string,
  sessionId: string,
): Promise<{ handles: string[] | null; error: string | null }> {
  const call = await httpJson(`${driverBaseUrl}/session/${sessionId}/window/handles`, {
    timeoutMs: CDP_STEP_TIMEOUT_MS,
  });
  if (call.status === null) {
    return {
      handles: null,
      error: `the window-handle request failed: ${call.error ?? "unknown error"}`,
    };
  }
  return parseWindowHandles(call.text);
}

interface PackagedOptions {
  readonly appPath: string;
  readonly outDir: string;
  readonly driverBinary: string;
  readonly nativeDriver: string | null;
}

function parseArgs(argv: readonly string[]): PackagedOptions | null {
  let appPath = DEFAULT_APP;
  let outDir = DEFAULT_OUT_DIR;
  let driverBinary = process.env.TAURI_DRIVER ?? "tauri-driver";
  let nativeDriver = process.env.EDGEDRIVER ?? null;
  for (const arg of argv) {
    if (arg.startsWith("--app=")) appPath = path.resolve(arg.slice("--app=".length).trim());
    else if (arg.startsWith("--out=")) outDir = path.resolve(arg.slice("--out=".length).trim());
    else if (arg.startsWith("--driver=")) driverBinary = arg.slice("--driver=".length).trim();
    else if (arg.startsWith("--native-driver=")) {
      nativeDriver = path.resolve(arg.slice("--native-driver=".length).trim());
    } else {
      console.error(`[g1] unknown argument: ${arg}`);
      return null;
    }
  }
  if (appPath.length === 0 || outDir.length === 0 || driverBinary.length === 0) {
    console.error("[g1] --app=, --out= and --driver= must not be empty");
    return null;
  }
  return { appPath, outDir, driverBinary, nativeDriver };
}

/**
 * Probes the driver binary before spawning it, so a missing binary becomes a
 * recorded failure with the OS error instead of an asynchronous 'error' event
 * racing the first request.
 *
 * `tauri-driver` has no version flag — it treats one as an unknown argument and
 * exits 1 ("Error: unused arguments left") — so the probe is `--help`, which
 * `src/cli.rs` implements by printing the banner and exiting 0. The version is
 * therefore recorded as null rather than invented.
 */
export function checkDriverBinary(binary: string): {
  available: boolean;
  version: string | null;
  helpLine: string | null;
  error: string | null;
} {
  const result = spawnSync(binary, ["--help"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error) {
    return { available: false, version: null, helpLine: null, error: errorMessage(result.error) };
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const helpLine =
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null;
  if (result.status !== 0) {
    return {
      available: false,
      version: null,
      helpLine,
      error: `${binary} --help exited ${result.status ?? "null"}: ${tailText(output, 500)}`,
    };
  }
  return { available: true, version: null, helpLine, error: null };
}

export type HostIntegrity = "low" | "medium" | "high" | "system" | "unknown";

/**
 * Reads the mandatory integrity level out of `whoami /groups` output.
 *
 * The level is recorded because the observation depends on it: WebView2 Runtime
 * 150 and later ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` when the host is
 * elevated, and msedgedriver passes the `--remote-debugging-port` it attaches to
 * through that variable (wry#1782, WebView2Feedback#5645). An elevated run
 * therefore never opens the CDP endpoint, so the evidence has to say which level
 * it was taken at instead of assuming the session timeout was the app's fault.
 */
export function parseIntegrityLevel(text: string): HostIntegrity {
  const match = /Mandatory Label\\(\w+)(?: Mandatory Level)?/.exec(text);
  if (match === null) return "unknown";
  const level = match[1].toLowerCase();
  return level === "low" || level === "medium" || level === "high" || level === "system"
    ? level
    : "unknown";
}

/** The current host's integrity level; `unknown` when it cannot be read. */
function readHostIntegrity(): { level: HostIntegrity; error: string | null } {
  const result = spawnSync("whoami", ["/groups"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error) return { level: "unknown", error: errorMessage(result.error) };
  const level = parseIntegrityLevel(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.status !== 0) {
    return { level, error: `whoami /groups exited ${result.status ?? "null"}` };
  }
  return {
    level,
    error: level === "unknown" ? "whoami /groups reported no mandatory label" : null,
  };
}

async function waitForPortMirror(
  mirrorPath: string,
  timeoutMs: number,
): Promise<{ port: number | null; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = fs.readFileSync(mirrorPath, "utf8").trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
        return { port: parsed, error: null };
      }
    } catch {
      /* not written yet */
    }
    if (Date.now() > deadline) {
      return {
        port: null,
        error: `the app did not write a usable port to ${mirrorPath} within ${timeoutMs} ms`,
      };
    }
    await sleep(POLL_MS);
  }
}

async function createSession(
  driverBaseUrl: string,
  appPath: string,
): Promise<{
  response: ReturnType<typeof parseSessionResponse>;
  status: number | null;
  error: string | null;
}> {
  const deadline = Date.now() + DRIVER_READY_TIMEOUT_MS;
  let last: { status: number | null; text: string | null; error: string | null } = {
    status: null,
    text: null,
    error: null,
  };
  for (;;) {
    last = await httpJson(`${driverBaseUrl}/session`, {
      method: "POST",
      body: { capabilities: { alwaysMatch: { "tauri:options": { application: appPath } } } },
      timeoutMs: CDP_STEP_TIMEOUT_MS,
    });
    if (last.status !== null) break;
    if (Date.now() > deadline) break;
    await sleep(POLL_MS);
  }
  if (last.status === null) {
    return {
      response: { sessionId: null, capabilities: null, error: null },
      status: null,
      error: `the driver did not accept a request within ${DRIVER_READY_TIMEOUT_MS} ms: ${last.error ?? "unknown error"}`,
    };
  }
  return { response: parseSessionResponse(last.text), status: last.status, error: null };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: bun run verify:packaged-origin [--app=<exe>] [--out=<dir>]\n" +
        "                                      [--driver=<tauri-driver>] [--native-driver=<msedgedriver>]",
    );
    return 0;
  }
  const options = parseArgs(argv);
  if (!options) return 1;

  const runId = `${new Date().toISOString()}-${os.hostname()}`;
  const evidencePath = path.join(options.outDir, "packaged.json");
  fs.rmSync(evidencePath, { force: true });
  const hostIntegrity = readHostIntegrity();
  const elevated = hostIntegrity.level === "high" || hostIntegrity.level === "system";

  const appExists = fs.existsSync(options.appPath);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-origin-packaged-"));
  const dataDir = path.join(tempRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const driverLogPath = path.join(tempRoot, "tauri-driver.log");
  const appLogPath = path.join(tempRoot, "tbai.log");

  const session: {
    id: string | null;
    capabilities: unknown;
    status: number | null;
    error: string | null;
  } = {
    id: null,
    capabilities: null,
    status: null,
    error: null,
  };
  const driver: { spawnError: string | null; exitCode: number | null } = {
    spawnError: null,
    exitCode: null,
  };
  const port: { value: number | null; error: string | null } = { value: null, error: null };
  const script: {
    origin: string | null;
    href: string | null;
    title: string | null;
    error: string | null;
  } = {
    origin: null,
    href: null,
    title: null,
    error: null,
  };
  const navigation = {
    attempts: 0,
    elapsedMs: 0,
    timeoutMs: NAVIGATION_TIMEOUT_MS,
    timedOut: false,
    windowHandles: null as string[] | null,
    windowHandlesError: null as string | null,
  };
  const probe: { status: number | null; body: string | null; error: string | null } = {
    status: null,
    body: null,
    error: null,
  };
  const fonts: { payload: FontProbePayload | null; error: string | null } = {
    payload: null,
    error: null,
  };
  const zoomHotkeys: {
    baseline: ZoomRead | null;
    steps: ZoomStep[];
    error: string | null;
  } = {
    baseline: null,
    steps: [],
    error: null,
  };
  const directProbe: { status: number | null; error: string | null } = {
    status: null,
    error: null,
  };
  let appInstanceId: string | null = null;
  let driverVersion: string | null = null;
  let driverHelpLine: string | null = null;
  let driverPort: number | null = null;
  let nativePort: number | null = null;
  let driverStop: ProcessStopResult = {
    attempted: false,
    method: null,
    descendants: [],
    survivors: [],
    confirmed: true,
    errors: [],
  };
  let sessionDeleteStatus: number | null = null;
  let logFd: number | null = null;
  let driverChild: ReturnType<typeof spawn> | null = null;
  const teardownErrors: string[] = [];

  try {
    if (!appExists) {
      // Nothing to drive. The assessment below records this at `session-create`;
      // the evidence is still written, which is the point of running the script
      // on a machine that has neither the packaged app nor the driver.
      driver.spawnError = null;
    } else {
      const checked = checkDriverBinary(options.driverBinary);
      driverVersion = checked.version;
      driverHelpLine = checked.helpLine;
      if (!checked.available) {
        driver.spawnError = checked.error ?? "the driver is not available";
      } else {
        driverPort = await allocateFreePort();
        nativePort = await allocateFreePort();
        const args = [
          ...(options.nativeDriver === null ? [] : ["--native-driver", options.nativeDriver]),
          "--port",
          String(driverPort),
          "--native-port",
          String(nativePort),
        ];
        logFd = fs.openSync(driverLogPath, "a");
        driverChild = spawn(options.driverBinary, args, {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            DATA_DIR: dataDir,
            // Explicit, so the sanitized upload has a known path in every install.
            TBAI_LOG_FILE: appLogPath,
          },
          stdio: ["ignore", logFd, logFd],
          windowsHide: true,
        });
        driverChild.on("error", (error) => {
          driver.spawnError = errorMessage(error);
        });
        driverChild.on("exit", (code) => {
          driver.exitCode = code;
        });

        const created = await createSession(`http://127.0.0.1:${driverPort}`, options.appPath);
        session.status = created.status;
        session.error = created.error ?? created.response.error;
        session.id = created.response.sessionId;
        session.capabilities = created.response.capabilities;

        if (session.id !== null) {
          port.value = await (async () => {
            const mirror = await waitForPortMirror(
              path.join(dataDir, "port"),
              PORT_MIRROR_TIMEOUT_MS,
            );
            port.error = mirror.error;
            return mirror.port;
          })();

          if (port.value !== null) {
            const direct = await httpJson(`http://127.0.0.1:${port.value}/api/server/instance`, {
              timeoutMs: CDP_STEP_TIMEOUT_MS,
            });
            directProbe.status = direct.status;
            directProbe.error = direct.status === null ? (direct.error ?? "no response") : null;
            appInstanceId = instanceIdOf(direct.text);

            const driverBaseUrl = `http://127.0.0.1:${driverPort}`;
            const sessionId = session.id;
            const waited = await waitForNavigation(() =>
              readPageFromDriver(driverBaseUrl, sessionId),
            );
            script.error = waited.error;
            if (waited.read !== null) {
              script.origin = waited.read.origin;
              script.href = waited.read.href;
              script.title = waited.read.title;
            }
            Object.assign(navigation, waited.navigation);

            const loaded = script.error === null && !awaitsNavigation(script.href);
            if (!loaded) {
              // Nothing loaded, so there is no origin to ask from. Recording the
              // handles is what separates "this page had not loaded" from "this
              // session is looking at another window".
              const handles = await readWindowHandles(driverBaseUrl, sessionId);
              navigation.windowHandles = handles.handles;
              navigation.windowHandlesError = handles.error;
            } else {
              const apiUrl = `http://127.0.0.1:${port.value}/api/server/instance`;
              const fetchCall = await httpJson(
                `${driverBaseUrl}/session/${sessionId}/execute/async`,
                {
                  method: "POST",
                  body: {
                    script:
                      "const done = arguments[arguments.length - 1];" +
                      `fetch(${JSON.stringify(apiUrl)})` +
                      "  .then(async (response) => done({ status: response.status, body: await response.text() }))" +
                      "  .catch((error) => done({ fetchError: String(error) }));",
                    args: [],
                  },
                  timeoutMs: CDP_STEP_TIMEOUT_MS,
                },
              );
              if (fetchCall.status === null) {
                probe.error = `could not run the in-origin fetch: ${fetchCall.error ?? "unknown error"}`;
              } else {
                const executed = parseExecuteResponse(fetchCall.text);
                probe.error = executed.error;
                const read = readProbeValue(executed.value);
                probe.status = read.status;
                probe.body = read.body;
                probe.error = read.error ?? probe.error;
              }

              // Font probe: the packaged bundle's own stylesheets decide whether
              // Inter / JetBrains Mono / Lato render. Shipped files are not
              // evidence — a stylesheet import that never applied leaves the text
              // on a fallback that looks acceptable in a screenshot.
              const fontCall = await httpJson(
                `${driverBaseUrl}/session/${sessionId}/execute/async`,
                {
                  method: "POST",
                  body: { script: FONT_PROBE_SCRIPT, args: [] },
                  timeoutMs: CDP_STEP_TIMEOUT_MS,
                },
              );
              if (fontCall.status === null) {
                fonts.error = `could not run the in-page font probe: ${fontCall.error ?? "unknown error"}`;
              } else {
                const executed = parseExecuteResponse(fontCall.text);
                if (executed.error !== null) {
                  fonts.error = executed.error;
                } else {
                  const read = readFontProbeValue(executed.value);
                  fonts.payload = read.payload;
                  fonts.error = read.error;
                }
              }

              // Zoom-hotkey probe: with `zoomHotkeysEnabled: false` the
              // WebView ignores every zoom chord, so window.devicePixelRatio
              // must be identical either side of EACH one. Each chord gets its
              // own pair of reads — one read after all of them would let
              // Ctrl+0 undo what Ctrl+= did and report a pass.
              const baseline = await readZoomFromDriver(driverBaseUrl, sessionId);
              zoomHotkeys.baseline = baseline.read;
              zoomHotkeys.error = baseline.error;
              if (baseline.read !== null) {
                for (const shortcut of ZOOM_SHORTCUTS) {
                  const before = await readZoomFromDriver(driverBaseUrl, sessionId);
                  const step: {
                    shortcut: string;
                    before: ZoomRead | null;
                    after: ZoomRead | null;
                  } = { shortcut: shortcut.label, before: before.read, after: null };
                  zoomHotkeys.steps.push(step);
                  if (before.error !== null) {
                    zoomHotkeys.error = before.error;
                    break;
                  }
                  const sent = await sendZoomHotkey(driverBaseUrl, sessionId, shortcut);
                  if (sent.error !== null) {
                    zoomHotkeys.error = sent.error;
                    break;
                  }
                  const after = await readZoomFromDriver(driverBaseUrl, sessionId);
                  step.after = after.read;
                  if (after.error !== null) {
                    zoomHotkeys.error = after.error;
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    const message = `the run failed before the observation completed: ${errorMessage(error)}`;
    if (session.id === null) session.error = session.error ?? message;
    else probe.error = probe.error ?? message;
  }

  // Teardown, on every path. The session delete is attempted before the tree is
  // stopped, because a graceful close is what tells the app to shut its sidecar
  // down; the tree stop is the guarantee.
  if (driverChild !== null && driverPort !== null && session.id !== null) {
    const deleted = await httpJson(`http://127.0.0.1:${driverPort}/session/${session.id}`, {
      method: "DELETE",
      timeoutMs: CDP_STEP_TIMEOUT_MS,
    });
    sessionDeleteStatus = deleted.status;
    if (deleted.status === null)
      teardownErrors.push(`deleting the session failed: ${deleted.error}`);
  }
  if (driverChild?.pid !== undefined) {
    try {
      driverStop = stopProcessTree(driverChild.pid);
      teardownErrors.push(...driverStop.errors);
    } catch (error) {
      driverStop = {
        attempted: true,
        method: null,
        descendants: [],
        survivors: [],
        confirmed: false,
        errors: [errorMessage(error)],
      };
      teardownErrors.push(`stopping the driver failed: ${errorMessage(error)}`);
    }
  }
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch (error) {
      teardownErrors.push(`closing the driver log failed: ${errorMessage(error)}`);
    }
    logFd = null;
  }
  if (driverStop.survivors.length > 0) {
    teardownErrors.push(`the driver tree left pid(s) ${driverStop.survivors.join(", ")} running`);
  }

  let rawDriverLog = "";
  try {
    if (fs.existsSync(driverLogPath)) rawDriverLog = fs.readFileSync(driverLogPath, "utf8");
  } catch (error) {
    teardownErrors.push(`reading the driver log failed: ${errorMessage(error)}`);
  }
  const driverLog = sanitizeLogFile(driverLogPath, path.join(options.outDir, "tauri-driver.log"));
  const appLog = sanitizeLogFile(appLogPath, path.join(options.outDir, "tbai.log"));
  // An absent log is normal when nothing launched; only a source that existed
  // and could not be copied is a teardown failure.
  if (driverLog.sourceExisted && !driverLog.written) {
    teardownErrors.push(`the driver log was not uploaded: ${driverLog.error}`);
  }
  if (appLog.sourceExisted && !appLog.written) {
    teardownErrors.push(`the application log was not uploaded: ${appLog.error}`);
  }

  let tempRootRemoved = false;
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRootRemoved = !fs.existsSync(tempRoot);
  } catch (error) {
    teardownErrors.push(`removing the temporary root failed: ${errorMessage(error)}`);
  }

  const assessment = assessPackagedOrigin({
    appPath: options.appPath,
    appExists,
    driver,
    session: { id: session.id, error: session.error },
    port,
    script: {
      origin: script.origin,
      href: script.href,
      error: script.error,
      navigation,
    },
    probe,
    fonts,
    directProbe,
    appInstanceId,
    zoomHotkeys,
  });

  const failures = [...assessment.failures];
  if (elevated && assessment.stage === "session-create") {
    failures.push(
      "host: elevated, so WebView2 ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS and the " +
        "debugging port msedgedriver attaches to never opens (wry#1782); run this at medium integrity",
    );
  }
  if (driverStop.attempted && !driverStop.confirmed) {
    failures.push("teardown: the driver process tree did not terminate");
  }
  if (!tempRootRemoved) failures.push("teardown: the temporary root was not removed");
  for (const error of teardownErrors) failures.push(`teardown: ${error}`);

  const inOriginInstanceId = instanceIdOf(probe.body);
  const evidence = {
    schemaVersion: 1 as const,
    kind: "packaged" as const,
    runId,
    generatedAt: new Date().toISOString(),
    expectedOrigin: EXPECTED_PACKAGED_ORIGIN,
    app: { path: options.appPath, exists: appExists, dataDir, logPath: appLogPath },
    host: {
      platform: process.platform,
      integrity: hostIntegrity.level,
      elevated,
      integrityError: hostIntegrity.error,
    },
    driver: {
      binary: options.driverBinary,
      nativeDriver: options.nativeDriver,
      version: driverVersion,
      helpLine: driverHelpLine,
      port: driverPort,
      nativePort,
      pid: driverChild?.pid ?? null,
      spawnError: driver.spawnError,
      exitCode: driver.exitCode,
      sessionStatus: session.status,
      sessionId: session.id,
      capabilities: session.capabilities,
    },
    port,
    script,
    /** How the origin was obtained: the wait for the document, and what it saw. */
    navigation,
    probe,
    /** The in-WebView font probe: every shipped family/weight, both probe glyphs. */
    fonts,
    /** How the direct read of the launched app's own identity went. */
    directProbe,
    appInstanceId,
    /** The zoom-hotkey probe: devicePixelRatio either side of each chord. */
    zoomHotkeys,
    observations: {
      originMatchesExpected: script.origin === EXPECTED_PACKAGED_ORIGIN,
      inOriginApiStatus: probe.status,
      /** The id the in-origin read returned. */
      inOriginInstanceId,
      /** True only when both ids were read and are equal; missing evidence fails. */
      instanceMatchesApp: appInstanceId !== null && inOriginInstanceId === appInstanceId,
      /**
       * The browser-zoom baseline the chords were measured against. Page zoom
       * moves this number; the CSS root font-size does not.
       */
      devicePixelRatio: zoomHotkeys.baseline?.devicePixelRatio ?? null,
    },
    assessment: { ok: assessment.ok && failures.length === 0, stage: assessment.stage, failures },
    teardown: { sessionDeleteStatus, driverStop, tempRootRemoved, errors: teardownErrors },
    logs: {
      driver: {
        sourceExisted: driverLog.sourceExisted,
        written: driverLog.written,
        redactions: driverLog.redactions,
        truncatedChars: driverLog.truncatedChars,
        error: driverLog.error,
      },
      app: {
        sourceExisted: appLog.sourceExisted,
        written: appLog.written,
        redactions: appLog.redactions,
        truncatedChars: appLog.truncatedChars,
        error: appLog.error,
      },
      /** Sanitized: this file is uploaded too. */
      driverTail: sanitizeLogText(tailText(rawDriverLog, LOG_TAIL_CHARS)).text,
    },
  };

  const written = writeEvidenceFile(evidencePath, evidence);
  if (!written.written) {
    console.error(`[g1] ${written.error}`);
    return 1;
  }

  const ok = evidence.assessment.ok && written.written;
  console.log(`[g1] ${ok ? "PASS" : "FAIL"} — ${evidencePath}`);
  if (!ok) {
    console.error(`[g1] stage: ${assessment.stage ?? "(teardown only)"}`);
    for (const failure of failures) console.error(`[g1]   ${failure}`);
  }
  return ok ? 0 : 1;
}

// Guarded so the unit test can import the pure assessment without driving an app.
if (import.meta.main) {
  process.exitCode = await main();
}
