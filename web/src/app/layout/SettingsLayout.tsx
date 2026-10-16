import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
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
