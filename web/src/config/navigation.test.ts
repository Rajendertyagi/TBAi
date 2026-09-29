import { describe, expect, it } from "bun:test";
import { getSettingsNav, appConfig } from "@/config/navigation";

/**
 * Guard: every settings ROUTE must have a settings NAV entry, and every nav
 * entry must have a route.
 *
 * ## The bug this exists to stop
 *
 * The OpenCode Configuration page shipped working — the route rendered, the API
 * answered, the permission table showed the real rules — and was completely
 * invisible in the UI, because the nav item's `view` was not in `SETTINGS_VIEWS`
 * and `getSettingsNav()` filters on it. Direct URL worked; nothing in the app
 * linked to it, so a user following any normal path saw a page that did not
 * exist.
 *
 * That is the whole failure mode of this file's contract: navigation and
 * routing are separate lists that must agree, and nothing in the type system
 * connects them. A `ViewId` compiles perfectly well while being absent from the
 * allowlist, so the check has to be an explicit test.
 *
 * The router side is asserted by reading the route table source, because the
 * router is a module-level `createHashRouter` call that cannot be introspected
 * at runtime without mounting a router.
 */

const SETTINGS_ROUTES = [
  "/memory",
  "/mcp",
  "/logs",
  "/folders",
  "/quick-messages",
  "/providers",
  "/appearance",
  "/desktop",
  "/workspace",
  "/opencode-config",
];

describe("settings navigation", () => {
  it("gives every settings route a nav entry", () => {
    const routes = new Set(getSettingsNav().map((item) => item.route));
    const missing = SETTINGS_ROUTES.filter((route) => !routes.has(route));
    expect(missing).toEqual([]);
  });

  it("points every settings nav entry at a real settings route", () => {
    const known = new Set(SETTINGS_ROUTES);
    const orphans = getSettingsNav()
      .map((item) => item.route)
      .filter((route) => !known.has(route));
    expect(orphans).toEqual([]);
  });

  it("exposes the OpenCode Configuration entry", () => {
    // Named explicitly, not just counted: this is the entry whose absence was
    // the reported bug, and a count assertion would still pass with a different
    // item missing.
    const entry = getSettingsNav().find((item) => item.route === "/opencode-config");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("OpenCode Config");
  });

  it("gives every settings entry a unique route", () => {
    // A duplicate would make one page unreachable through the nav, which is the
    // same symptom as a missing entry and is just as invisible.
    const routes = getSettingsNav().map((item) => item.route);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("keeps every settings entry out of the icon rail", () => {
    // Settings-area items live in the settings sub-sidebar only. One leaking
    // onto the rail is a layout regression, and the rail has no room for it.
    for (const item of getSettingsNav()) {
      expect(item.railVisible).toBe(false);
    }
  });

  it("registers the OpenCode Configuration route in the router", () => {
    // The nav half cannot prove the route exists — a nav entry pointing at a
    // route nobody registered is the mirror image of the original bug, so the
    // router source is read directly.
    return Bun.file(new URL("../app/router.tsx", import.meta.url)).text().then((source) => {
      expect(source).toContain('path: "opencode-config"');
      expect(source).toContain("OpenCodeConfigPage");
    });
  });

  it("keeps every nav item's view a known ViewId", () => {
    // A typo'd view string compiles (it is a plain string in a const array) and
    // silently drops the item out of the settings nav.
    const known = new Set<string>([
      "chat",
      "settings",
      "memories",
      "search",
      "mcp",
      "logs",
      "scheduler",
      "archived",
      "workspace",
      "opencode-config",
      "folders",
      "quick-messages",
      "providers",
      "appearance",
      "desktop",
    ]);
    for (const item of appConfig.nav) {
      expect(known.has(item.view)).toBe(true);
    }
  });
});
