/**
 * Theme audit — measures every themed surface in every theme, in both modes.
 *
 * WHY THIS EXISTS. The theme system was verified by screenshotting the welcome
 * screen across all 22 combinations. Nothing else was ever rendered under a
 * palette, so a mapping could resolve every token without error and still look
 * wrong — "no error" and "readable" are different claims, and only one of them
 * was ever checked. This closes that gap.
 *
 * HOW IT WORKS. For each theme/mode it loads the dev-only theme lab
 * (`#/theme-lab`), opens each overlay in turn, and walks the whole document —
 * portals included, which is why it measures every text-bearing element rather
 * than only the labelled specimens. For each element it resolves the *real*
 * composited background by walking ancestors and alpha-blending, then reports:
 *
 *   text      WCAG contrast of the text against that background
 *   edge      contrast of a border/ring against the surface it sits on
 *   surface   contrast of an element's own fill against what is behind it
 *
 * The point of the output shape is that it separates two very different bugs. A
 * `lab` row failing in nine themes is one wrong rule in the mapping; failing in
 * one theme is that palette. Fixing per theme would paper over the first kind.
 *
 * Usage:  bun scripts/theme-audit.mjs [--out <dir>] [--theme <id>] [--shots]
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = opt("--base", "http://localhost:3006");
const OUT = opt("--out", "C:/Users/RTPC/AppData/Local/Temp/opencode/tbai-audit");
const ONLY = opt("--theme", null);
const SHOTS = flag("--shots");

const THEMES = [
  "classic",
  "aura",
  "ayu",
  "carbonfox",
  "catppuccin",
  "cursor",
  "fields-of-the-shire",
  "gruvbox",
  "jetbrains",
  "openchamber",
  "vesper",
];

const OVERLAYS = ["dropdown", "popover", "dialog", "alert", "context", "tooltip", "toast"];

mkdirSync(OUT, { recursive: true });

/**
 * Runs in the page. Returns one record per checkable element.
 *
 * Colours arrive from `getComputedStyle` as rgb()/rgba(), so parsing is simple,
 * but the background is NOT: tokens are deliberately translucent (`bg-muted/30`,
 * the glass utilities, the card wash), so the visible background of an element is
 * an alpha composite of its whole ancestor chain. Reading `backgroundColor` alone
 * would report a code block's real backdrop as `rgba(0,0,0,0)` and score its text
 * against the wrong thing.
 */
function auditInPage(currentOverlay) {
  const parse = (value) => {
    if (!value) return null;
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    const alpha = parts.length >= 4 ? parts[3] : 1;
    return { r: parts[0], g: parts[1], b: parts[2], a: alpha <= 1 ? alpha : alpha / 255 };
  };

  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
      g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
      b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
      a,
    };
  };

  const lum = (c) => {
    const ch = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  };

  const ratio = (a, b) => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  /** Visible background: alpha-composite every ancestor from the root down. */
  const effectiveBg = (el) => {
    const chain = [];
    for (let node = el; node; node = node.parentElement) chain.push(node);
    chain.reverse();
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    let own = null;
    for (const node of chain) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (!bg || bg.a === 0) continue;
      acc = over(bg, acc);
      if (node === el) own = acc;
    }
    return { behind: acc, own: own ?? acc };
  };

  const describe = (el) => {
    const labelled = el.closest("[data-lab]");
    if (labelled) return labelled.getAttribute("data-lab");
    if (currentOverlay) return `overlay/${currentOverlay}`;
    const cls = (el.className || "").toString().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
  };

  const out = [];
  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

    const { behind, own } = effectiveBg(el);
    const lab = describe(el);
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);

    // Text check — only for elements holding their own text node, so a wrapper
    // is not scored with its container's colour.
    const hasOwnText = [...el.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 0,
    );
    if (hasOwnText) {
      const fg = parse(style.color);
      if (fg) {
        const size = parseFloat(style.fontSize) || 16;
        const weight = parseInt(style.fontWeight, 10) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        out.push({
          kind: "text",
          lab,
          text,
          ratio: Number(ratio(fg, behind).toFixed(2)),
          need: large ? 3 : 4.5,
          detail: `${Math.round(size)}px/${weight}`,
        });
      }
    }

    // Edge check — a visible border or ring needs to be discernible from the
    // surface it sits on, or menus and inputs lose their outline entirely.
    const bw = parseFloat(style.borderTopWidth) || 0;
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      if ((parseFloat(style[`border${side}Width`]) || 0) <= 0) continue;
      const bc = parse(style[`border${side}Color`]);
      if (!bc || bc.a === 0) continue;
      out.push({
        kind: "edge",
        lab,
        text: `border-${side.toLowerCase()}`,
        ratio: Number(ratio(bc, behind).toFixed(2)),
        need: 1.25,
        detail: `${bw}px ${style[`border${side}Color`]}`,
      });
    }

    // Surface check — a fill that is meant to read as its own panel should be
    // distinguishable from what is behind it.
    const bg = parse(style.backgroundColor);
    const looksLikeSurface =
      bg && bg.a > 0 && /\b(bg-(card|popover|muted|accent|secondary|sidebar|statusbar)|glass-surface|bg-card-soft)\b/.test(
        (el.className || "").toString(),
      );
    if (looksLikeSurface) {
      // Reference must be the parent's FULLY composited background, not its own
      // `backgroundColor`. Inside a transparent wrapper the parent's own colour is
      // rgba(0,0,0,0), and falling back to the element's own background here would
      // compare it with itself and report exactly 1.00 for every surface.
      const parentEl = el.parentElement ?? document.body;
      const reference = effectiveBg(parentEl).behind;
      out.push({
        kind: "surface",
        lab,
        text: style.backgroundColor,
        ratio: Number(ratio(behind, reference).toFixed(2)),
        need: 1.06,
        detail: "fill vs behind",
      });
    }
  }
  return out;
}

/**
 * Surfaces that are SUPPOSED to match their background.
 *
 * Phase A made every elevated surface borderless and carries its edge with a
 * shadow plus a glass tint instead of a fill difference. So a card, popover,
 * tooltip, dialog or toast matching the page is the intended result, not a
 * defect — and several upstream palettes set `elevated` equal to `background` for
 * exactly that reason. Requiring a fill difference here would fight the thing
 * Phase A was for, and would bury the real findings under 30 rows of noise.
 *
 * Fills that carry STATE (`--accent` for hover/selected) or mark a REGION
 * (`--sidebar`, `--statusbar`) are deliberately NOT in this list: nothing else
 * tells the reader where a hovered row or the sidebar ends.
 */
const EXPECTED_TO_MATCH_BACKGROUND = new Set([
  "surface/card",
  "surface/popover",
  "row/rest",
  "row/focused",
  "row/destructive",
  "div.max-w-sm.overflow-hidden",
  "overlay/dropdown",
  "overlay/popover",
  "overlay/dialog",
  "overlay/alert",
  "overlay/context",
  "overlay/tooltip",
  "overlay/toast",
  "overlay/dropdown-trigger",
  "overlay/popover-trigger",
  "overlay/dialog-trigger",
  "overlay/alert-trigger",
  "div.px-4.py-3",
]);

const browser = await chromium.launch();
const results = [];

for (const mode of ["dark", "light"]) {
  for (const theme of ONLY ? [ONLY] : THEMES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addInitScript(
      (s) => {
        try {
          localStorage.setItem("tbai-theme", s.mode);
          localStorage.setItem("tbai-theme-light", s.theme);
          localStorage.setItem("tbai-theme-dark", s.theme);
        } catch {}
      },
      { mode, theme },
    );
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(`${BASE}/#/theme-lab`, { waitUntil: "domcontentloaded" });
    // Wait for a specimen rather than a fixed delay: a slow first paint was being
    // reported as "only 0 specimens rendered", i.e. as a page error, when nothing
    // was actually wrong.
    await page
      .waitForSelector("[data-lab]", { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(600);

    const found = await page.locator("[data-lab]").count();
    if (found < 40) {
      results.push({ theme, mode, kind: "error", lab: "lab", ratio: 0, need: 1, detail: `only ${found} specimens rendered` });
    }

    // Base page, then each overlay opened in turn.
    const passes = [{ overlay: null }, ...OVERLAYS.map((o) => ({ overlay: o }))];
    for (const { overlay } of passes) {
      if (overlay) {
        const trigger = page.locator(`[data-lab-open="${overlay}"]`).first();
        if (await trigger.count()) {
          if (overlay === "tooltip") await trigger.hover({ timeout: 3000 }).catch(() => {});
          else if (overlay === "context") await trigger.click({ button: "right", timeout: 3000 }).catch(() => {});
          else await trigger.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(650);
        }
      }
      try {
        const records = await page.evaluate(auditInPage, overlay);
        for (const r of records) results.push({ theme, mode, ...r });
      } catch (e) {
        results.push({ theme, mode, kind: "error", lab: overlay ?? "page", ratio: 0, need: 1, detail: String(e).slice(0, 120) });
      }
      if (overlay) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.mouse.move(5, 5).catch(() => {});
        await page.waitForTimeout(320);
      }
    }

    if (SHOTS) {
      await page.screenshot({ path: `${OUT}/${mode}-${theme}.png`, fullPage: true });
    }
    if (errors.length) {
      results.push({ theme, mode, kind: "error", lab: "page", ratio: 0, need: 1, detail: errors[0].slice(0, 120) });
    }
    console.log(`${mode}/${theme}: ${found} specimens, errors ${errors.length}`);
    await ctx.close();
  }
}

await browser.close();

// --- aggregate -------------------------------------------------------------
// Grouped so the shape of the problem is visible: a `lab` failing across many
// themes is a mapping rule; failing in one theme is that palette.
const byLab = new Map();
for (const r of results) {
  if (r.kind === "error") continue;
  const key = `${r.kind}|${r.lab}`;
  if (!byLab.has(key)) {
    byLab.set(key, {
      kind: r.kind,
      lab: r.lab,
      need: r.need,
      seen: new Set(),
      failing: new Set(),
      worst: 99,
      worstAt: "",
      sample: "",
    });
  }
  const entry = byLab.get(key);
  const combo = `${r.theme}/${r.mode}`;
  entry.seen.add(combo);
  if (r.ratio < entry.worst) {
    entry.worst = r.ratio;
    entry.worstAt = combo;
    entry.sample = `${r.text} (${r.detail})`;
  }
  if (r.ratio < r.need) entry.failing.add(combo);
}

const rows = [...byLab.values()]
  .map((e) => ({
    kind: e.kind,
    lab: e.lab,
    need: e.need,
    worst: e.worst,
    count: e.failing.size,
    seen: e.seen.size,
    worstAt: e.worstAt,
    sample: e.sample,
    failing: [...e.failing],
  }))
  .filter((e) => e.count > 0)
  .sort((a, b) => a.worst - b.worst);

const errors = results.filter((r) => r.kind === "error");
const allChecks = results.filter((r) => r.kind !== "error");

// `count` is how many of the 22 combinations actually FAILED, not how many were
// measured. Counting measurements instead made every row look systemic, which is
// the one distinction this report exists to draw.
console.log(`\n${"=".repeat(84)}`);
console.log(`checks: ${allChecks.length}   rows with failures: ${rows.length}   page errors: ${errors.length}`);
console.log(`\nRANKED BY WEAKEST MARGIN   (worst | needed | failed/measured | scope)`);
for (const e of rows) {
  const scope = e.count >= 6 ? "MAPPING" : e.count >= 3 ? "mostly" : "palette";
  console.log(
    `  ${e.worst.toFixed(2).padStart(5)} / ${String(e.need).padEnd(4)} ` +
      `${(e.count + "/" + e.seen).padEnd(7)} ${scope.padEnd(8)} ${e.kind.padEnd(8)} ${e.lab.padEnd(26)} ` +
      `worst ${e.worstAt.padEnd(20)} ${e.sample.slice(0, 34)}`,
  );
}

const isByDesign = (e) => e.kind === "surface" && EXPECTED_TO_MATCH_BACKGROUND.has(e.lab);
const mapping = rows.filter((e) => e.count >= 6 && !isByDesign(e));
console.log(`\n--- MAPPING-RULE CANDIDATES (fail in 6+ of 22 combinations) ---`);
if (!mapping.length) console.log("  none");
for (const e of mapping) {
  console.log(`  ${e.worst.toFixed(2)} (needs ${e.need})  ${e.kind}/${e.lab}  — ${e.count} combos`);
}

const byDesign = rows.filter(isByDesign);
const real = rows.filter((e) => !isByDesign(e));
console.log(`\n--- REAL FINDINGS (by-design surface matches excluded: ${byDesign.length} rows) ---`);
if (!real.length) console.log("  none");
for (const e of real) {
  console.log(
    `  ${e.worst.toFixed(2)} (needs ${e.need})  ${e.kind}/${e.lab}  — ${e.count}/${e.seen} combos, worst ${e.worstAt}`,
  );
}
console.log(`\n--- BY DESIGN: elevated surfaces intentionally match the page ---`);
console.log(`  ${byDesign.length} rows, all fill-vs-behind on card/popover/overlay surfaces.`);
console.log(`\n--- WORST OFFENDER PER ELEMENT (for judging whether it is real) ---`);
for (const e of rows.slice(0, 12)) {
  console.log(`  ${e.worst.toFixed(2)} ${e.kind}/${e.lab} @ ${e.worstAt}  (${e.count}/${e.seen} combos)`);
}
if (errors.length) {
  console.log(`\n--- PAGE ERRORS ---`);
  for (const e of errors.slice(0, 12)) console.log(`  ${e.theme}/${e.mode} ${e.lab}: ${e.detail}`);
}

writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, rows }, null, 2));
console.log(`\nwritten: ${OUT}/results.json`);