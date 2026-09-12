import { SchedulerPanel } from "../../components/SchedulerPanel";
import { SchedulerTitleStrip } from "./components/SchedulerTitleStrip";

/**
 * Dedicated Scheduler page (codeg automations-route parity): breadcrumb title
 * strip above the existing panel. Top-level under `AppShell` — never inside
 * the settings sub-sidebar.
 */
export function SchedulerPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SchedulerTitleStrip />
      <div className="min-h-0 flex-1">
        <SchedulerPanel />
      </div>
    </div>
  );
}
