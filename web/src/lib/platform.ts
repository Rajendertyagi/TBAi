// Platform abstraction layer.
//
// Every Tauri-specific capability is reached through a dynamic `import()` here
// so the browser bundle never statically pulls in `@tauri-apps/*`. The desktop
// chrome components import ONLY from this module; the rest of the app stays
// provider/transport agnostic and behaves identically in a plain browser.

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type Edge = "left" | "right" | "top" | "bottom";

const EDGE_TO_DIRECTION: Record<Edge, "West" | "East" | "North" | "South"> = {
  left: "West",
  right: "East",
  top: "North",
  bottom: "South",
};

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

/** Begin a native edge-resize drag (used by the left/right edge chrome). */
export async function windowStartResizing(edge: Edge): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startResizeDragging(EDGE_TO_DIRECTION[edge]);
}

/** Open a folder in the OS file explorer (reveal-in-explorer). */
export async function openInExplorer(target: string): Promise<void> {
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(target);
}
