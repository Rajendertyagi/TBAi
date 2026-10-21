/**
 * The origins a browser may read TBAi's API responses from.
 *
 * ## The rule this module encodes
 *
 * A response is readable by a page on another origin only when that page is
 * **one of TBAi's own pages**. TBAi serves its own pages from exactly two
 * kinds of origin:
 *
 * 1. the **packaged desktop webview**, whose origin is fixed by the platform
 *    and does not depend on any port TBAi listens on; and
 * 2. a **loopback origin on a port TBAi serves its pages from** — the port the
 *    listener is on, and the port it just replaced.
 *
 * Everything else — another loopback port, a public origin, an opaque origin,
 * a request with no `Origin` at all — gets no `Access-Control-Allow-Origin`,
 * so the browser refuses to hand the response over.
 *
 * ## Why the ports are DERIVED, not listed
 *
 * The port is the user's choice (Settings → Web server), so a policy that
 * named a fixed port would break the moment the user picked another one. The
 * concrete failure this replaces: the browser-mode restart probes the NEW
 * origin from the page that is still on the OLD one, which is a cross-origin
 * request — so the new listener has to trust the old page's origin, and a
 * hardcoded `localhost:3000` stops doing that the first time the user moves
 * off 3000.
 *
 * The derivation is the architecture's own: `services/server-listener.ts` owns
 * the single listener and knows the port it is on and the port it replaced.
 * This module stays **pure** (no service imports) so it can be reasoned about
 * — and unit-tested — on its own; the route supplies the ports.
 *
 * ## The packaged origin is `http://app.localhost`
 *
 * The desktop shell registers a custom URI scheme named `app`
 * (`src-tauri/src/main.rs:603`) and the window loads `app://localhost`
 * (`src-tauri/tauri.conf.json:10`). The **scheme name** is not the origin:
 * Tauri's own API documentation for `register_asynchronous_uri_scheme_protocol`
 * states that a custom-protocol page has a different origin per platform, and
 * names them:
 *
 *   - macOS / iOS / Linux: `<scheme>://localhost/`
 *   - **Windows and Android: `http://<scheme>.localhost/`** (the default; the
 *     `use_https_scheme` builder option switches it to `https`)
 *
 * TBAi targets **Windows x64 only** (`web/src/lib/platform.ts`), so the
 * WebView2 form applies and the packaged app's origin is
 * `http://app.localhost`. This repository already recorded it
 * (`docs/architecture.md`: "Windows WebView2 produces the origin
 * `http://app.localhost`").
 *
 * ## What is deliberately NOT here
 *
 * - **A wildcard.** It would hand every page on the machine read access to
 *   the API, which is the whole class of disclosure the allowlist and the
 *   server-side authorization exist to prevent.
 * - **A fixed port.** The port is the user's to choose.
 * - **A remote origin.** TBAi is a local, single-user desktop application; a
 *   page on the internet has no business reading its API.
 *
 * ## CORS is not authorization
 *
 * A refused origin's request is still executed by the server. What the
 * browser cannot do is READ the response. What a request may *do* is decided
 * by the OpenCode proxy's route allowlist and its server-side workspace
 * authorization, which hold regardless of the origin.
 */

/** The packaged desktop app's webview origin (Windows WebView2). */
export const PACKAGED_APP_ORIGIN = "http://app.localhost";

/**
 * The loopback origins TBAi serves its own pages on, for one port.
 *
 * Both host forms are included because the user may reach the app through
 * either: `localhost` is what the Tauri dev window and the copy-URL button
 * use, `127.0.0.1` is what the packaged app's API base URL uses and what a
 * user typing an address is likely to use.
 *
 * @param port - The port TBAi serves its pages on.
 * @returns The origins that identify that page.
 */
export function loopbackOriginsForPort(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/**
 * Whether a request's `Origin` may read the response.
 *
 * @param origin - The request's `Origin` header, or `""` when it has none.
 * @param servedPorts - The ports TBAi serves (or just served) its own pages
 *   on: the live listener's port, and the port that listener replaced.
 * @returns True only for the packaged webview and for TBAi's own pages.
 */
export function isAllowedCorsOrigin(origin: string, servedPorts: readonly number[]): boolean {
  if (origin === PACKAGED_APP_ORIGIN) return true;
  return servedPorts.some((port) => loopbackOriginsForPort(port).includes(origin));
}
