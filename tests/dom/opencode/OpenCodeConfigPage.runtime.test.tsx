/**
 * The configuration page on an adopted service that has no configuration route.
 *
 * ## What this pins (B7)
 *
 * Adoption admits an officially released stable service that lacks an OPTIONAL
 * route. `config` is the first such route, and this page is the surface backed
 * by it. When the probe positively reported that route missing, the page must
 * say what is absent — not present a failed read as if the reader's file were
 * broken, and not offer a Save control that cannot work.
 *
 * A snapshot that is UNKNOWN (no status, or an adopted target whose snapshot
 * was never taken) must not degrade the page: hiding a working control is worse
 * than showing one that reports a clear refusal.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as realConfig from "@web/features/opencode/openCodeConfig.ts";
import { openCodeConfigCopy } from "@web/features/opencode/configCopy.ts";
import type { OpenCodeRuntimeStatus } from "@web/features/opencode/runtimeStatus.ts";

const SNAPSHOT = {
  path: "C:/cfg/opencode.json",
  discoveredPaths: ["C:/cfg/opencode.json"],
  raw: "{}",
  malformed: false,
  editable: true,
  permissions: [{ action: "shell", resource: "*", effect: "ask" }],
} as const;

/** How many times the page asked for the configuration. */
let configReads = 0;

mock.module("@web/features/opencode/openCodeConfig.ts", () => ({
  ...realConfig,
  fetchOpenCodeConfig: async () => {
    configReads += 1;
    return { ...SNAPSHOT, permissions: [...SNAPSHOT.permissions] };
  },
}));

/** The mode the mocked status read reports. */
let runtimeStatus: OpenCodeRuntimeStatus | null = null;

mock.module("@web/features/opencode/useOpenCodeRuntimeStatus.ts", () => ({
  useOpenCodeRuntimeStatus: () => ({ status: runtimeStatus, error: null }),
}));

const { OpenCodeConfigPage } = await import("@web/features/opencode/OpenCodeConfigPage.tsx");

const ADOPTED_WITHOUT_CONFIG: OpenCodeRuntimeStatus = {
  mode: "adopted",
  capabilities: {
    version: "2.3.1",
    supported: {
      session: true,
      events: true,
      config: false,
      agent: true,
      model: true,
      command: true,
    },
  },
};

const ADOPTED_WITH_CONFIG: OpenCodeRuntimeStatus = {
  mode: "adopted",
  capabilities: {
    version: "2.3.1",
    supported: {
      session: true,
      events: true,
      config: true,
      agent: true,
      model: true,
      command: true,
    },
  },
};

async function mount(): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<OpenCodeConfigPage />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { root, container };
}

function unmount(mounted: { root: Root; container: HTMLElement }): void {
  act(() => {
    mounted.root.unmount();
  });
  mounted.container.remove();
}

/** The page's alert text, joined. */
function alertText(container: HTMLElement): string {
  return [...container.querySelectorAll("[role='alert']")]
    .map((node) => node.textContent ?? "")
    .join(" ");
}

describe("the configuration page on a degraded adopted service", () => {
  beforeEach(() => {
    configReads = 0;
  });

  it("says the route is absent instead of reporting a broken file", async () => {
    runtimeStatus = ADOPTED_WITHOUT_CONFIG;
    configReads = 0;
    const mounted = await mount();
    expect(alertText(mounted.container)).toContain(openCodeConfigCopy.unavailable.adopted);
    // No section rendered: there is no snapshot to show, and nothing to save.
    expect(mounted.container.textContent).not.toContain("Native OpenCode JSON");
    expect(mounted.container.textContent).not.toContain(openCodeConfigCopy.states.error);
    expect(configReads).toBe(0);
    unmount(mounted);
  });

  it("loads normally when the adopted service does serve the route", async () => {
    runtimeStatus = ADOPTED_WITH_CONFIG;
    const mounted = await mount();
    expect(alertText(mounted.container)).not.toContain(openCodeConfigCopy.unavailable.adopted);
    expect(mounted.container.textContent).toContain("Native OpenCode JSON");
    unmount(mounted);
  });

  it("loads normally for a managed service (nothing was assessed)", async () => {
    runtimeStatus = { mode: "managed" };
    const mounted = await mount();
    expect(alertText(mounted.container)).not.toContain(openCodeConfigCopy.unavailable.adopted);
    expect(mounted.container.textContent).toContain("Native OpenCode JSON");
    unmount(mounted);
  });

  it("loads normally when the status is unknown", async () => {
    runtimeStatus = null;
    const mounted = await mount();
    expect(alertText(mounted.container)).not.toContain(openCodeConfigCopy.unavailable.adopted);
    expect(mounted.container.textContent).toContain("Native OpenCode JSON");
    unmount(mounted);
  });
});
