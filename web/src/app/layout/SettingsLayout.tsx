import type { ReactNode } from "react";
import { useEffect, useState, type ComponentType } from "react";
import { Outlet, useLocation } from "react-router";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { rememberSettingsRoute, getSettingsNav } from "../../config/navigation";
import { PageTitleStrip } from "../../components/PageTitleStrip";
import { SettingsNav } from "./SettingsNav";

/**
 * Settings area shell (codeg-style): sub-sidebar with every settings
 * section on the left, the active section on the right. Mounted as a
 * pathless layout route so settings URLs stay flat (/providers, /mcp, …)
 * and the main sidebar is untouched. Entries come from navigation.ts
 * (getSettingsNav) — never hardcoded here.
 */
export function SettingsLayout() {
  const { pathname } = useLocation();

  // Remember where the rail gear should return to. Settings
  // views never open tabs (codeg parity) — navigation only switches views.
  useEffect(() => {
    rememberSettingsRoute(pathname);
  }, [pathname]);

  // Strip title follows the active section (falls back to plain Settings).
  const active = getSettingsNav().find(
    (item) => pathname === item.route || pathname.startsWith(`${item.route}/`),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTitleStrip title={active?.label ?? "Settings"} />
      <div className="flex min-h-0 flex-1">
        <SettingsNav />
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
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
