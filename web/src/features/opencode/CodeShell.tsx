import { useEffect } from "react";
import { ActivityBar } from "@/components/ActivityBar";
import { WindowControls } from "@/components/WindowControls";
import { PageContextMenu } from "@/components/PageContextMenu";
import { ChromeShortcuts } from "@/components/ChromeShortcuts";
import { TabUrlSync } from "@/app/TabUrlSync";
import { isTauri } from "@/lib/platform";
import { syncChromeVars } from "@/lib/chrome-vars";
import { useDesktopLayout } from "@/features/desktop/state/desktopLayout";
import { useSettingsStore } from "@/stores";
import { CodeHeader } from "./CodeHeader";
import { OpenCodeView } from "./OpenCodeView";

/**
 * Dedicated Code-mode shell. This subtree intentionally has NO normal-chat
 * `AssistantRuntimeProvider` above it: the OpenCode adapter's
 * `useRemoteThreadListRuntime` degrades to a parent-context no-op when nested
 * inside another RemoteThreadListRuntime (it then reads the chat thread id
 * where an OpenCode session id belongs). Mounting the adapter runtime at the
 * top of this shell — above it only theme/router chrome — gives it a real,
 * independent runtime with correct session identity.
 *
 * Focused chrome only: the chat Sidebar/TabStrip/StatusBar consume the chat
 * runtime and must not render here. Shared runtime-independent pieces
 * (activity rail, window controls, page menu, tab/url sync, shortcuts) are
 * reused verbatim. `OpenCodeView` creates the per-conversation adapter
 * runtime itself once its session exists.
 */
export function CodeShell() {
  const sidebarWidth = useDesktopLayout((s) => s.sidebarWidth);
  const searchOpen = useDesktopLayout((s) => s.searchOpen);
  const captionStrip = isTauri();

  // Chrome geometry tokens (title-band height, overlay reserves). The chat
  // shell publishes the same set; only one shell mounts at a time.
  useEffect(() => {
    syncChromeVars({ sidebarWidth, searchOpen, captionStrip });
  }, [sidebarWidth, searchOpen, captionStrip]);

  const { loadProviders } = useSettingsStore();
  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  return (
    <div className="relative flex h-screen flex-col bg-background text-foreground">
      <div className="relative flex min-w-0 flex-1 flex-row overflow-hidden">
        <ActivityBar />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative flex h-[var(--title-bar-height)] shrink-0 items-stretch border-b border-border bg-muted/40">
            <CodeHeader />
            {/* Reserve the right overlay cluster + caption buttons (Tauri). */}
            <div
              data-tauri-drag-region
              className="h-full w-[var(--right-chrome-reserve)] shrink-0"
            />
          </div>

          {/* Page-level context menu is its own chrome component; the shell only
              composes it around the routed content. */}
          <PageContextMenu>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <OpenCodeView />
            </div>
          </PageContextMenu>
        </main>
      </div>

      <div className="absolute right-0 top-0 z-50 h-[var(--title-bar-height)]">
        <WindowControls />
      </div>

      {/* Desktop keyboard shortcuts (self-gates on isTauri) */}
      <ChromeShortcuts />
      <TabUrlSync />
    </div>
  );
}
