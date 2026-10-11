/**
 * DOM PRELOAD for the permanent DOM/contract suite. Run ONLY via `test:dom`.
 *
 * The canonical suite (`bun test`) runs without a DOM and must stay that way;
 * this preload is scoped to `web/tests-dom/` so happy-dom is never registered
 * globally for the rest of the repository.
 *
 * It coexists with the repo-wide `bunfig.toml` preload (`./tests/setup.ts`),
 * which sets up the per-file SQLite sandbox. The two preloads are independent:
 * one provides a DOM, the other provides database isolation.
 *
 * ## Why the native-class preservation below exists
 *
 * happy-dom registers its own implementations of several globals. Most are
 * fine, but its `TransformStream` is broken: `new TransformStream().readable`
 * is not a real ReadableStream (it has no `pipeThrough`), which crashes
 * `assistant-stream`'s `PipeableTransformStream` the moment a tool invocation
 * is driven. The DOM tests need happy-dom's `document`/`window`/observers, NOT
 * its fetch/stream/scheduler classes — so bun's natives are captured before
 * registration and restored after, leaving only the DOM surface overridden.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** Bun-native globals the AI SDK / transport / React scheduler depend on. */
const NATIVE_GLOBALS = [
  "TransformStream",
  "ReadableStream",
  "WritableStream",
  "fetch",
  "Response",
  "Request",
  "Headers",
  "AbortController",
  "AbortSignal",
  "TextEncoder",
  "TextDecoder",
  "Blob",
  "FormData",
  "File",
  "URL",
  "URLSearchParams",
  "crypto",
  "structuredClone",
  "queueMicrotask",
  "MessageChannel",
  "MessagePort",
  "BroadcastChannel",
  "performance",
] as const;

const preserved = new Map<string, unknown>();
for (const key of NATIVE_GLOBALS) {
  if (key in globalThis) preserved.set(key, (globalThis as Record<string, unknown>)[key]);
}

GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 1024 });

// Restore bun's natives over anything happy-dom shadowed. DOM-only globals
// (document, window, ResizeObserver, MutationObserver, getComputedStyle, …)
// are left as happy-dom provided them.
for (const [key, value] of preserved) {
  (globalThis as Record<string, unknown>)[key] = value;
}

// React 19 refuses `act()` unless the host declares itself a test environment.
// Without this every render throws "The current testing environment is not
// configured to support act(...)" and nothing flushes.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
