import { getNavItem } from "@/config/navigation";
import { PageTitleStrip } from "@/components/PageTitleStrip";

/**
 * Breadcrumb title strip for the dedicated Scheduler page. Title comes from
 * `navigation.ts`, never a literal.
 */
export function SchedulerTitleStrip() {
  const label = getNavItem("scheduler")?.label ?? "Scheduler";
  // The Scheduler page has no other heading: the strip IS its page title.
  return <PageTitleStrip title={label} titleAs="h1" />;
}
