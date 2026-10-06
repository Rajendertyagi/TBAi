import { Toaster } from "sonner";

import { useTheme } from "./theme-provider";

/**
 * The app's toast host.
 *
 * This exists only to give sonner the app's theme. Sonner defaults to
 * `theme="system"`, but TBAi's light/dark choice is an explicit, persisted
 * decision (`theme-provider.tsx`) that can disagree with the OS, so the default
 * would light the toasts against a dark app or vice versa.
 *
 * The glass surface itself is not set here: sonner's stylesheet is entirely
 * wrapped in `:where()` (zero specificity), so `globals.css` configures it
 * through sonner's own custom properties instead of fighting it from JS.
 */
export function AppToaster() {
  const { theme } = useTheme();

  return <Toaster theme={theme} />;
}