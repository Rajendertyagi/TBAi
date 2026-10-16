import { Navigate } from "react-router";
import { ROUTES } from "../config/navigation";

/**
 * Landing route (`/`): codeg-style, there is no dashboard — go straight to
 * work. Declaratively redirects to the active tab (or a fresh chat when
 * nothing is open). Uses `<Navigate>` instead of an imperative `navigate()`
 * effect — the library owns when the redirect fires.
 *
 * Note: the active tab is read from the store's initial state (set up during
 * module initialization by `loadPersisted`). This is sufficient because the
 * index route only renders once on first load; subsequent tab changes are
 * handled by `TabUrlSync`.
 */
export function IndexRedirect() {
  const initialTab = ROUTES.CHAT_NEW;
  return <Navigate to={initialTab} replace />;
}
