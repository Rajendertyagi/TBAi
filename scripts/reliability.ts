// scripts/reliability.ts — server reliability soak test (zero deps).
// Usage:
//   bun run scripts/reliability.ts
//   bun run scripts/reliability.ts --seconds 300 --rate 20 --concurrency 10 --out reliability.json
//
// Hammers the running TBAi backend's REST routes over a window and checks:
//   1. up at start   2. zero connection drops   3. no desync (malformed body)
//   4. no buffer issues (byte completeness + latency drift)   5. still up at end
// No provider needed. Exits 1 on any fail.
//
// `export {}` marks this as a module (not a global script) so its top-level
// helpers don't collide with scripts/perf.ts in the shared tsconfig scope.
export {};

const DEFAULT_BASE = "http://localhost:3000";
const DEFAULT_SECONDS = 60;
const DEFAULT_RATE = 20;
const DEFAULT_CONCURRENCY = 10;

// Only apply the p99-vs-p50 ratio drift check once latency is genuinely large;
// below DRIFT_APPLY_ABOVE_MS the 4x ratio is meaningless (7ms tail on 0.4ms
// p50 is normal jitter). Otherwise guard with the absolute p99 ceiling.
const DRIFT_MULTIPLIER = 4;
const DRIFT_APPLY_ABOVE_MS = 10;
const P99_ABS_CEILING_MS = 1000;

// Soak routes: API + static. Expected top-level JSON type per route (null = no
// JSON check, just non-empty body). /api/health is a real route (index.ts:108).
const ROUTES: Array<{ path: string; json?: "array" | "object" }> = [
  { path: "/api/health", json: "object" },
  { path: "/api/providers", json: "array" },
  { path: "/api/conversations", json: "object" },
  { path: "/" },
];

interface Sample {
  route: string;
  ok: boolean;
  error: boolean;
  wellFormed: boolean;
  bytes: number;
  ms: number;
}

function argNum(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v !== undefined ? Number(v) : fallback;
}
function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? String(process.argv[i + 1]) : fallback;
}
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function healthCheck(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function runSoak(
  base: string,
  seconds: number,
  rate: number,
  concurrency: number,
  onProgress: (done: number, total: number) => void
): Promise<Sample[]> {
  const samples: Sample[] = [];
  const total = Math.floor(rate * seconds);
  const queue: number[] = Array.from({ length: total }, (_, i) => i);
  let inFlight = 0;

  const workers: Promise<void>[] = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const idx = queue.shift();
      if (idx === undefined) return;
      inFlight++;
      const spec = ROUTES[idx % ROUTES.length];
      const t0 = performance.now();
      let ok = false;
      let error = false;
      let wellFormed = false;
      let bytes = 0;
      try {
        const res = await fetch(`${base}${spec.path}`);
        const body = await res.arrayBuffer();
        bytes = body.byteLength;
        ok = res.ok;
        if (spec.json === undefined) {
          // Static route — well-formed = non-empty body.
          wellFormed = body.byteLength > 0;
        } else {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(new TextDecoder().decode(body));
          } catch {
            parsed = null;
          }
          if (parsed === null) {
            wellFormed = false; // truncated / corrupt / empty JSON
          } else if (spec.json === "array") {
            wellFormed = Array.isArray(parsed);
          } else {
            wellFormed = typeof parsed === "object" && !Array.isArray(parsed);
          }
        }
      } catch {
        error = true;
      }
      samples.push({ route: spec.path, ok, error, wellFormed, bytes, ms: performance.now() - t0 });
      inFlight--;
      onProgress(samples.length, total);
      if (inFlight > 0) {
        await new Promise((r) => setTimeout(r, 0)); // yield so the pace stays fair
      }
    }
  });
  await Promise.all(workers);
  return samples;
}

async function main() {
  const base = argStr("base", DEFAULT_BASE);
  const seconds = argNum("seconds", DEFAULT_SECONDS);
  const rate = argNum("rate", DEFAULT_RATE);
  const concurrency = argNum("concurrency", DEFAULT_CONCURRENCY);
  const useJson = process.argv.includes("--json");
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx !== -1 ? String(process.argv[outIdx + 1]) : null;

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

  const upAtStart = await healthCheck(base);
  checks.push({ name: "up_at_start", pass: upAtStart, detail: upAtStart ? "server responding" : "server not reachable" });
  if (!upAtStart) {
    report({ base, seconds, rate, concurrency, checks, total: 0, drops: 0, malformed: 0, latency: { p50: 0, p95: 0, p99: 0 } }, outPath, useJson);
    process.exitCode = 1;
    return;
  }

  let lastReported = 0;
  const samples = await runSoak(base, seconds, rate, concurrency, (done, tot) => {
    if (done - lastReported >= Math.max(1, tot / 10)) {
      lastReported = done;
      process.stdout.write(`\r  ${Math.floor((done / tot) * 100)}% of ${tot} requests…`);
    }
  });
  process.stdout.write("\n");

  const durations = samples.map((s) => s.ms).sort((a, b) => a - b);
  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const p99 = percentile(durations, 99);
  const drops = samples.filter((s) => s.error).length;
  const malformed = samples.filter((s) => !s.error && !s.wellFormed).length;

  // Buffer check: absolute p99 ceiling always; ratio drift only when latency is real.
  const absFail = p99 > P99_ABS_CEILING_MS;
  const ratioFail = p50 > DRIFT_APPLY_ABOVE_MS && p99 > DRIFT_MULTIPLIER * p50;
  const driftFail = absFail || ratioFail;

  checks.push({ name: "zero_connection_drops", pass: drops === 0, detail: `${drops} of ${samples.length} errored` });
  checks.push({ name: "no_desync", pass: malformed === 0, detail: `${malformed} of ${samples.length} malformed/truncated` });
  checks.push({
    name: "no_buffer_issues",
    pass: !driftFail,
    detail: `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms (fail if p99>${P99_ABS_CEILING_MS}ms, or p99>${DRIFT_MULTIPLIER}x p50 when p50>${DRIFT_APPLY_ABOVE_MS}ms)`,
  });

  const upAtEnd = await healthCheck(base);
  checks.push({ name: "still_up_at_end", pass: upAtEnd, detail: upAtEnd ? "server responding after soak" : "server gone after soak" });

  const result = { base, seconds, rate, concurrency, at: new Date().toISOString(), total: samples.length, drops, malformed, latency: { p50, p95, p99 }, checks };
  report(result, outPath, useJson);
  process.exitCode = checks.every((c) => c.pass) ? 0 : 1;
}

function report(
  r: {
    base: string; seconds: number; rate: number; concurrency: number; checks: Array<{ name: string; pass: boolean; detail: string }>;
    total?: number; drops?: number; malformed?: number; latency?: { p50: number; p95: number; p99: number };
  },
  outPath: string | null,
  useJson: boolean
): void {
  let text: string;
  if (useJson) {
    text = JSON.stringify(r, null, 2);
  } else {
    const lines: string[] = [];
    lines.push(`TBAi reliability — ${r.base} (${new Date().toISOString()})`);
    lines.push(`soak ${r.seconds}s @ ${r.rate} req/s, concurrency ${r.concurrency}`);
    if (r.total !== undefined) {
      lines.push(`requests: ${r.total} (drops ${r.drops}, malformed ${r.malformed})`);
      if (r.latency) lines.push(`latency: p50=${r.latency.p50.toFixed(1)}ms p95=${r.latency.p95.toFixed(1)}ms p99=${r.latency.p99.toFixed(1)}ms`);
    }
    lines.push("");
    for (const c of r.checks) lines.push(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name} — ${c.detail}`);
    lines.push("");
    lines.push(r.checks.every((c) => c.pass) ? "ALL CHECKS PASSED" : "CHECKS FAILED");
    text = lines.join("\n");
  }
  if (outPath) {
    Bun.write(outPath, text);
    console.log(text);
    console.log(`\nwrote ${outPath}`);
  } else {
    console.log(text);
  }
}

void main();
