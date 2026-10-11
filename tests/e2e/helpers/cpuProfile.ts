import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CDPSession, Page } from "@playwright/test";

/**
 * Renderer CPU attribution for the chat surfaces.
 *
 * ## What problem this exists to solve
 *
 * The app's CPU cost lives in the renderer (the Tauri WebView2 process, or a
 * browser tab in development), not in the Bun backend - a live sample of the
 * packaged app showed TBAi.exe and tbai-server.exe at ~0% while the WebView2
 * tree carried the load. "The webview takes too much resources" is therefore
 * always a question about the RENDERER, and this measures the renderer and
 * nothing else.
 *
 * Two independent measurements, because the interesting failure modes look
 * identical from the outside:
 *
 * 1. Cumulative CDP Performance counters (ScriptDuration, LayoutDuration,
 *    RecalcStyleDuration, TaskDuration). These answer the coarse question -
 *    "is the cost JavaScript, layout, or style?" - which is the first fork in
 *    the road. A ScriptDuration blowout points at markdown re-parsing and Shiki
 *    tokenization; a LayoutDuration/RecalcStyleDuration blowout points at DOM
 *    churn such as mermaid SVG being re-injected. Cheap, low overhead, and
 *    stable enough to compare across runs.
 *
 * 2. A sampling CPU profile, aggregated to SELF time per function. This is
 *    what actually names the culprit. The counters above say "script" and this
 *    says "remark parse, 62% of script time" or "oniguruma WASM, 41%".
 *
 * ## Why the counters are deltas, not absolutes
 *
 * Performance counters are cumulative from the moment Performance.enable is
 * called, so only the difference across the measured window is meaningful.
 * Every read here is paired with a baseline read and subtracted, which is why
 * createRendererProbe takes its "before" sample at construction time rather
 * than letting callers remember to.
 *
 * ## Fidelity caveat, stated once so nobody is surprised
 *
 * The e2e suite runs in msedge/chromium, NOT in the packaged Tauri WebView2.
 * It is the same engine family, so the RELATIVE attribution (which subsystem
 * dominates, and whether cost is super-linear in reply length) carries over and
 * is what this harness is for. ABSOLUTE millisecond numbers do not, because a
 * headed browser tab and a WebView2 child process have different memory
 * pressure and scheduling. Treat absolute numbers as a within-run comparison
 * only, and confirm a real fix against the packaged app.
 *
 * ## Cost of measuring
 *
 * The sampling profiler is stopped on the main thread, so a long profile is not
 * free - it is a debugger attached to the thing being debugged. Sampling
 * interval is deliberately coarse (1ms) to keep overhead near noise for a
 * multi-second window. Do not profile for tens of seconds and then quote the
 * numbers as if they were uninstrumented.
 */

const SAMPLING_INTERVAL_US = 1000;
const METRIC_KEYS = {
  scriptMs: "ScriptDuration",
  layoutMs: "LayoutDuration",
  styleMs: "RecalcStyleDuration",
  taskMs: "TaskDuration",
} as const;

export interface RendererCpuDelta {
  /** JS + WASM execution time. Markdown parsing and Shiki live here. */
  readonly scriptMs: number;
  /** Layout time. DOM churn and innerHTML re-injection show up here. */
  readonly layoutMs: number;
  /** Style recalculation time. Class churn and re-injected SVG show up here. */
  readonly styleMs: number;
  /** Total main-thread task time - the number that maps to observed CPU%. */
  readonly taskMs: number;
  /** Milliseconds of wall-clock the measured window spanned. */
  readonly windowMs: number;
}

export interface HotFunction {
  /** Function name, or a stable fallback when the frame has no name. */
  readonly name: string;
  /** Script URL, trimmed to something readable in a report. */
  readonly url: string;
  /** Self time in milliseconds, excluding callees. */
  readonly selfMs: number;
  /** Share of all sampled self time, 0-100. */
  readonly sharePct: number;
  /** 1-based line in the served script, for looking the frame up by hand. */
  readonly line: number;
  /** 0-based column in the served script, for looking the frame up by hand. */
  readonly column: number;
  /**
   * Named ancestors of this frame, outermost first.
   *
   * This is what makes an unnameable frame actionable. The hottest attributable
   * frame in the code-heavy stream was a bare `() => {` at 2.8% - the source
   * line says nothing, but the chain below it named the subsystem that owns it.
   * Frameless frames are skipped so the path reads as real call sites.
   */
  readonly callPath: readonly string[];
  /**
   * Source excerpt at this position, when the script could be read locally.
   *
   * This is what resolves the frames V8 reports as `(anonymous)`. In an
   * unminified build the reported line/column indexes straight into the served
   * text, so the surrounding source names the function without needing a
   * source-map library - see `annotateFromSources`.
   */
  readonly source: string | null;
}

/**
 * Frames that report no JavaScript function, and therefore cannot be
 * symbolicated by any build.
 *
 * This exists because of a measurement, not a guess. `(program)` was the
 * single largest self-time bucket in the first profile (18-24%), and the
 * obvious plan was a symbolicated build to name it. Probing showed that plan
 * cannot work:
 *
 * - `(program)` holds 78-100% of self time for EVERY workload tried - plain
 *   arithmetic, string building, regex, JSON, DOM churn - and 100% on a fully
 *   idle page, always with an empty script URL and zero positionTicks.
 * - Under `--js-flags=--jitless`, which stops V8 compiling to native code and
 *   should have preserved a JavaScript frame, it stayed at 83-88%.
 *
 * So it is the sampler's bucket for time with no frame attached - idle,
 * collector, and other non-JS work - not application code with a mangled name.
 * A source map has nothing to resolve.
 *
 * Reporting it inline would therefore rank "(program) 24%" above every real
 * function forever and hide the names that CAN be read. It is totalled
 * separately so the ranking is only about attributable work.
 */
export interface UnattributableBucket {
  readonly name: "(program)" | "(idle)" | "(garbage collector)" | "(other frameless)";
  readonly selfMs: number;
  readonly sharePct: number;
}

export interface RendererCpuReport {
  readonly totals: RendererCpuDelta;
  readonly hot: readonly HotFunction[];
  /** Frame time that no build can attribute, broken out. Never in `hot`. */
  readonly unattributable: readonly UnattributableBucket[];
  /** Combined share of all frame time, 0-100. */
  readonly unattributablePct: number;
  /** Number of profiler samples that landed inside the window. */
  readonly sampleCount: number;
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string };
  children?: number[];
  parent?: number;
}

interface ProfileResult {
  nodes: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
}

type MetricName = (typeof METRIC_KEYS)[keyof typeof METRIC_KEYS];

async function readCounters(cdp: CDPSession): Promise<Record<MetricName, number>> {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as {
    metrics: Array<{ name: string; value: number }>;
  };
  const found = new Map(metrics.map((m) => [m.name, m.value]));
  const out = {} as Record<MetricName, number>;
  for (const key of Object.values(METRIC_KEYS)) {
    out[key as MetricName] = found.get(key) ?? 0;
  }
  return out;
}

/**
 * V8's synthetic frames: time with no JavaScript function behind it.
 *
 * Kept in one place because the classification is the whole point: these must
 * be totalled apart from real functions, never ranked beside them. See
 * `UnattributableBucket` for the measurements behind that decision.
 */
const FRAMELESS_LABELS = new Set(["(program)", "(idle)", "(garbage collector)"]);

type BucketName = "(program)" | "(idle)" | "(garbage collector)" | "(other frameless)";

function bucketFor(functionName: string, url: string): BucketName | null {
  if (FRAMELESS_LABELS.has(functionName)) return functionName as BucketName;
  // An unnamed frame in a script with no URL is native work; an unnamed frame
  // in a real script is an anonymous function, which IS attributable and
  // stays in the ranking.
  if (functionName === "" && url === "") return "(other frameless)";
  return null;
}

/** CDP node ids are opaque; this labels the ones worth reading in a report. */
function describeFrame(node: ProfileNode): {
  name: string;
  url: string;
  line: number;
  column: number;
} {
  const raw = node.callFrame.functionName.trim();
  const url = node.callFrame.url;
  const name = raw !== "" ? raw : "(anonymous)";
  const shortUrl = url === "" ? "(native)" : url.split("/").slice(-1)[0] || url;
  return {
    name,
    url: shortUrl,
    // CDP reports 0-based; keep 0 in the type and let formatHotFunctions add 1,
    // because -1 means "no position" and must not be silently shown as line 0.
    line: node.callFrame.lineNumber,
    column: node.callFrame.columnNumber,
  };
}

/** How many ancestors to keep before the chain stops being readable. */
const MAX_CALL_PATH_DEPTH = 8;

/**
 * The named ancestors of a node, outermost first, for naming unnameable frames.
 *
 * Self time alone answers "which function was hot", which is useless when the
 * hot function is `() => {`. The caller almost always is not: an anonymous
 * callback reached from a named subsystem is attributable even though its own
 * name is empty. Walking up is what turns a bare position into "react-shiki
 * tokenizer", the same way a human reads a flame chart.
 *
 * The walk needs `parents`, because a CDP `Profile` node carries `children` but
 * NO `parent` field - trusting `node.parent` silently yields an empty path for
 * every frame, which is exactly what the first run of this reported
 * ("no attributable call paths") rather than an error.
 *
 * Frameless frames are skipped so the chain stays short and legible, and the
 * walk is visit-bounded because profile trees are DAGs in practice (a node can
 * be referenced from more than one parent) and must not spin.
 */
function callPathOf(parents: Map<number, number>, byId: Map<number, ProfileNode>, startId: number): readonly string[] {
  const path: string[] = [];
  const seen = new Set<number>([startId]);
  let currentId: number | undefined = parents.get(startId);
  while (currentId !== undefined && path.length < MAX_CALL_PATH_DEPTH) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const parent: ProfileNode | undefined = byId.get(currentId);
    if (!parent) break;
    const name = parent.callFrame.functionName.trim();
    if (name !== "" && !FRAMELESS_LABELS.has(name)) path.unshift(name);
    currentId = parents.get(currentId);
  }
  return path;
}

/**
 * Invert the `children` lists into a parent lookup.
 *
 * A node appearing under two parents keeps the first, which is the right choice
 * for a readability aid: the chain is a summary of one plausible caller, and
 * `callPathOf` guards against cycles regardless.
 */
function buildParentMap(byId: Map<number, ProfileNode>): Map<number, number> {
  const parents = new Map<number, number>();
  for (const node of byId.values()) {
    for (const child of node.children ?? []) {
      if (!parents.has(child)) parents.set(child, node.id);
    }
  }
  return parents;
}

/**
 * Fold a V8 sampling profile into self time per distinct function.
 *
 * Self time, not total time, deliberately: a function that spends its life
 * inside remark's parser should not be credited with remark's own cost, or
 * every ancestor of the parse tree ties for first place and the report says
 * nothing. Samples land on a node; that node's self time is its share of the
 * delta attributed to that delta, with no walking up the tree.
 */
function aggregateSelfTime(profile: ProfileResult): {
  hot: HotFunction[];
  unattributable: UnattributableBucket[];
  unattributablePct: number;
  sampleCount: number;
} {
  const byId = new Map<number, ProfileNode>();
  for (const node of profile.nodes) byId.set(node.id, node);
  const parents = buildParentMap(byId);

  const selfUsByNode = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    selfUsByNode.set(id, (selfUsByNode.get(id) ?? 0) + (deltas[i] ?? 0));
  }

  const byFunction = new Map<string, { us: number; name: string; url: string; line: number; column: number; callPath: readonly string[] }>();
  const byBucket = new Map<BucketName, number>();
  let totalUs = 0;
  for (const [id, us] of selfUsByNode) {
    const node = byId.get(id);
    if (!node) continue;
    totalUs += us;

    const bucket = bucketFor(node.callFrame.functionName.trim(), node.callFrame.url);
    if (bucket) {
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + us);
      continue;
    }

    const { name, url, line, column } = describeFrame(node);
    // Key on POSITION, not just name. Every anonymous function in a chunk
    // shares the name "(anonymous)", so keying on name collapsed hundreds of
    // distinct call sites into one meaningless row - which is why the top
    // entry was a bare "(anonymous) index-*.js" holding 8% of self time with
    // no way to tell one function from another. Position separates them.
    const key = `${name} @ ${url}:${line}:${column}`;
    const existing = byFunction.get(key);
    if (existing) existing.us += us;
    else byFunction.set(key, { us, name, url, line, column, callPath: callPathOf(parents, byId, id) });
  }

  const pct = (us: number): number => (totalUs === 0 ? 0 : (us / totalUs) * 100);

  const hot = [...byFunction.entries()]
    .map(([, v]) => ({
      name: v.name,
      url: v.url,
      selfMs: v.us / 1000,
      sharePct: pct(v.us),
      line: v.line,
      column: v.column,
      callPath: v.callPath,
      source: null,
    }))
    .sort((a, b) => b.selfMs - a.selfMs);

  const unattributable = [...byBucket.entries()]
    .map(([name, us]) => ({ name, selfMs: us / 1000, sharePct: pct(us) }))
    .sort((a, b) => b.selfMs - a.selfMs);

  return {
    hot,
    unattributable,
    unattributablePct: unattributable.reduce((acc, b) => acc + b.sharePct, 0),
    sampleCount: samples.length,
  };
}

/**
 * An open CPU measurement over one renderer window.
 *
 * Construct it, do the work, then call stop(). Nothing here asserts anything:
 * a profiler's job is to produce numbers, and gating belongs in the spec that
 * knows what the budget should be.
 */
export class RendererProbe {
  private constructor(
    private readonly cdp: CDPSession,
    private readonly baseline: Record<MetricName, number>,
    private readonly startedAt: number,
  ) {}

  /**
   * Begin profiling. Enables the Performance counters, sets a coarse sampling
   * interval so measurement overhead stays near noise, and starts the sampler.
   */
  static async start(page: Page): Promise<RendererProbe> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: SAMPLING_INTERVAL_US });
    await cdp.send("Profiler.start");
    const baseline = await readCounters(cdp);
    return new RendererProbe(cdp, baseline, Date.now());
  }

  /** Stop sampling and return the deltas plus the ranked hot functions. */
  async stop(topN = 15): Promise<RendererCpuReport> {
    const windowMs = Date.now() - this.startedAt;
    const { profile } = (await this.cdp.send("Profiler.stop")) as {
      profile: ProfileResult;
    };
    const after = await readCounters(this.cdp);
    await this.cdp.detach().catch(() => {});

    const delta = (key: MetricName): number =>
      Math.max(0, (after[key] - this.baseline[key]) * 1000);

    const { hot, unattributable, unattributablePct, sampleCount } = aggregateSelfTime(profile);
    return {
      totals: {
        scriptMs: delta("ScriptDuration"),
        layoutMs: delta("LayoutDuration"),
        styleMs: delta("RecalcStyleDuration"),
        taskMs: delta("TaskDuration"),
        windowMs,
      },
      hot: hot.slice(0, topN),
      unattributable,
      unattributablePct,
      sampleCount,
    };
  }
}

/**
 * Profile one unit of work and return its report alongside whatever the work
 * produced. Preferred over manual start/stop at call sites because it makes
 * forgetting to stop - which would silently profile the teardown too - hard to
 * write by accident.
 */
export async function withCpuProfile<T>(
  page: Page,
  work: () => Promise<T>,
  topN = 15,
): Promise<{ result: T; cpu: RendererCpuReport }> {
  const probe = await RendererProbe.start(page);
  const result = await work();
  const cpu = await probe.stop(topN);
  return { result, cpu };
}

/** One line per counter, for a test log or a CI annotation. */
export function formatTotals(totals: RendererCpuDelta): string {
  const pct = (v: number): string => `${v.toFixed(0)}ms`;
  return [
    `window ${totals.windowMs}ms`,
    `task ${pct(totals.taskMs)}`,
    `script ${pct(totals.scriptMs)}`,
    `layout ${pct(totals.layoutMs)}`,
    `style ${pct(totals.styleMs)}`,
  ].join("  ");
}

/**
 * Fill in `source` for frames the profiler could only call "(anonymous)".
 *
 * ## Why this needs no source-map library
 *
 * The obvious approach is to resolve positions through the emitted source maps,
 * which needs `@jridgewell/trace-mapping` or `source-map` - neither is installed,
 * and adding a dependency for a report line fails the bar in AGENTS.md.
 *
 * It is also unnecessary here. CDP reports positions in the SERVED script. When
 * that script is unminified (the `TBAI_PROFILE_BUILD` artifact), the reported
 * line/column indexes straight into the text on disk, and the surrounding
 * source says what the function is. Minification is the only reason a source
 * map would be needed at all, and this harness deliberately does not minify.
 *
 * ## Why it only helps the anonymous frames
 *
 * A named frame already names itself. This exists for the ones V8 reports as
 * `(anonymous)` - object methods, class bodies, IIFE-wrapped callbacks - which
 * is where the single largest attributable frame lived (8% of self time in the
 * code-heavy stream, entirely unattributable until now).
 *
 * @param hot Frames from a report, sorted by self time.
 * @param assetsDir Directory holding the served chunks, normally `web/dist-profile/assets`.
 * @returns A new array; the input is not mutated.
 */
export function annotateFromSources(
  hot: readonly HotFunction[],
  assetsDir: string,
): HotFunction[] {
  const cache = new Map<string, string[] | null>();
  return hot.map((frame) => {
    if (frame.url === "(native)" || frame.line < 0) return frame;
    let lines = cache.get(frame.url);
    if (lines === undefined) {
      const path = join(assetsDir, frame.url);
      // Missing file is expected and not an error: the report may cover a dev
      // server, or a chunk that was not written to this directory. It just
      // means the frame stays unresolved.
      lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : null;
      cache.set(frame.url, lines);
    }
    if (!lines) return frame;

    const index = frame.line;
    if (index < 0 || index >= lines.length) return frame;
    const at = lines[index] ?? "";
    // The reported column points at the function itself; a short window from
    // there usually contains the assignment or declaration that names it.
    const start = Math.max(0, Math.min(frame.column, at.length));
    const excerpt = at.slice(start, start + SOURCE_EXCERPT_CHARS).trim();
    return { ...frame, source: excerpt.length > 0 ? excerpt : at.trim() };
  });
}

/** How much of a line to show when naming a frame from source. */
const SOURCE_EXCERPT_CHARS = 160;

/**
 * Ranked self-time table, so a report names the culprit instead of "script".
 *
 * Anonymous frames get their source excerpt appended when one was resolved,
 * because "(anonymous)" alone names nothing and is the reason this table was
 * unreadable at the top of the ranking.
 */
export function formatHotFunctions(hot: readonly HotFunction[], limit = 10): string {
  if (hot.length === 0) return "  (no attributable samples captured)";
  const width = Math.min(38, ...hot.map((h) => h.name.length));
  return hot
    .slice(0, limit)
    .map((h) => {
      const head = `  ${h.sharePct.toFixed(1).padStart(5)}%  ${h.name.padEnd(width)}  ${h.url}:${h.line + 1}`;
      if (h.source) return `${head}\n              -> ${h.source}`;
      return head;
    })
    .join("\n");
}

/**
 * The same ranking, but as caller -> callee chains.
 *
 * Preferred over `formatHotFunctions` when the top frames are unnameable,
 * because the chain identifies the SUBSYSTEM even when the leaf is anonymous.
 * Only the tail of each path is printed - the root of a React render is always
 * something like `performWorkUntilDeadline`, which carries no information.
 */
export function formatCallPaths(hot: readonly HotFunction[], limit = 8): string {
  const withPath = hot.filter((h) => h.callPath.length > 0);
  if (withPath.length === 0) return "  (no attributable call paths)";
  const shown = withPath.slice(0, limit);
  const tail = Math.min(...shown.map((h) => h.callPath.length));
  return shown
    .map((h) => {
      const chain = h.callPath.slice(h.callPath.length - tail).join(" > ");
      return `  ${h.sharePct.toFixed(1).padStart(5)}%  ${h.name}\n              ${chain}`;
    })
    .join("\n");
}

/**
 * Total self time attributed to WebAssembly, in milliseconds.
 *
 * The unambiguous Shiki signal, and deliberately not a name-matching heuristic.
 * WASM frames are identifiable without guessing: they report a `wasm-function[N]`
 * name and load from a `wasm-*.js` chunk. Matching frame NAMES like `subtokenize`
 * or `compile` would be guesswork - those names belong to whichever library
 * happens to export them - so this is the number to trust when deciding whether
 * highlighting work is being repeated.
 */
export function wasmSelfMs(hot: readonly HotFunction[]): number {
  return hot
    .filter((h) => h.name.startsWith("wasm-function[") || h.url.startsWith("wasm-"))
    .reduce((acc, h) => acc + h.selfMs, 0);
}

/**
 * The frameless bucket, stated separately and labelled as unfixable.
 *
 * Printed with the hot functions rather than instead of them: it is real time
 * in the profile, but no symbolication can attribute it, so a reader who only
 * sees the named rows would over-read what the numbers prove.
 */
export function formatUnattributable(cpu: {
  unattributable: readonly UnattributableBucket[];
  unattributablePct: number;
}): string {
  if (cpu.unattributable.length === 0) return "  frameless: none";
  const rows = cpu.unattributable
    .map((b) => `${b.name} ${b.sharePct.toFixed(1)}%`)
    .join(", ");
  return `  frameless (not symbolicable): ${cpu.unattributablePct.toFixed(1)}%  [${rows}]`;
}
