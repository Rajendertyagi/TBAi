import { useNavigate } from "react-router";
import { LayoutGrid, MessageSquare } from "lucide-react";
import { getSettingsNav } from "@/config/navigation";
import { statusBarConfig } from "@/config/statusBar";
import { openSettingsTab } from "@/lib/settings-window";
import { isTauri, openSettingsWindow } from "@/lib/platform";
import { useDesktopLayout } from "@/features/desktop/state/desktopLayout";
import { useChatTabsStore } from "@/features/chat/state/chatTabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The quick-actions launcher pinned to the status bar's leading edge (the
 * window's bottom-left corner). Every entry exists elsewhere (rail, sidebar,
 * chrome), but those homes can hide with collapsed chrome — the status bar
 * never unmounts while visible, so this menu is the always-on path to all of
 * them. Labels for settings areas come from `navigation.ts`, never literals.
 */
export function StatusBarQuickActions() {
  const copy = statusBarConfig.copy;
  const navigate = useNavigate();
  const toggleSidebar = useDesktopLayout((s) => s.toggleSidebar);
  const toggleStatusBar = useDesktopLayout((s) => s.toggleStatusBar);
  const openChat = useChatTabsStore((s) => s.openChat);
  const areas = getSettingsNav();

  const handleNewChat = () => {
    openChat("new");
    navigate("/chat/new");
  };

  const handleOpenArea = (route: string) => {
    // Dedicated surface, deep-linked: native window on desktop, named
    // second tab on web (in-app route only when the popup is blocked).
    const section = route.replace(/^\//, "");
    if (isTauri()) {
      openSettingsWindow(section).catch(() => {
        navigate(route);
      });
    } else if (!openSettingsTab(section)) {
      navigate(route);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={copy.quickActions}
          aria-label={copy.quickActions}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <LayoutGrid aria-hidden="true" className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={handleNewChat}>
            <MessageSquare aria-hidden="true" className="size-4 text-muted-foreground" />
            {copy.newChat}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{copy.quickActions}</DropdownMenuLabel>
          {areas.map((item) => {
            const Icon = item.icon;
            return (
              <DropdownMenuItem
                key={item.id}
                onSelect={() => handleOpenArea(item.route)}
              >
                <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                {item.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => toggleSidebar()}>
            {copy.toggleSidebar}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => toggleStatusBar()}>
            {copy.toggleStatusBar}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
