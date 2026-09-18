// scripts/perf.ts — zero-dep perf tool for the running TBAi backend.
// Usage:
//   bun run scripts/perf.ts                          # quick (concurrency 5, 20 samples)
//   bun run scripts/perf.ts --base http://localhost:3000 --concurrency 10 --samples 50
//   bun run scripts/perf.ts --json --out perf-result.json
//
// The backend must already be running. This script only measures.
//
// `export {}` marks this as a module (not a global script) so its top-level
// helpers don't collide with scripts/reliability.ts in the shared tsconfig scope.
export {};

const BASE = process.env.BASE ?? "http://localhost:3000";
const CONCURRENCY = 5;
const SAMPLES = 20;

// Baseline-first: fill in after the first real run. -1 = no threshold yet.
const THRESHOLDS = {
  restP95Ms: -1,        // p95 for /api/conversations + /api/providers
  chatTTFTp95Ms: -1,    // time-to-first-byte for /api/chat
  successRatePct: 99,   // min acceptable %
};

function numArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function measureRest(
  path: string,
  samples: number,
  concurrency: number
): Promise<{ p50: number; p95: number; ok: number; total: number }> {
  const durations: number[] = [];
  let ok = 0;
  let total = 0;
  const url = `${BASE}${path}`;

  async function worker() {
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now();
      try {
        const res = await fetch(url);
        if (res.ok) ok++;
        total++;
      } catch {
        total++;
      }
      durations.push(performance.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  durations.sort((a, b) => a - b);
  return { p50: percentile(durations, 50), p95: percentile(durations, 95), ok, total };
}

// SSE streaming: POST /api/chat, measure TTFT + total duration + completion.
// providerId "perf-probe" may not exist — we measure transport behavior, not the model.
async function measureChat(
  samples: number,
  concurrency: number
): Promise<{
  ttftP50: number;
  ttftP95: number;
  totalP95: number;
  completed: number;
  total: number;
}> {
  const ttfts: number[] = [];
  const totals: number[] = [];
  let completed = 0;
  let total = 0;

  const body = {
    providerId: "perf-probe",
    messages: [{ role: "user", content: "ping" }],
  };

  async function worker() {
    for (let i = 0; i < samples; i++) {
      const url = `${BASE}/api/chat`;
      const t0 = performance.now();
      let first = -1;
      total++;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (first === -1) first = performance.now() - t0;
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        if (res.status >= 200 && res.status < 500) completed++;
      } catch {
        // transport error — counted in total, not completed
      }
      if (first !== -1) ttfts.push(first);
      totals.push(performance.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  ttfts.sort((a, b) => a - b);
  totals.sort((a, b) => a - b);
  return {
    ttftP50: percentile(ttfts, 50),
    ttftP95: percentile(ttfts, 95),
    totalP95: percentile(totals, 95),
    completed,
    total,
  };
}

async function main() {
  const useJson = process.argv.includes("--json");
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : null;
  const base = process.argv.includes("--base")
    ? String(process.argv[process.argv.indexOf("--base") + 1])
    : BASE;
  const concurrency = numArg("concurrency", CONCURRENCY);
  const samples = numArg("samples", SAMPLES);

  const result = {
    base,
    concurrency,
    samples,
    at: new Date().toISOString(),
    rest: [] as Array<{ path: string; p50: number; p95: number; ok: number; total: number }>,
    chat: null as null | Awaited<ReturnType<typeof measureChat>>,
  };

  for (const path of ["/api/conversations", "/api/providers"]) {
    const m = await measureRest(path, samples, concurrency);
    result.rest.push({ path, ...m });
  }
  result.chat = await measureChat(samples, concurrency);

  const out = useJson ? JSON.stringify(result, null, 2) : formatText(result);
  if (outPath) {
    await Bun.write(outPath, out);
    console.log(`wrote ${outPath}`);
  } else {
    console.log(out);
  }

  // Threshold checks (only enforced once filled in; -1 = off).
  let failed = false;
  if (THRESHOLDS.restP95Ms >= 0) {
    for (const r of result.rest) {
      if (r.p95 > THRESHOLDS.restP95Ms) failed = true;
    }
  }
  if (THRESHOLDS.chatTTFTp95Ms >= 0 && result.chat) {
    if (result.chat.ttftP95 > THRESHOLDS.chatTTFTp95Ms) failed = true;
  }
  const successPct = result.chat && result.chat.total > 0
    ? (result.chat.completed / result.chat.total) * 100
    : 100;
  if (successPct < THRESHOLDS.successRatePct) failed = true;

  if (failed) {
    console.log("\nTHRESHOLD BREACHED — see numbers above");
    process.exitCode = 1;
  } else {
    console.log("\nWithin thresholds.");
  }
}

function formatText(r: Awaited<ReturnType<typeof main>> extends never ? never : {
  base: string;
  rest: Array<{ path: string; p50: number; p95: number; ok: number; total: number }>;
  chat: {
    ttftP50: number;
    ttftP95: number;
    totalP95: number;
    completed: number;
    total: number;
  } | null;
}): string {
  const lines: string[] = [];
  lines.push(`TBAi perf — ${r.base} (${new Date().toISOString()})`);
  lines.push("");
  lines.push("REST:");
  for (const x of r.rest) {
    lines.push(
      `  ${x.path}: p50=${x.p50.toFixed(1)}ms p95=${x.p95.toFixed(1)}ms ${x.ok}/${x.total} ok`
    );
  }
  lines.push("");
  if (r.chat) {
    lines.push("CHAT (SSE /api/chat):");
    lines.push(`  TTFT p50=${r.chat.ttftP50.toFixed(1)}ms p95=${r.chat.ttftP95.toFixed(1)}ms`);
    lines.push(`  total p95=${r.chat.totalP95.toFixed(1)}ms`);
    lines.push(
      `  completed ${r.chat.completed}/${r.chat.total} (${(
        (r.chat.completed / r.chat.total) *
        100
      ).toFixed(1)}%)`
    );
  } else {
    lines.push("CHAT (SSE /api/chat): no samples");
  }
  return lines.join("\n");
}

void main();
