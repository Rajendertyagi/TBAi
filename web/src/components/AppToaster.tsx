import type { CSSProperties } from "react";
import { Toaster } from "sonner";

import { useTheme } from "./theme-provider";

/**
 * The app's toast host.
 *
 * `theme` exists only because TBAi's light/dark choice is an explicit, persisted
 * decision (`theme-provider.tsx`) that can disagree with the OS, so sonner's
 * `theme="system"` default would light the toasts against a dark app.
 *
 * The glass surface is set through sonner's documented `toastOptions.style`,
 * which sonner applies as an inline style on every toast. That is deliberate:
 * sonner 2 removed the `:where()` wrappers that used to keep its stylesheet at
 * zero specificity, and injects that stylesheet after the app CSS, so overriding
 * it from `globals.css` no longer wins — measured, not assumed. Inline styles do
 * not compete on specificity. Sonner's own `--normal-*` variables are left alone:
 * it also uses `--normal-bg` for the close button.
 *
 * The two custom properties only carry the reduced-transparency branch, because
 * an inline style cannot contain a media query. See `styles/globals.css`.
 */
const TOAST_SURFACE: CSSProperties = {
  backgroundColor: "var(--tbai-toast-surface)",
  borderColor: "transparent",
  backdropFilter: "var(--tbai-toast-backdrop)",
  WebkitBackdropFilter: "var(--tbai-toast-backdrop)",
  boxShadow: "var(--elevation-floating)",
  borderRadius: "calc(var(--radius) * 1.2)",
};

export function AppToaster() {
  const { theme } = useTheme();

  return <Toaster theme={theme} toastOptions={{ style: TOAST_SURFACE }} />;
}
