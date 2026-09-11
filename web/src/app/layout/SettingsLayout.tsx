import type { ReactNode } from "react";
import { useEffect, useState, type ComponentType } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { getSettingsNav } from "../../config/navigation";

const LAST_SETTINGS_ROUTE_KEY = "tbai:settingsRoute";

/** Last visited settings route (sidebar Settings row returns here). */
export function lastSettingsRoute(): string {
  try {
    const raw = window.localStorage.getItem(LAST_SETTINGS_ROUTE_KEY);
    if (typeof raw === "string" && raw.startsWith("/")) return raw;
  } catch {
    /* ignore */
  }
  return "/providers";
}

/**
 * Settings area shell (codeg-style): sub-sidebar with every settings
 * section on the left, the active section on the right. Mounted as a
 * pathless layout route so settings URLs stay flat (/providers, /mcp, …)
 * and the main sidebar is untouched. Entries come from navigation.ts
 * (getSettingsNav) — never hardcoded here.
 */
export function SettingsLayout() {
  const { pathname } = useLocation();
  const items = getSettingsNav();

  // Remember where the sidebar Settings row should return to. Settings
  // views never open tabs (codeg parity) — navigation only switches views.
  useEffect(() => {
    try {
      window.localStorage.setItem(LAST_SETTINGS_ROUTE_KEY, pathname);
    } catch {
      /* ignore */
    }
  }, [pathname]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-muted/30 px-2 py-3">
        <div className="px-2 text-xs font-medium text-muted-foreground">
          Settings
        </div>
        <nav className="space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            const active =
              pathname === item.route || pathname.startsWith(`${item.route}/`);
            return (
              <Link
                key={item.id}
                to={item.route}
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
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

/** Collapsible wrapper for long settings sections (codeg disclosure grammar). */
export function CollapsibleSection({
  title,
  icon: Icon,
  description,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon?: ComponentType<{ className?: string }>;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 p-4 text-left"
      >
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
        <span className="flex-1 text-sm font-semibold">{title}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {description && (
        <p className="-mt-2 px-4 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      )}
      {open && <div className="space-y-3 p-4 pt-3">{children}</div>}
    </div>
  );
}
