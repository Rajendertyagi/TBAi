import { Circle } from "lucide-react";
import { useNavigate } from "react-router";
import { appConfig, getNavItem } from "../config/navigation";
import { statusBarConfig } from "../config/statusBar";
import { useSettingsStore } from "../stores/index";
import { useAvailabilityStore } from "../features/availability/availabilityStore";
import { StatusBarQuickActions } from "./StatusBarQuickActions";

/**
 * Bottom status bar (codeg geometry): `h-8` muted band, quick-actions
 * launcher + connection on the left, provider/model on the right. Provider
 * and model open the dedicated settings surface (single-gear rule — no
 * settings buttons live here). Visibility is gated once, by `AppShell`
 * (`statusBarVisible`); this component never self-nulls.
 */
export function StatusBar() {
  const copy = statusBarConfig.copy;
  const navigate = useNavigate();

  const providers = useSettingsStore((s) => s.providers);
  const activeProviderId = useSettingsStore((s) => s.activeProviderId);
  const selectedProviderId = useSettingsStore((s) => s.selectedProviderId);
  const selectedModelId = useSettingsStore((s) => s.selectedModelId);

  const providerId = selectedProviderId ?? activeProviderId;
  const provider = providers.find((p) => p.id === providerId);
  const modelLabel =
    (selectedModelId
      ? provider?.models?.find((m) => m.id === selectedModelId)?.label
      : undefined) ?? provider?.model;
  const statusLabel = provider
    ? `${provider.name}${modelLabel ? ` · ${modelLabel}` : ""}`
    : copy.noProvider;

  const openProviders = () =>
    navigate(getNavItem("providers")?.route ?? appConfig.settingsIndexRoute);

  // Global backend availability (Phase 3.3). Healthy keeps the existing
  // "Local" chrome byte-identical; degraded/offline states say explicitly
  // that visible data is last-known, never authoritative.
  const availability = useAvailabilityStore((s) => s.status);
  const availabilityCopy =
    availability === "offline"
      ? { label: copy.availabilityOffline, title: copy.availabilityOfflineTitle }
      : availability === "degraded"
        ? { label: copy.availabilityDegraded, title: copy.availabilityDegradedTitle }
        : availability === "online"
          ? { label: copy.availabilityOnline, title: copy.availabilityOnlineTitle }
          : { label: copy.availabilityUnknown, title: copy.availabilityUnknownTitle };
  const availabilityUnhealthy = availability === "offline" || availability === "degraded";

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between border-t border-border bg-muted/40 pl-2 pr-4 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-3">
        <StatusBarQuickActions />
        <button
          type="button"
          onClick={openProviders}
          title={availabilityCopy.title}
          className="flex items-center gap-1.5 rounded outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Circle
            aria-hidden="true"
            className={
              availabilityUnhealthy
                ? "size-2 fill-destructive text-destructive"
                : "size-2 fill-current"
            }
          />
          {availabilityCopy.label}
        </button>
        <button
          type="button"
          onClick={openProviders}
          title={statusLabel}
          className="hidden min-w-0 truncate rounded outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring sm:block"
        >
          {provider?.name ?? copy.noProvider}
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={openProviders}
          title={copy.openProviders}
          className="hidden min-w-0 max-w-55 truncate rounded outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring md:block"
        >
          {modelLabel ?? statusLabel}
        </button>
      </div>
    </footer>
  );
}
