import { DesktopTitleBar } from "./DesktopTitleBar";
import { TabStrip } from "./TabStrip";
import { LeftEdgeChrome } from "./LeftEdgeChrome";
import { RightEdgeChrome } from "./RightEdgeChrome";
import { ChromeShortcuts } from "./ChromeShortcuts";

/**
 * Composition root for the Tauri desktop chrome. Imported ONLY via a dynamic
 * `import()` from AppShell (behind the `isTauri()` gate), so none of the
 * `@tauri-apps/*` code or these components reach the browser bundle.
 */
export default function DesktopChrome() {
  return (
    <>
      <DesktopTitleBar />
      <TabStrip />
      <LeftEdgeChrome />
      <RightEdgeChrome />
      <ChromeShortcuts />
    </>
  );
}
