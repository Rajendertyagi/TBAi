import { TopBand } from "./TopBand";
import { LeftEdgeChrome } from "./LeftEdgeChrome";
import { RightEdgeChrome } from "./RightEdgeChrome";
import { ChromeShortcuts } from "./ChromeShortcuts";

/**
 * Composition root for the Tauri desktop chrome. Imported ONLY via a dynamic
 * `import()` from AppShell (behind the `isTauri()` gate), so none of the
 * `@tauri-apps/*` code or these components reach the browser bundle. The top
 * band (toggles + tabs + window controls) is a single `h-10` row; the edge
 * resize grips and global shortcuts are mounted separately.
 */
export default function DesktopChrome() {
  return (
    <>
      <TopBand />
      <LeftEdgeChrome />
      <RightEdgeChrome />
      <ChromeShortcuts />
    </>
  );
}
