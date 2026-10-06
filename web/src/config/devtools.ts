/**
 * Whether the assistant-ui DevTools panel is mounted at all.
 *
 * ## Why TBAi decides this instead of the library
 *
 * `@assistant-ui/react-devtools` guards its own production exclusion with:
 *
 *   if (typeof process !== "undefined" && process.env?.NODE_ENV === "production")
 *     return null;
 *
 * That guard is written for bundlers that inject a `process` shim. Vite does
 * not, so in the browser `process` is genuinely undefined, `typeof process !==
 * "undefined"` evaluates false, and the early return never happens. The panel
 * therefore mounts in a production build — verified, not theorised: the string
 * "Waiting for assistant-ui instance..." is present in the built
 * `DevToolsModalImpl-*.js` chunk of `web/dist` AND of the packaged app, a
 * 160 KB chunk loaded by the packaged build.
 *
 * The failure mode is worse than a cosmetic string. The panel renders a React
 * subtree that subscribes to the runtime via `useSyncExternalStore` and
 * installs a document-level `keydown` listener, in a chat surface that is
 * supposed to hold no dev-only machinery, and it advertises the existence of
 * the internal runtime to anyone who opens it.
 *
 * ## Why `import.meta.env.DEV` is the correct gate
 *
 * It is statically replaced by Vite, so `DEV_TOOLS_ENABLED` folds to `false`
 * in a production build. That lets the `DevToolsModal` import be dropped
 * entirely: the `lazy()` panel chunk is never requested, so the 160 KB chunk
 * stops shipping at all rather than merely becoming invisible.
 *
 * This does NOT break dev. In development the gate is `true`, the panel still
 * mounts, and `main.tsx`'s `process.env.NODE_ENV` shim (which exists so the
 * assistant-ui registration chain can see a dev environment) still applies —
 * so runtime registration keeps working exactly as before.
 *
 * Set to `false` here to disable devtools in development too, without
 * touching either call site.
 */

/** Mount the assistant-ui DevTools panel. Development only. */
export const DEV_TOOLS_ENABLED = import.meta.env.DEV;
