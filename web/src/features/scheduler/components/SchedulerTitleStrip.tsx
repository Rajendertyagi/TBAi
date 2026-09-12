import { getNavItem } from "@/config/navigation";
import { PageTitleStrip } from "@/components/PageTitleStrip";

/**
 * Breadcrumb title strip for the dedicated Scheduler page. Title comes from
 * `navigation.ts`, never a literal.
 */
export function SchedulerTitleStrip() {
  const label = getNavItem("scheduler")?.label ?? "Scheduler";
  return <PageTitleStrip title={label} />;
}
