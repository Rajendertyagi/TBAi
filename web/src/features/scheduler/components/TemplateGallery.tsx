import { Plus } from "lucide-react";
import { schedulerViewConfig } from "@/config/scheduler";
import {
  JOB_TEMPLATES,
  type JobTemplate,
  type RepeatPreset,
} from "@/features/scheduler/lib/scheduler-templates";
import { cn } from "@/lib/utils";

/** Human schedule chip for a template card (mode label, never raw cron). */
export function templateScheduleLabel(
  copy: typeof schedulerViewConfig.copy,
  tpl: JobTemplate,
): string {
  if (tpl.scheduleType === "once") return copy.repeatOnce;
  const mode: Record<RepeatPreset, string> = {
    minutes: copy.repeatMinutes,
    hourly: copy.repeatHourly,
    daily: copy.repeatDaily,
    weekdays: copy.repeatWeekdays,
    weekly: copy.repeatWeekly,
    monthly: copy.repeatMonthly,
    advanced: copy.repeatAdvanced,
  };
  return mode[tpl.mode];
}

/**
 * Card-grid picker for the empty state and the New flow (codeg
 * `TemplateGallery` parity). First card starts blank; the rest seed the
 * editor from a starter template. `onPick(null)` = blank.
 */
export function TemplateGallery({
  onboarding,
  onPick,
  onCancel,
}: {
  onboarding: boolean;
  onPick: (template: JobTemplate | null) => void;
  onCancel?: () => void;
}) {
  const copy = schedulerViewConfig.copy;

  return (
    <div className="flex min-h-full flex-col">
      <div
        className={cn(
          "mx-auto flex w-full max-w-4xl flex-col gap-6 p-4",
          onboarding && "my-auto",
        )}
      >
        {onboarding ? (
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Plus aria-hidden="true" className="size-6" />
            </span>
            <h2 className="text-base font-semibold">{copy.noJobs}</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {copy.noJobsHint}
            </p>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {copy.startFromTemplate}
            </h2>
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              >
                {copy.cancel}
              </button>
            )}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
          <button
            type="button"
            onClick={() => onPick(null)}
            className={cn(
              "group flex flex-col items-start gap-2 rounded-xl border border-dashed border-border bg-card/40 p-4 text-left transition-colors",
              "hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <span className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Plus aria-hidden="true" className="size-5" />
            </span>
            <span className="text-sm font-medium">{copy.blankTitle}</span>
            <span className="text-xs text-muted-foreground">{copy.blankDesc}</span>
          </button>

          {JOB_TEMPLATES.map((tpl) => {
            const Icon = tpl.icon;
            return (
              <button
                key={tpl.id}
                type="button"
                onClick={() => onPick(tpl)}
                className={cn(
                  "group flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors",
                  "hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <span className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Icon aria-hidden="true" className="size-5" />
                </span>
                <span className="text-sm font-medium">{tpl.name}</span>
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {tpl.description}
                </span>
                <span className="mt-auto inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {templateScheduleLabel(copy, tpl)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
