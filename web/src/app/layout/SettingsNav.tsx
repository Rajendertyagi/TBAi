import { Link, useLocation } from "react-router";
import { cn } from "../../lib/utils";
import { getSettingsNav } from "../../config/navigation";

/**
 * Shared settings-area navigation (sub-sidebar). Used by both the in-app
 * `SettingsLayout` and the dedicated settings-window shell, so the two
 * surfaces can never drift apart. Entries come from `navigation.ts` —
 * never hardcoded here.
 *
 * `base` prefixes every link: `""` for the flat in-app routes (`/providers`),
 * `"/settings-window"` for the dedicated window (`/settings-window/mcp`).
 */
export function SettingsNav({ base = "" }: { base?: string }) {
  const { pathname } = useLocation();
  const items = getSettingsNav();

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-muted/30 px-2 py-3">
      <div className="px-2 text-xs font-medium text-muted-foreground">
        Settings
      </div>
      <nav className="space-y-1">
        {items.map((item) => {
          const Icon = item.icon;
          const route = `${base}${item.route}`;
          const active =
            pathname === route || pathname.startsWith(`${route}/`);
          return (
            <Link
              key={item.id}
              to={route}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                active
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
