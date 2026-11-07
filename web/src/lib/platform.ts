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

// Centralized, latest-wins zoom ordering shared by all callers (Typography page, global
// shortcuts). Native setZoom, persistence, and same-window notifications only commit for the
// latest requested intent; superseded/failed requests never persist or notify a false success.
let zoomSeq = 0;
let latestZoomId = 0;
let latestRequestedZoom: number | null = null;
let zoomWorker: Promise<void> | null = null;
const zoomPending = new Map<
  number,
  { zoom: number; resolve: (result: WindowZoomRequestResult) => void }
>();

/** Latest requested zoom target (if any), otherwise the last confirmed/persisted zoom. */
export function getTargetWindowZoom(): number {
  return latestRequestedZoom ?? readWindowZoom();
}

function settleZoomRequest(id: number, result: WindowZoomRequestResult): void {
  const entry = zoomPending.get(id);
  if (!entry) return;
  zoomPending.delete(id);
  entry.resolve(result);
}

function supersedeZoomRequestsExcept(keepId: number): void {
  for (const [id, entry] of Array.from(zoomPending.entries())) {
    if (id === keepId) continue;
    zoomPending.delete(id);
    entry.resolve({ status: "superseded", zoom: entry.zoom });
  }
}

async function runZoomWorker(): Promise<void> {
  try {
    while (latestZoomId !== 0 && zoomPending.has(latestZoomId)) {
      const targetId = latestZoomId;
      const target = zoomPending.get(targetId);
      if (!target) break;
      const targetZoom = target.zoom;

      let applied = false;
      if (isTauri()) {
        try {
          const { getCurrentWebview } = await import("@tauri-apps/api/webview");
          await getCurrentWebview().setZoom(targetZoom);
          applied = true;
        } catch {
          applied = false;
        }
      }

      // A newer request arrived while the native call was in flight: never persist/notify this
      // intermediate result; converge by applying the latest target next.
      if (latestZoomId !== targetId) {
        settleZoomRequest(targetId, { status: "superseded", zoom: targetZoom });
        continue;
      }

      if (applied) {
        writeWindowZoom(targetZoom);
        notifyWindowZoomChanged(targetZoom);
        latestRequestedZoom = targetZoom;
        supersedeZoomRequestsExcept(targetId);
        settleZoomRequest(targetId, { status: "applied", zoom: targetZoom });
      } else {
        latestRequestedZoom = readWindowZoom();
        supersedeZoomRequestsExcept(targetId);
        settleZoomRequest(targetId, { status: "failed", zoom: targetZoom });
      }
    }
  } finally {
    // Resolve any orphaned pending requests defensively.
    for (const [id, entry] of Array.from(zoomPending.entries())) {
      zoomPending.delete(id);
      entry.resolve({ status: "superseded", zoom: entry.zoom });
    }
    if (latestZoomId === 0 || !zoomPending.has(latestZoomId)) {
      latestRequestedZoom = null;
    }
    zoomWorker = null;
  }
}

/**
 * Requests a native window zoom (0.8 - 3.0) with centralized latest-wins ordering.
 * Desktop (Tauri) only: persists and notifies same-window listeners ONLY after a confirmed
 * native apply of the latest requested intent. Returns applied/failed/superseded; superseded
 * and failed requests never persist or report a false success.
 */
export function requestWindowZoom(zoom: number): Promise<WindowZoomRequestResult> {
  const clamped = clampWindowZoom(zoom);
  if (!isTauri()) {
    return Promise.resolve({ status: "failed", zoom: clamped });
  }
  const id = ++zoomSeq;
  latestZoomId = id;
  latestRequestedZoom = clamped;
  return new Promise<WindowZoomRequestResult>((resolve) => {
    zoomPending.set(id, { zoom: clamped, resolve });
    if (!zoomWorker) {
      zoomWorker = runZoomWorker();
    }
  });
}

/**
 * Applies native window zoom with centralized ordering. Returns true only when this request's
 * zoom was confirmed applied (not when superseded or failed).
 */
export async function applyWindowZoom(zoom: number): Promise<boolean> {
  const result = await requestWindowZoom(zoom);
  return result.status === "applied";
}
