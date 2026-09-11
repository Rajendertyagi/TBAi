import { Outlet, useLocation } from "react-router";
import { Sidebar } from "../../components/Sidebar";
import { TabUrlSync } from "../TabUrlSync";

/**
 * Application shell: persistent sidebar + routed main surface. The chat tab
 * strip lives inside the chat view (settings and other areas are full
 * width — they never open tabs). Must render inside
 * AssistantRuntimeProvider (sidebar thread list, tab titles, and all views
 * consume the ambient runtime).
 */
export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div
        key={pathname}
        className="flex min-w-0 flex-1 animate-in fade-in-0 flex-col overflow-hidden duration-150"
      >
        <Outlet />
      </div>
      <TabUrlSync />
    </div>
  );
}
