import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

/**
 * Vite configuration.
 *
 * ## The profiling build
 *
 * A CPU profile of the renderer reported the single largest self-time bucket as
 * `(program)` — a pseudo-frame V8 emits for time with no JavaScript frame
 * attached — and the rest as one-letter minified names (`L0r`, `a`, `r`),
 * which name nothing.
 *
 * These are two different problems, and the profiling build fixes only one of
 * them:
 *
 * - **Minified names ARE fixable.** Disabling minification keeps the real
 *   function names in the emitted code, so the profile reports
 *   `boundCodeFence` instead of `a`. No source-map resolution is needed at all,
 *   which is why this build ships without a trace-mapping dependency.
 * - **`(program)` is NOT fixable here, and no sourcemap will ever fix it.**
 *   Probing showed it holds 78-100% of self time for *every* workload tried —
 *   plain arithmetic, string building, regex, JSON, DOM churn — and 100% on a
 *   completely idle page, always with an empty script URL and zero
 *   positionTicks. Re-running under `--js-flags=--jitless`, which stops V8
 *   optimising to native code and should have preserved a JS frame, left it at
 *   83-88%. It is the sampler's bucket for time with no frame, including idle
 *   and collector time, not mangled application code.
 *
 * So this mode buys readable NAMES, not full attribution. The profiler helper
 * (`web/e2e/helpers/cpuProfile.ts`) reports `(program)`, `(idle)` and
 * `(garbage collector)` as a separate unattributable bucket precisely so the
 * remaining names can be read without them dominating the ranking.
 *
 * Gated by TBAI_PROFILE_BUILD, because a profiling artifact must never be what
 * ships: unminified output is several times larger and parses slower, so
 * treating it as a production build would quietly make the app worse.
 */
const isProfileBuild = process.env.TBAI_PROFILE_BUILD === '1'

/**
 * Where the shippable SPA is written, relative to this file.
 *
 * ## Why it is `../dist/web` and not `web/dist`
 *
 * The server binary is compiled to `<repo>/dist/`, and the packaged/portable build
 * already ships the SPA as a `web/` folder BESIDE that binary. Emitting to
 * `web/dist` put the two halves of one artifact in different trees, so a local
 * `bun run build` produced a layout that did not match what CI ships and `dist/`
 * was not a folder you could copy on its own. `dist/web` makes local and packaged
 * output identical and makes `dist/` the single shippable folder.
 *
 * ## Why `emptyOutDir` is explicit on both branches
 *
 * The outDir now sits OUTSIDE the Vite root, and Vite refuses to empty an outDir
 * it cannot prove is safe — it warns and skips. Skipping the clean would strand
 * stale hashed assets in `assets/` forever, since every build emits new hashes.
 * It empties `dist/web` only and never `dist/` itself, so `tbai-server` is not at
 * risk.
 */
const SHIPPABLE_OUT_DIR = '../dist/web'

/**
 * Where the profiling build writes, relative to this file.
 *
 * Deliberately a different tree from `SHIPPABLE_OUT_DIR`, which is what makes the
 * containment structural rather than a convention: the two can never collide even
 * if `emptyOutDir` were ever removed. `scripts/profile-web.ts` and the docs point
 * the server at this directory through `WEB_DIST_DIR`, so the minified shippable
 * output is never touched by a profiling run.
 */
const PROFILE_OUT_DIR = 'dist-profile'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: isProfileBuild
    ? {
        // Unminified, so function names survive into the CPU profile. The
        // output is NOT a shippable artifact - see the note above.
        minify: false,
        // Emitted for the cases where a line-level answer is still needed
        // (for example mapping a hot position to a module). Nothing in the
        // suite resolves these today; they are here for a manual DevTools
        // session, not as a dependency of the harness.
        sourcemap: true,
        // A separate tree so a profiling build can never overwrite the
        // shippable `dist/web`, and so switching between them needs no cleanup.
        outDir: PROFILE_OUT_DIR,
        emptyOutDir: true,
      }
    : {
        outDir: SHIPPABLE_OUT_DIR,
        emptyOutDir: true,
      },
})
