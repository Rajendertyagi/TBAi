import { afterEach, describe, expect, it } from "bun:test";
import {
  installManagedTarget,
  readBackendInstanceId,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";

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
    expect(await response.json()).toEqual({
      mode: "unresolved",
      backendInstanceId: readBackendInstanceId(),
      targetRevision: 0,
      targetId: null,
    });
  });

  it("reports a managed service without internals", async () => {
    const targetId = installManagedTarget({
      baseUrl: "http://127.0.0.1:4096",
      password: getOpenCodeAuthPassword(),
    });
    const response = await readStatus();
    expect(await response.json()).toEqual({
      mode: "managed",
      backendInstanceId: readBackendInstanceId(),
      targetRevision: 1,
      targetId,
    });
  });
});
