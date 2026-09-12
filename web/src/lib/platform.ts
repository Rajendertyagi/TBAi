// Platform abstraction layer (Windows x64 desktop only).
//
// Every Tauri-specific capability is reached through a dynamic `import()` here
// so the browser bundle never statically pulls in `@tauri-apps/*`. The desktop
// chrome components import ONLY from this module; the rest of the app stays
// provider/transport agnostic and behaves identically in a plain browser.

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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
export async function onWindowResized(
  handler: () => void,
): Promise<() => void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onResized(handler);
}

export async function windowClose(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}
