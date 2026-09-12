// Platform abstraction layer.
//
// Every Tauri-specific capability is reached through a dynamic `import()` here
// so the browser bundle never statically pulls in `@tauri-apps/*`. The desktop
// chrome components import ONLY from this module; the rest of the app stays
// provider/transport agnostic and behaves identically in a plain browser.

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type Platform = "linux" | "windows" | "macos" | "web";

/**
 * Best-effort platform detection. Works in both the browser and the Tauri
 * webview (the webview user-agent carries the OS). Avoids pulling in an extra
 * Tauri plugin for what is a one-line UA check.
 */
export function getPlatform(): Platform {
  if (typeof navigator === "undefined") return "web";
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad|iPod/.test(ua)) return "macos";
  if (/Win/.test(ua)) return "windows";
  if (/Linux|X11|CrOS/.test(ua)) return "linux";
  return "web";
}

export function isMac(): boolean {
  return getPlatform() === "macos";
}

export function isWindows(): boolean {
  return getPlatform() === "windows";
}

export function isLinux(): boolean {
  return getPlatform() === "linux";
}

export type ResizeDir =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "SouthEast"
  | "NorthWest"
  | "SouthWest";

export async function windowMinimize(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().minimize();
}

export async function windowToggleMaximize(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().toggleMaximize();
}

export async function windowClose(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

/** Begin a native edge/corner resize drag (used by the window resize grips). */
export async function windowStartResizeDragging(dir: ResizeDir): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startResizeDragging(dir);
}

/** Open a folder in the OS file explorer (reveal-in-explorer). */
export async function openInExplorer(target: string): Promise<void> {
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(target);
}
