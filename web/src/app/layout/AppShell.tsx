import { lazy, Suspense, useState, type ComponentType } from "react";
import { Outlet, useLocation } from "react-router";
import { Sidebar } from "../../components/Sidebar";
import { StatusBar } from "../../components/StatusBar";
import { TabUrlSync } from "../TabUrlSync";
import { isTauri } from "../../lib/platform";
import { useDesktopLayout } from "../../features/desktop/state/desktopLayout";

// Desktop chrome is code-split and only fetched inside the Tauri shell, keeping
// every `@tauri-apps/*` import out of the browser bundle.
const DesktopChrome = lazy(
  () => import("../../components/DesktopChrome"),
) as ComponentType;

/**
 * Application shell: persistent sidebar + routed main surface. In the Tauri
 * desktop shell a custom title bar + tab strip are mounted above the sidebar
 * and an optional status bar below; in a plain browser they are absent and the
 * layout is unchanged. The sidebar/status-bar visibility is driven by the
 * desktop layout store (Tauri only; browser always shows the sidebar).
 * Must render inside AssistantRuntimeProvider (sidebar thread list, tab titles,
 * and all views consume the ambient runtime).
 */
export function AppShell() {
  const { pathname } = useLocation();
  const [tauri] = useState(() => isTauri());
  const sidebarVisible = useDesktopLayout((s) => s.sidebarVisible);
  const statusBarVisible = useDesktopLayout((s) => s.statusBarVisible);
  const showSidebar = tauri ? sidebarVisible : true;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {tauri && (
        <Suspense fallback={null}>
          <DesktopChrome />
        </Suspense>
      )}
      <div
        key={pathname}
        className="flex min-w-0 flex-1 animate-in fade-in-0 flex-row overflow-hidden duration-150"
      >
        {showSidebar && <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
      </div>
      {tauri && statusBarVisible && <StatusBar />}
      <TabUrlSync />
    </div>
  );
}
