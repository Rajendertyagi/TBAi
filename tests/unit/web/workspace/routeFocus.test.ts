/**
 * Pure route ↔ canonical-panel-key mapping for the Phase E focus controller.
 * Covers plan §6 tests 15 (deep links) at the pure-function level; the DOM
 * suite drives the same mapping through the real controller.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  clearValidationRedirects,
  isChatSurfacePath,
  isUserFocus,
  isValidationRedirecting,
  markValidationRedirect,
  routeSurfaceClass,
  tabKeyForPath,
  workspaceSurfaceClass,
} from "@web/features/workspace/routeFocus";

describe("tabKeyForPath — deep-link mapping (plan §6 test 15)", () => {
  it("maps /chat/new to the single draft panel key", () => {
    expect(tabKeyForPath("/chat/new")).toBe("chat:new");
  });

  it("maps /chat/:id to the canonical chat key", () => {
    expect(tabKeyForPath("/chat/abc123")).toBe("chat:abc123");
  });

  it("decodes an encoded conversation id", () => {
    expect(tabKeyForPath("/chat/a%2Fb")).toBe("chat:a/b");
  });

  it("maps /code/:id to the canonical agent key", () => {
    expect(tabKeyForPath("/code/agent-7")).toBe("agent:agent-7");
  });

  it("returns undefined for non-chat surfaces", () => {
    for (const path of ["/", "/scheduler", "/providers", "/memory", "/archived", "/theme-lab"]) {
      expect(tabKeyForPath(path)).toBeUndefined();
    }
  });

  it("returns undefined for malformed or empty conversation segments", () => {
    for (const path of ["/chat", "/chat/", "/chat/a/b", "/code", "/code/", "/code/a/b"]) {
      expect(tabKeyForPath(path)).toBeUndefined();
    }
  });

  it("returns undefined for malformed percent encoding (never throws)", () => {
    expect(tabKeyForPath("/chat/%E0%A4%A")).toBeUndefined();
  });
});

describe("isChatSurfacePath", () => {
  it("is true only for chat/code routes", () => {
    expect(isChatSurfacePath("/chat/new")).toBe(true);
    expect(isChatSurfacePath("/chat/x")).toBe(true);
    expect(isChatSurfacePath("/code/x")).toBe(true);
    expect(isChatSurfacePath("/scheduler")).toBe(false);
  });
});

describe("isUserFocus — feedback-loop guard", () => {
  it("treats only user-origin focus as URL-authoritative", () => {
    expect(isUserFocus("user")).toBe(true);
    expect(isUserFocus("api")).toBe(false);
  });
});

describe("surface classes — visibility-preserving hide (audit M2)", () => {
  it("never uses display:none for the persistent workspace", () => {
    for (const visible of [true, false]) {
      expect(workspaceSurfaceClass(visible)).not.toContain("hidden");
      expect(workspaceSurfaceClass(visible)).toContain("absolute inset-0");
    }
  });

  it("uses invisible (layout-preserving) when off-route, visible when on-route", () => {
    expect(workspaceSurfaceClass(false)).toContain("invisible");
    expect(workspaceSurfaceClass(false)).toContain("pointer-events-none");
    expect(workspaceSurfaceClass(true)).toContain("visible");
    expect(workspaceSurfaceClass(true)).not.toContain("invisible");
  });

  it("makes the route surface pointer-transparent only on chat surfaces", () => {
    expect(routeSurfaceClass(true)).toContain("pointer-events-none");
    expect(routeSurfaceClass(false)).not.toContain("pointer-events-none");
  });
});

describe("validation redirect authority (audit M3)", () => {
  afterEach(() => clearValidationRedirects());

  it("reports a redirect while the pathname still addresses the stale ref", () => {
    markValidationRedirect("stale-1", "/code/stale-1");
    expect(isValidationRedirecting("stale-1", "/chat/stale-1")).toBe(true);
  });

  it("clears the mark once the pathname reaches the target", () => {
    markValidationRedirect("stale-1", "/code/stale-1");
    expect(isValidationRedirecting("stale-1", "/code/stale-1")).toBe(false);
    expect(isValidationRedirecting("stale-1", "/chat/stale-1")).toBe(false);
  });

  it("is a no-op for an unmarked ref", () => {
    expect(isValidationRedirecting("never-marked", "/chat/never-marked")).toBe(false);
  });
});
