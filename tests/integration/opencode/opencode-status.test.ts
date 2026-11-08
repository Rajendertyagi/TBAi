import { afterEach, describe, expect, it } from "bun:test";
import {
  installAdoptedTarget,
  installManagedTarget,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import type { OpenCodeServiceCapabilities } from "@/services/opencode/compatibility.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";

/**
 * `GET /api/opencode/status` — the stable status the UI renders (§4.2).
 *
 * The route reads the installed target and never resolves one, so a status
 * poll can neither start a managed child nor contact an adopted service. The
 * payload carries no origin, password or registration path.
 */

const CAPABILITIES: OpenCodeServiceCapabilities = {
  version: "2.2.0",
  supported: {
    session: true,
    events: true,
    config: false,
    agent: true,
    model: true,
    command: true,
  },
};

const { default: openCodeApp } = await import("@/routes/opencode.ts");

afterEach(() => {
  resetConnectionStateForTests();
});

async function readStatus(): Promise<Response> {
  return await openCodeApp.request("http://localhost/status");
}

describe("GET /api/opencode/status", () => {
  it("reports unresolved when nothing is installed", async () => {
    const response = await readStatus();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: "unresolved" });
  });

  it("reports a managed service without internals", async () => {
    installManagedTarget({ baseUrl: "http://127.0.0.1:4096", password: getOpenCodeAuthPassword() });
    const response = await readStatus();
    expect(await response.json()).toEqual({ mode: "managed" });
  });

  it("reports an adopted service and its capability snapshot", async () => {
    installAdoptedTarget({
      origin: "http://127.0.0.1:5055",
      password: "synthetic-adopted-password",
      capabilities: CAPABILITIES,
    });
    const response = await readStatus();
    expect(await response.json()).toEqual({ mode: "adopted", capabilities: CAPABILITIES });
  });
});
