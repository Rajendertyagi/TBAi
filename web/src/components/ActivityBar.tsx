import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { appConfig, getVisibleNav } from "../config/navigation";
import { cn } from "../lib/utils";

/**
 * VS Code–style activity bar: a narrow icon rail on the far left that mirrors
 * the application navigation (single source of truth = navigation.ts). Clicking
 * an icon switches the editor view; the active item gets a left accent bar.
 * The scheduler item shows the unseen-failure badge (codeg parity). Rendered in
 * BOTH the browser and the Tauri desktop (single unified shell); it is the far-
 * left icon rail in both surfaces.
 */
export function ActivityBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const items = getVisibleNav();
  const [schedUnseen, setSchedUnseen] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/scheduler/summary")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        let seen = 0;
        try {
          seen = Number(window.localStorage.getItem("tbai:schedSeenTs") ?? 0) || 0;
        } catch {
          /* ignore */
        }
        const problems = (data.problemRuns ?? []) as Array<{ startedAt: number }>;
        setSchedUnseen(problems.filter((p) => p.startedAt > seen).length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const isActive = (route: string) =>
    pathname === route || pathname.startsWith(`${route}/`);

  return (
    <nav
      aria-label="Primary"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/40 py-2"
    >
      <button
        type="button"
        onClick={() => navigate("/chat")}
        title={appConfig.branding.appName}
        className="mb-2 flex h-8 w-8 items-center justify-center rounded bg-foreground text-xs font-bold text-background"
      >
        {appConfig.branding.logoText}
      </button>
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActive(item.route);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => navigate(item.route)}
            title={item.label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex h-9 w-9 items-center justify-center rounded transition-colors",
              active
                ? "text-foreground before:absolute before:left-0 before:top-1/2 before:h-5 before:w-0.5 before:-translate-y-1/2 before:rounded-r before:bg-primary before:content-['']"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <Icon className="h-5 w-5" />
            {item.route === "/scheduler" && schedUnseen > 0 && (
              <span className="absolute right-1 top-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive/15 px-1 text-[9px] font-medium leading-none text-destructive">
                {schedUnseen}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
