import { Circle, Settings } from "lucide-react";
import { useNavigate } from "react-router";
import { statusBarConfig } from "../config/statusBar";
import { useSettingsStore } from "../stores/index";
import { StatusBarQuickActions } from "./StatusBarQuickActions";

/**
 * Bottom status bar (codeg geometry): `h-8` muted band, quick-actions
 * launcher + connection on the left, provider/model + desktop settings on
 * the right. Visibility is gated once, by `AppShell` (`statusBarVisible`);
 * this component never self-nulls.
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

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between border-t border-border bg-muted/40 pl-2 pr-4 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-3">
        <StatusBarQuickActions />
        <button
          type="button"
          onClick={() => navigate("/providers")}
          title={copy.connectionTitle}
          className="flex items-center gap-1.5 rounded outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Circle aria-hidden="true" className="size-2 fill-current" />
          {copy.connectionLocal}
        </button>
        <button
          type="button"
          onClick={() => navigate("/providers")}
          title={statusLabel}
          className="hidden min-w-0 truncate rounded outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring sm:block"
        >
          {provider?.name ?? copy.noProvider}
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={() => navigate("/providers")}
          title={copy.openProviders}
          className="hidden min-w-0 max-w-55 truncate rounded outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring md:block"
        >
          {modelLabel ?? statusLabel}
        </button>
        <button
          type="button"
          onClick={() => navigate("/desktop")}
          title={copy.desktopSettings}
          aria-label={copy.desktopSettings}
          className="rounded p-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Settings aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </footer>
  );
}
