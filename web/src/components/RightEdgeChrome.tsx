import { isTauri, windowStartResizing, type Edge } from "../lib/platform";

/**
 * Thin right-edge resize handle. Only present in the Tauri shell; initiates a
 * native East resize on pointer-down. In the browser it renders nothing.
 */
export function RightEdgeChrome() {
  if (!isTauri()) return null;
  return (
    <div
      aria-hidden
      onPointerDown={() => void windowStartResizing("right" as Edge)}
      className="fixed right-0 top-0 z-50 h-full w-1 cursor-ew-resize"
    />
  );
}
