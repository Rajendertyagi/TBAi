import { useEffect } from "react";
import { AppShell } from "@/app/layout/AppShell";
import { useSettingsStore } from "@/stores";
import { OpenCodeView } from "./OpenCodeView";

/**
 * OpenCode surface shell. Uses the unified `AppShell` so all application
 * chrome (Sidebar, TabStrip, StatusBar, WindowControls, Edge Chrome) renders,
 * while wrapping `OpenCodeView` inside `OpenCodeIsolationBoundary` (`AuiProvider extends={null}`)
 * to cut off ambient assistant-ui context so OpenCode establishes its own isolated runtime.
 */
export function CodeShell() {
  const { loadProviders } = useSettingsStore();
  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  return (
    <AppShell>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <OpenCodeView />
      </div>
    </AppShell>
  );
}
