import { DevToolsModal } from "@assistant-ui/react-devtools";
import { DEV_TOOLS_ENABLED } from "../config/devtools";

/**
 * Mounts the assistant-ui DevTools panel, in development only.
 *
 * ## Why this exists instead of `<DevToolsModal />` at the call sites
 *
 * `@assistant-ui/react-devtools` already tries to exclude itself from
 * production builds, but its guard reads `process.env.NODE_ENV` while Vite
 * browsers have no `process` object at all, so the guard never fires and the
 * panel mounted in shipped builds (verified: its chunk was present in both
 * `web/dist` and the packaged app).
 *
 * Wrapping it here puts the fix in exactly one place. Both shells — the normal
 * chat branch and the OpenCode Code branch — render `<DevToolsGate />` and
 * neither imports the dev-only package, so the decision cannot drift between
 * the two and the third-party dependency stops appearing in feature files.
 *
 * Because `DEV_TOOLS_ENABLED` is a statically-replaced `import.meta.env.DEV`,
 * this returns `null` in a production build, which lets the `lazy()` panel
 * chunk go unreferenced and stop shipping (~160 KB) rather than merely
 * becoming invisible.
 *
 * See `config/devtools.ts` for the measurement and the reasoning.
 */
export function DevToolsGate() {
  if (!DEV_TOOLS_ENABLED) return null;
  return <DevToolsModal />;
}
