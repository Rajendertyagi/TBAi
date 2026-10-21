import { describe, expect, it, jest, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

/**
 * The Web server settings section — the user's only way to choose the port.
 *
 * The section has to be honest about three different things, and the backend
 * cannot enforce any of them:
 *
 *   - the **configured** port (what the next boot will use),
 *   - the **active** port (where the server is listening right now), and
 *   - the **cross-origin** consequence of the two differing.
 *
 * The last one is why this file exists as a DOM test and not only as an
 * integration test: the browser-mode restart navigates the page to the new
 * origin, and the Tauri-mode restart keeps the page where it is and moves
 * the API base URL instead. Those are two different flows, and the one that
 * breaks silently is the one nobody clicks.
 */

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const recorded: Recorded[] = [];
let identity: {
  activePort: number;
  configuredPort: number;
  persistedPort: number | null;
  envLocked: boolean;
} = { activePort: 3000, configuredPort: 3000, persistedPort: null, envLocked: false };
let checkResult: { port: number; available: boolean; reason?: string } = {
  port: 3030,
  available: true,
};
let updatedPort: number | null = null;
let probedOrigins: string[] = [];
let probeStatus = 200;
/** Whether the app believes it runs inside the desktop shell. */
let inTauri = true;
/** The URL the page was navigated to, if the component navigated. */
let navigatedTo: string | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

mock.module("@web/lib/platform.ts", () => ({
  apiFetch: async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" && init.body.length > 0
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    recorded.push({ method, path: input, body });
    if (input === "/api/server") return json(identity);
    if (input === "/api/server/port") return json({ configuredPort: identity.configuredPort });
    if (input === "/api/server/check-port") return json(checkResult);
    if (input === "/api/server/restart") {
      return json({ activePort: checkResult.port, restarted: true });
    }
    return json({ error: "unhandled" }, 404);
  },
  isTauri: () => inTauri,
  updateVerifiedPort: async (port: number): Promise<void> => {
    updatedPort = port;
  },
}));

const { ServerSection } = await import("@web/features/desktop/ServerSection.tsx");

/**
 * Mounts the section and lets its first identity read settle.
 *
 * The read happens in an effect, so the render alone leaves the section
 * showing "Reading server state…" — and every contract below is about what it
 * shows once it knows who the server is.
 */
async function mount(): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ServerSection />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { root, container };
}

/** The port input, by its accessible name. */
function portInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Web server port"]');
  if (!input) throw new Error("the port input is not rendered");
  return input;
}

/** A button by its visible label. */
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found;
}

/**
 * Types into a controlled React input.
 *
 * React tracks the input's value, so assigning `input.value` directly is
 * swallowed: the change event fires with the tracked value, not the new one.
 * Going through the prototype's native setter is what makes React see it.
 */
function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // Let the component's awaits settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the Web server settings section", () => {
  it("locks the port when the environment owns it", async () => {
    identity = {
      activePort: 45999,
      configuredPort: 45999,
      persistedPort: null,
      envLocked: true,
    };
    const { root, container } = await mount();
    try {
      expect(portInput(container).disabled).toBe(true);
      expect(container.textContent).toContain("PORT");
      // And no save/restart control is offered for a locked port.
      expect(container.querySelector('button[aria-label="Save"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      identity = { activePort: 3000, configuredPort: 3000, persistedPort: null, envLocked: false };
    }
  });

  it("saves a new port without restarting the server", async () => {
    recorded.length = 0;
    const { root, container } = await mount();
    try {
      typeInto(portInput(container), "3030");
      await click(button(container, "Save"));

      const save = recorded.find((call) => call.path === "/api/server/port");
      expect(save?.method).toBe("PUT");
      expect(save?.body).toEqual({ port: 3030 });
      // Saving is not applying: the restart is a separate, explicit act.
      expect(recorded.some((call) => call.path === "/api/server/restart")).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("reports an occupied port instead of claiming the port is free", async () => {
    recorded.length = 0;
    checkResult = { port: 3030, available: false, reason: "in_use" };
    const { root, container } = await mount();
    try {
      typeInto(portInput(container), "3030");
      await click(button(container, "Test"));

      expect(container.textContent).toContain("already in use");
      // The restart button only appears for a port that differs from the live
      // one; the check itself is what tells the user the port is taken.
      expect(recorded.some((call) => call.path === "/api/server/check-port")).toBe(true);
    } finally {
      act(() => root.unmount());
      checkResult = { port: 3030, available: true };
    }
  });

  it("restarts onto the new port and moves the API base URL, keeping the page where it is", async () => {
    recorded.length = 0;
    updatedPort = null;
    probedOrigins = [];
    probeStatus = 200;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      probedOrigins.push(url);
      return new Response("ok", { status: probeStatus });
    }) as typeof fetch;

    const { root, container } = await mount();
    try {
      typeInto(portInput(container), "3030");
      await click(button(container, "Restart to apply"));

      // The new origin is asked whether it is up — that request is
      // cross-origin from the page that is still on the old one, which is why
      // the server has to trust the origin it replaced.
      expect(probedOrigins.some((url) => url.includes(":3030"))).toBe(true);
      // The restart happened.
      expect(recorded.some((call) => call.path === "/api/server/restart")).toBe(true);
      // In the desktop shell the page does NOT navigate: the API base URL
      // moves, and the app keeps its place.
      expect(updatedPort).toBe(3030);
    } finally {
      act(() => root.unmount());
      globalThis.fetch = realFetch;
    }
  });

  it("reports a restart that never came up, instead of claiming success", async () => {
    recorded.length = 0;
    updatedPort = null;
    probedOrigins = [];
    probeStatus = 503;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      probedOrigins.push(url);
      return new Response("nope", { status: probeStatus });
    }) as typeof fetch;

    const { root, container } = await mount();
    // The readiness probe retries until its deadline, so the clock is faked:
    // the test must not spend fifteen seconds proving that a dead port is
    // reported.
    jest.useFakeTimers();
    try {
      typeInto(portInput(container), "3030");
      await act(async () => {
        button(container, "Restart to apply").dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
        jest.advanceTimersByTime(0);
      });
      await act(async () => {
        jest.advanceTimersByTime(20_000);
        await Promise.resolve();
      });

      // The failure is surfaced, and the API base URL is NOT moved.
      expect(container.textContent).toContain("did not answer on port 3030");
      expect(updatedPort).toBeNull();
    } finally {
      jest.useRealTimers();
      act(() => root.unmount());
      globalThis.fetch = realFetch;
      probeStatus = 200;
    }
  });

  it("navigates to the new origin in a browser, keeping the path and the hash", async () => {
    // The browser-mode flow is the other half of the same restart: there is no
    // desktop shell to move the API base URL, so the page itself navigates to
    // the new origin — and it has to keep the conversation it was showing.
    recorded.length = 0;
    updatedPort = null;
    navigatedTo = null;
    probedOrigins = [];
    probeStatus = 200;
    inTauri = false;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      probedOrigins.push(url);
      return new Response("ok", { status: probeStatus });
    }) as typeof fetch;

    const { root, container } = await mount();
    // A browser-mode page navigates by assigning `window.location.href`.
    // happy-dom does not perform navigations, so the assignment is observed
    // through a stub that records the target instead.
    const realLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        protocol: "http:",
        hostname: "localhost",
        port: "3000",
        pathname: "/chat/abc",
        search: "?q=1",
        hash: "#thread-1",
        get href(): string {
          return "http://localhost:3000/chat/abc?q=1#thread-1";
        },
        set href(value: string) {
          navigatedTo = value;
        },
      },
    });
    try {
      typeInto(portInput(container), "3030");
      await click(button(container, "Restart to apply"));

      // The new origin was asked whether it is up, and the page is expected to
      // go there.
      expect(probedOrigins.some((url) => url.includes(":3030"))).toBe(true);
      expect(navigatedTo).not.toBeNull();
      expect(navigatedTo).toContain(":3030");
      // And the conversation the user was on survives the move.
      expect(navigatedTo).toContain("/chat/abc");
      expect(navigatedTo).toContain("#thread-1");
      // A browser has no desktop shell, so no API base URL is moved.
      expect(updatedPort).toBeNull();
    } finally {
      act(() => root.unmount());
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: realLocation,
      });
      globalThis.fetch = realFetch;
      inTauri = true;
    }
  });
});
