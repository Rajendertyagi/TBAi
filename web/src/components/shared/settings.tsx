import type { ReactNode } from "react";
import type { ComponentType, ReactElement } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui";

/**
 * Shared settings-page grammar (one level above raw inputs): a page shell
 * with title + description, titled sections, and label/control rows.
 * Feature pages compose these — they never re-implement spacing, type
 * sizes, or control placement. Kept deliberately small; extend only when
 * two pages need the same pattern.
 */

export function SettingsPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto h-full w-full max-w-3xl space-y-4 overflow-y-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-base font-semibold">{title}</h1>
          {description && (
            <p className="text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function SettingsSection({
  title,
  icon,
  description,
  action,
  control,
  controlId,
  children,
  className,
}: {
  title: string;
  /** Small decorative glyph in front of the heading. */
  icon?: ComponentType<{ className?: string }>;
  description?: string;
  /** Button-like action pinned to the heading's right. */
  action?: ReactNode;
  /**
   * Compact control (switch/select) pinned to the heading's right, turning
   * the header into the section's single row. Prefer `controlId` with it so
   * the heading labels the control.
   */
  control?: ReactNode;
  controlId?: string;
  children?: ReactNode;
  className?: string;
}) {
  const Icon = icon;
  return (
    <section
      className={cn("space-y-3 rounded-xl border border-border bg-card p-4", className)}
    >
      <div
        className={cn(
          "flex justify-between gap-3",
          description ? "items-start" : "items-center",
        )}
      >
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">
            {controlId ? (
              <label
                htmlFor={controlId}
                className="flex cursor-pointer items-center gap-2"
              >
                {Icon && (
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                {title}
              </label>
            ) : (
              <span className="flex items-center gap-2">
                {Icon && (
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                {title}
              </span>
            )}
          </h2>
          {description && (
            <p className="text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {(action ?? control) && (
          <div className="shrink-0">{action ?? control}</div>
        )}
      </div>
      {children}
    </section>
  );
}

export function SettingRow({
  label,
  icon,
  description,
  control,
  children,
  className,
}: {
  label: string;
  icon?: ComponentType<{ className?: string }>;
  description?: string;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const Icon = icon;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        className={cn(
          "flex justify-between gap-3",
          description ? "items-start" : "items-center",
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm">
            {Icon && (
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            {label}
          </div>
          {description && (
            <div className="text-xs leading-5 text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * Failure banner for a section that couldn't load or save. Destructive
 * tokens (both themes) + glyph so it reads as failure at a glance.
 */
export function SettingsError({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive",
        className,
      )}
    >
      <span className="flex h-5 shrink-0 items-center">
        <AlertCircle className="size-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/**
 * Footer for a section whose values persist on demand. Carries its own
 * in-flight state so sections never re-decide how a save renders.
 */
export function SettingsSaveBar({
  onSave,
  saving,
  disabled,
  label,
  savingLabel,
  className,
}: {
  onSave: () => void;
  saving: boolean;
  disabled?: boolean;
  label: ReactElement | string;
  savingLabel: ReactElement | string;
  className?: string;
}) {
  return (
    <div className={cn("flex justify-end pt-1", className)}>
      <Button type="button" size="sm" onClick={onSave} disabled={disabled || saving}>
        {saving ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            {savingLabel}
          </>
        ) : (
          label
        )}
      </Button>
    </div>
  );
}
