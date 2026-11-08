// Platform abstraction layer (Windows x64 desktop only).
//
// Every Tauri-specific capability is reached through a dynamic `import()` here
// so the browser bundle never statically pulls in `@tauri-apps/*`. The desktop
// chrome components import ONLY from this module; the rest of the app stays
// provider/transport agnostic and behaves identically in a plain browser.

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type BackendStatus = "starting" | "ready" | "recovering" | "failed";

export interface EndpointInfo {
  port: number;
  base_url: string;
  instance_id: string;
}

let verifiedBaseUrl = "";
let currentStatus: BackendStatus = "starting";
let endpointPromise: Promise<string> | null = null;
const statusListeners = new Set<(status: BackendStatus) => void>();

function notifyStatus(status: BackendStatus): void {
  currentStatus = status;
  for (const listener of Array.from(statusListeners)) {
    try {
      listener(status);
    } catch {
      /* ignore listener errors */
    }
  }
}

/**
 * Returns the currently verified backend base URL.
 * In desktop mode: e.g. "http://127.0.0.1:3000".
 * In browser mode: "" (empty string, preserving relative same-origin calls).
 */
export function getApiBaseUrl(): string {
  if (!isTauri()) return "";
  return verifiedBaseUrl;
}

/** Set the active API base URL in memory (e.g. after a port change or readiness discovery). */
export function setApiBaseUrl(url: string): void {
  verifiedBaseUrl = url.replace(/\/+$/, "");
  if (verifiedBaseUrl) {
    notifyStatus("ready");
  }
}

/** Resolves an API path (e.g. "/api/chat" or "/readyz") against the verified backend origin. */
export function resolveApiUrl(path: string): string {
  const base = getApiBaseUrl();
  if (!base) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${cleanPath}`;
}

/**
 * Explicit REST helper. Resolves paths against the verified backend origin.
 * In desktop mode: calls http://127.0.0.1:<port>/api/...
 * In browser mode: calls /api/... same-origin.
 */
export async function apiFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (isTauri() && !verifiedBaseUrl) {
    try {
      await ensureApiBaseUrl();
    } catch {
      /* best-effort fallback to empty base URL */
    }
  }
  if (typeof input === "string") {
    return fetch(resolveApiUrl(input), init);
  }
  if (input instanceof URL) {
    return fetch(resolveApiUrl(input.pathname + input.search), init);
  }
  if (input instanceof Request) {
    const resolvedUrl = resolveApiUrl(input.url);
    if (resolvedUrl === input.url) {
      return fetch(input, init);
    }
    return fetch(new Request(resolvedUrl, input), init);
  }
  return fetch(input, init);
}

let eventListenersAttached = false;
async function setupTauriEventListeners(): Promise<void> {
  if (eventListenersAttached || !isTauri()) return;
  eventListenersAttached = true;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<EndpointInfo>("backend-ready", (event) => {
      if (event.payload?.base_url) {
        setApiBaseUrl(event.payload.base_url);
      }
    });
    await listen<{ status: BackendStatus; reason?: string }>("backend-status", (event) => {
      if (event.payload?.status) {
        notifyStatus(event.payload.status);
      }
    });
  } catch {
    /* event listener setup is best-effort */
  }
}

/**
 * Ensures the backend endpoint is verified and returns the base URL.
 * Multiple concurrent callers share the same singleflight promise.
 */
export async function ensureApiBaseUrl(): Promise<string> {
  if (!isTauri()) return "";
  if (verifiedBaseUrl) return verifiedBaseUrl;
  if (endpointPromise) return endpointPromise;

  endpointPromise = (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke<EndpointInfo>("get_api_endpoint");
      setApiBaseUrl(info.base_url);
      void setupTauriEventListeners();
      return info.base_url;
    } catch (err) {
      notifyStatus("failed");
      throw err;
    } finally {
      endpointPromise = null;
    }
  })();

  return endpointPromise;
}

/** Notify Rust that the port was updated at runtime. */
export async function updateVerifiedPort(port: number): Promise<void> {
  if (!isTauri()) return;
  setApiBaseUrl(`http://127.0.0.1:${port}`);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("update_verified_port", { port });
  } catch {
    /* best-effort */
  }
}

/** Trigger a manual restart of the backend sidecar. */
export async function retryBackend(): Promise<void> {
  if (!isTauri()) return;
  notifyStatus("starting");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("retry_startup");
  } catch {
    /* best-effort */
  }
}

export function getBackendStatus(): BackendStatus {
  if (!isTauri()) return "ready";
  return currentStatus;
}

export function onBackendStatusChange(listener: (status: BackendStatus) => void): () => void {
  statusListeners.add(listener);
  listener(currentStatus);
  return () => {
    statusListeners.delete(listener);
  };
}

export async function windowMinimize(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().minimize();
}

export async function windowToggleMaximize(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().toggleMaximize();
}

export async function windowIsMaximized(): Promise<boolean> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().isMaximized();
}

/** Subscribe to window-resize events; resolves to the unlisten function. */
export async function onWindowResized(handler: () => void): Promise<() => void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onResized(handler);
}

export async function windowClose(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

/**
 * OS autostart state via the official Tauri autostart plugin. The OS
 * registration is the single source of truth — nothing is cached in app
 * config. The dynamic import (plus `vite-ignore`) keeps the browser bundle
 * free of Tauri code; call only when `isTauri()` is true.
 */
export async function isAutostartEnabled(): Promise<boolean> {
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}

/** Enables or disables OS autostart. Throws when the OS call fails. */
export async function setAutostartEnabled(on: boolean): Promise<void> {
  const { enable, disable } = await import("@tauri-apps/plugin-autostart");
  if (on) await enable();
  else await disable();
}

/**
 * Opens a directory in the OS file manager via the official Tauri opener
 * plugin. Returns false in the browser, which has no way to reach the desktop
 * — callers gate the menu item on `isTauri()` so this is an invariant, not a
 * silent no-op the user can trigger.
 */
export async function openFolderInExplorer(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
  return true;
}

// ── Window Zoom (Official Tauri 2 WebView API) ──────────────────────────────
export const WINDOW_ZOOM_STORAGE_KEY = "tbai-window-zoom";
export const DEFAULT_WINDOW_ZOOM = 1.0;
export const WINDOW_ZOOM_PRESETS = [0.8, 0.9, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0] as const;
export const WINDOW_ZOOM_MIN = 0.8;
export const WINDOW_ZOOM_MAX = 3.0;

/** Same-document notification (the `storage` event does not fire in the writing document). */
export const WINDOW_ZOOM_CHANGED_EVENT = "tbai:window-zoom-changed";

export function notifyWindowZoomChanged(zoom: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(WINDOW_ZOOM_CHANGED_EVENT, { detail: { zoom: clampWindowZoom(zoom) } }),
  );
}

export function onWindowZoomChange(listener: (zoom: number) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ zoom?: number }>).detail;
    if (detail && typeof detail.zoom === "number" && Number.isFinite(detail.zoom)) {
      listener(clampWindowZoom(detail.zoom));
    }
  };
  window.addEventListener(WINDOW_ZOOM_CHANGED_EVENT, handler);
  return () => window.removeEventListener(WINDOW_ZOOM_CHANGED_EVENT, handler);
}

export function clampWindowZoom(val: number): number {
  if (!Number.isFinite(val)) return DEFAULT_WINDOW_ZOOM;
  return Math.min(WINDOW_ZOOM_MAX, Math.max(WINDOW_ZOOM_MIN, Math.round(val * 100) / 100));
}

export function readWindowZoom(): number {
  if (typeof window === "undefined") return DEFAULT_WINDOW_ZOOM;
  try {
    const raw = window.localStorage.getItem(WINDOW_ZOOM_STORAGE_KEY);
    if (!raw) return DEFAULT_WINDOW_ZOOM;
    const parsed = Number.parseFloat(raw);
    return clampWindowZoom(parsed);
  } catch {
    return DEFAULT_WINDOW_ZOOM;
  }
}

export function writeWindowZoom(zoom: number): void {
  if (typeof window === "undefined") return;
  try {
    const clamped = clampWindowZoom(zoom);
    window.localStorage.setItem(WINDOW_ZOOM_STORAGE_KEY, String(clamped));
  } catch {
    // Ignore localStorage write failures
  }
}

export type WindowZoomRequestStatus = "applied" | "failed" | "superseded";

export interface WindowZoomRequestResult {
  status: WindowZoomRequestStatus;
  /** The clamped zoom target this request asked to apply. */
  zoom: number;
}

type ZoomRequest = {
  target: number;
  resolve: (result: WindowZoomRequestResult) => void;
};

// Serialized latest-pending queue: one active native operation, at most one
// replaceable pending request. `confirmedZoom` starts from the persisted
// baseline; in Tauri it becomes authoritative only after a successful native
// `setZoom()` commits. In browser mode there is no native authority and
// `getConfirmedWindowZoom()` reads persisted state dynamically.
let activeRequest: ZoomRequest | null = null;
let pendingRequest: ZoomRequest | null = null;
let activeWorker: Promise<void> | null = null;
let confirmedZoom = clampWindowZoom(readWindowZoom());
let latestRequestedTarget = confirmedZoom;

/** @internal Test-only: resets queue state. Call only when no requests are in flight. */
export function __resetZoomQueueForTests(): void {
  activeRequest = null;
  pendingRequest = null;
  activeWorker = null;
  confirmedZoom = clampWindowZoom(readWindowZoom());
  latestRequestedTarget = confirmedZoom;
}

/**
 * Authoritative confirmed zoom for the current app lifetime. In Tauri this is
 * the last successfully applied native WebView zoom (in-memory). In browser
 * mode it reads persisted state dynamically because there is no native zoom
 * authority. Does not change `readWindowZoom()`'s persisted-reader meaning.
 */
export function getConfirmedWindowZoom(): number {
  if (!isTauri()) return readWindowZoom();
  return confirmedZoom;
}

/**
 * Latest requested zoom target while work is active/pending (for rapid shortcut
 * stepping), otherwise the last confirmed zoom.
 */
export function getTargetWindowZoom(): number {
  if (activeRequest || pendingRequest) return latestRequestedTarget;
  return getConfirmedWindowZoom();
}

function settle(request: ZoomRequest, status: WindowZoomRequestStatus): void {
  request.resolve({ status, zoom: request.target });
}

function commitConfirmedZoom(zoom: number): void {
  confirmedZoom = clampWindowZoom(zoom);
  // Best-effort persistence: a storage failure must not turn native success into
  // failure or corrupt confirmed runtime state.
  writeWindowZoom(confirmedZoom);
  notifyWindowZoomChanged(confirmedZoom);
}

async function runZoomWorker(): Promise<void> {
  try {
    while (activeRequest) {
      const current = activeRequest;

      let applied = false;
      try {
        if (isTauri()) {
          const { getCurrentWebview } = await import("@tauri-apps/api/webview");
          await getCurrentWebview().setZoom(current.target);
          applied = true;
        }
      } catch {
        applied = false;
      }

      if (applied) {
        commitConfirmedZoom(current.target);
        if (pendingRequest) {
          // Native side effect is committed; this caller's intent was overtaken.
          settle(current, "superseded");
          activeRequest = pendingRequest;
          pendingRequest = null;
          continue;
        }
        settle(current, "applied");
        activeRequest = null;
        latestRequestedTarget = confirmedZoom;
        break;
      }

      // Native failure: retain confirmed state, do not persist failed target.
      settle(current, "failed");
      if (pendingRequest) {
        activeRequest = pendingRequest;
        pendingRequest = null;
        continue;
      }
      activeRequest = null;
      latestRequestedTarget = confirmedZoom;
      break;
    }
  } finally {
    // Defensive: callers must never hang if an unexpected path leaves requests.
    if (pendingRequest) {
      settle(pendingRequest, "superseded");
      pendingRequest = null;
    }
    if (activeRequest) {
      settle(activeRequest, "failed");
      activeRequest = null;
    }
    if (!activeRequest && !pendingRequest) {
      latestRequestedTarget = confirmedZoom;
    }
    activeWorker = null;
  }
}

/**
 * Requests a native window zoom (0.8 - 3.0) with centralized latest-wins ordering.
 * Desktop (Tauri) only: requests are serialized with at most one replaceable
 * pending request. Every successful native `setZoom` is committed as confirmed
 * state (in-memory, best-effort persistence, same-window notification) even when
 * a newer request is waiting. `result.zoom` is always the clamped target
 * requested by that caller.
 */
export function requestWindowZoom(zoom: number): Promise<WindowZoomRequestResult> {
  const target = clampWindowZoom(zoom);
  if (!isTauri()) {
    return Promise.resolve({ status: "failed", zoom: target });
  }
  latestRequestedTarget = target;
  return new Promise<WindowZoomRequestResult>((resolve) => {
    const request: ZoomRequest = { target, resolve };
    if (activeRequest) {
      if (pendingRequest) {
        settle(pendingRequest, "superseded");
      }
      pendingRequest = request;
      return;
    }
    activeRequest = request;
    if (!activeWorker) {
      activeWorker = runZoomWorker();
    }
  });
}
