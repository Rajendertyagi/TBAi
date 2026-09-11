import { isTauri, windowStartResizing, type Edge } from "../lib/platform";

/**
 * Thin left-edge resize handle. Only present in the Tauri shell; initiates a
 * native West resize on pointer-down. In the browser it renders nothing.
 */
export function LeftEdgeChrome() {
  if (!isTauri()) return null;
  return (
    <div
      aria-hidden
      onPointerDown={() => void windowStartResizing("left" as Edge)}
      className="fixed left-0 top-0 z-50 h-full w-1 cursor-ew-resize"
    />
  );
}
