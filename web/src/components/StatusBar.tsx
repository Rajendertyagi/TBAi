import { Circle } from "lucide-react";
import { useLocation, useNavigate, useParams } from "react-router";
import { appConfig, getNavItem } from "../config/navigation";
import { statusBarConfig } from "../config/statusBar";
import { useSettingsStore } from "../stores/index";
import { useAvailabilityStore } from "../features/availability/availabilityStore";
import { useOpenCodeConversationConfig } from "../features/opencode/useOpenCodeConversationConfig";
import { useServerIdentity } from "../features/desktop/state/serverIdentity";
import { StatusBarQuickActions } from "./StatusBarQuickActions";
import { cn } from "../lib/utils";

/**
 * Bottom status bar (codeg geometry): `h-8` band, quick-actions launcher +
 * backend/server status on the left, current model on the right. Provider
 * and server entries open their dedicated settings surfaces (single-gear
 * rule — no settings buttons live here). Visibility is gated once, by
 * `AppShell` (`statusBarVisible`); this component never self-nulls.
 *
 * Left: the availability authority's state (dot + label) suffixed with the
 * live `:port` — one indicator answering "is the backend up, and which one".
 * Mode-aware right: `/code/*` shows the Code conversation's live agent +
 * model (override-reactive, so chip edits reflect instantly); every other
 * surface shows the Direct provider + model. A Code chat with no bound
 * conversation yet renders nothing on the right rather than a stale model.
 */
export function StatusBar() {
  const copy = statusBarConfig.copy;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { agentId } = useParams();

  const providers = useSettingsStore((s) => s.providers);
  const activeProviderId = useSettingsStore((s) => s.activeProviderId);
  const selectedProviderId = useSettingsStore((s) => s.selectedProviderId);
  const selectedModelId = useSettingsStore((s) => s.selectedModelId);

  const providerId = selectedProviderId ?? activeProviderId;
  const provider = providers.find((p) => p.id === providerId);
  const directModelLabel =
    (selectedModelId
      ? provider?.models?.find((m) => m.id === selectedModelId)?.label
      : undefined) ?? provider?.model;
  const directLabel = provider
    ? `${provider.name}${directModelLabel ? ` · ${directModelLabel}` : ""}`
    : copy.noProvider;

  const isCode = pathname.startsWith("/code");
  const codeConfig = useOpenCodeConversationConfig(
    isCode ? agentId : undefined,
  );
  const codeLabel = codeConfig
    ? [codeConfig.opencodeAgent, codeConfig.opencodeModel]
        .filter((v): v is string => !!v)
        .join(" · ")
    : null;
  const rightLabel = isCode ? codeLabel : directLabel;

  const availability = useAvailabilityStore((s) => s.status);
  const { identity } = useServerIdentity();
  const serverPort = identity?.activePort;
  const availabilityLabel =
    availability === "online"
      ? copy.availabilityOnline
      : availability === "degraded"
        ? copy.availabilityDegraded
        : availability === "offline"
          ? copy.availabilityOffline
          : copy.availabilityUnknown;
  const availabilityTitle =
    availability === "online"
      ? copy.availabilityOnlineTitle
      : availability === "degraded"
        ? copy.availabilityDegradedTitle
        : availability === "offline"
          ? copy.availabilityOfflineTitle
          : copy.availabilityUnknownTitle;
  const serverTitle =
    availability === "offline" || serverPort == null
      ? copy.serverOffline
      : `${copy.openServer} (port ${serverPort})`;

  const openProviders = () =>
    navigate(getNavItem("providers")?.route ?? appConfig.settingsIndexRoute);
  const openServer = () =>
    navigate(getNavItem("desktop")?.route ?? appConfig.settingsIndexRoute);

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between border-t border-border bg-statusbar pl-2 pr-4 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-3">
        <StatusBarQuickActions />
        <button
          type="button"
          onClick={openServer}
          title={`${availabilityTitle} — ${serverTitle}`}
          aria-label={serverTitle}
          className="flex items-center gap-1.5 rounded outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Circle
            aria-hidden="true"
            className={cn(
              "size-2 fill-current",
              availability === "online" && "text-emerald-500",
              availability === "degraded" && "text-amber-500",
              availability === "offline" && "text-destructive",
              availability === "unknown" && "text-muted-foreground/40",
            )}
          />
          <span>{availabilityLabel}</span>
          <span className="tabular-nums">
            {serverPort != null ? `:${serverPort}` : "…"}
          </span>
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        {rightLabel ? (
          <button
            type="button"
            onClick={openProviders}
            title={isCode ? rightLabel : copy.openProviders}
            className="hidden min-w-0 max-w-55 truncate rounded outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring md:block"
          >
            {rightLabel}
          </button>
        ) : null}
      </div>
    </footer>
  );
}
