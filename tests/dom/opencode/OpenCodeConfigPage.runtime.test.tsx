import { beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as realConfig from "@web/features/opencode/openCodeConfig.ts";
import { openCodeConfigCopy } from "@web/features/opencode/configCopy.ts";
import type { OpenCodeRuntimeStatus } from "@web/features/opencode/runtimeStatus.ts";

const BASE_SNAPSHOT = {
  path: "C:/cfg/opencode.json",
  discoveredPaths: ["C:/cfg/opencode.json"],
  raw: "{}",
  malformed: false,
  editable: true,
  writeDisabledReason: null as null | "managed_root_not_owned",
  permissions: [{ action: "shell", resource: "*", effect: "ask" }] as readonly unknown[],
};

let snapshot = { ...BASE_SNAPSHOT, permissions: [...BASE_SNAPSHOT.permissions] };
let configReads = 0;

mock.module("@web/features/opencode/openCodeConfig.ts", () => ({
  ...realConfig,
  fetchOpenCodeConfig: async () => {
    configReads += 1;
    return { ...snapshot, permissions: [...(snapshot.permissions ?? [])] };
  },
}));

let runtimeStatus: OpenCodeRuntimeStatus | null = null;

mock.module("@web/features/opencode/useOpenCodeRuntimeStatus.ts", () => ({
  useOpenCodeRuntimeStatus: () => ({ status: runtimeStatus, error: null }),
}));

const { OpenCodeConfigPage } = await import("@web/features/opencode/OpenCodeConfigPage.tsx");

const BID = "backend-instance";

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

function alertText(container: HTMLElement): string {
  return [...container.querySelectorAll("[role='alert']")]
    .map((node) => node.textContent ?? "")
    .join(" ");
}

describe("OpenCode config page (managed-only runtime)", () => {
  beforeEach(() => {
    configReads = 0;
    snapshot = { ...BASE_SNAPSHOT, permissions: [...BASE_SNAPSHOT.permissions] };
  });

  it("loads normally for a managed service", async () => {
    runtimeStatus = { mode: "managed", backendInstanceId: BID, targetRevision: 1, targetId: 1 };
    const mounted = await mount();
    expect(alertText(mounted.container)).not.toContain(openCodeConfigCopy.unavailable.managed);
    expect(mounted.container.textContent).toContain("Native OpenCode JSON");
    expect(configReads).toBe(1);
    unmount(mounted);
  });

  it("loads normally when the status is unknown", async () => {
    runtimeStatus = null;
    const mounted = await mount();
    expect(mounted.container.textContent).toContain("Native OpenCode JSON");
    unmount(mounted);
  });

  it("renders a readable snapshot and shows managed-root-not-owned write refusal", async () => {
    runtimeStatus = { mode: "managed", backendInstanceId: BID, targetRevision: 1, targetId: 1 };
    snapshot = {
      path: "C:/cfg/opencode.jsonc",
      discoveredPaths: ["C:/cfg/opencode.jsonc"],
      raw: '{\n  "shell": "powershell"\n}\n',
      malformed: false,
      editable: false,
      writeDisabledReason: "managed_root_not_owned",
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    };
    const mounted = await mount();
    const text = mounted.container.textContent ?? "";
    expect(text).not.toContain(openCodeConfigCopy.states.malformed);
    expect(text).toContain("Native OpenCode JSON");
    expect(text).toContain(openCodeConfigCopy.json.normalized);
    expect(text).toContain(openCodeConfigCopy.states.writesDisabled.managed_root_not_owned);
    unmount(mounted);
  });
});
