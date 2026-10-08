/**
 * Root hydrate fallback rendered by React Router during initial hydration
 * while lazy route modules are loading.
 */
export function HydrateFallback() {
  return (
    <div
      data-testid="hydrate-fallback"
      className="flex h-screen w-screen items-center justify-center bg-background text-foreground"
    />
  );
}
