import { useEffect, type ComponentType } from "react";
import { useParams } from "react-router";
import { appConfig } from "../../config/navigation";
import { SettingsNav } from "./SettingsNav";
import { ProvidersPage } from "../../features/providers/ProvidersPage";
import { AppearancePage } from "../../features/appearance/AppearancePage";
import { WorkspacePage } from "../../features/workspace/WorkspacePage";
import { MemoryPanel } from "../../components/MemoryPanel";
import { McpPanel } from "../../components/McpPanel";
import { LogsPanel } from "../../components/LogsPanel";
import { DesktopSettings } from "../../features/desktop/DesktopSettings";

/** Section id (route segment) → page component. Same 7 as the in-app area. */
const SECTION_COMPONENTS: Record<string, ComponentType> = {
  memory: MemoryPanel,
  mcp: McpPanel,
  logs: LogsPanel,
  providers: ProvidersPage,
  appearance: AppearancePage,
  desktop: DesktopSettings,
  workspace: WorkspacePage,
};

const DEFAULT_SECTION = appConfig.settingsIndexRoute.replace(/^\//, "");

/**
 * Dedicated settings-window shell (decorated native window on desktop):
 * settings nav + section content, and nothing else — no activity rail,
 * sidebar, tabs, status bar, or corner overlays. Unknown sections fall back
 * to the default instead of redirecting (a redirect would land the window
 * on chat, which must never render here).
 */
export function SettingsWindow() {
  const { section } = useParams();
  const key =
    section && section in SECTION_COMPONENTS ? section : DEFAULT_SECTION;
  const Section = SECTION_COMPONENTS[key] ?? ProvidersPage;

  useEffect(() => {
    document.title = "TBAi Settings";
  }, []);

  return (
    <div className="flex h-screen min-w-0 bg-background text-foreground">
      <SettingsNav base="/settings-window" />
      <div className="min-w-0 flex-1">
        <Section />
      </div>
    </div>
  );
}
