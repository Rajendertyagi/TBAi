import { afterEach, describe, expect, it } from "bun:test";
import {
  installManagedTarget,
  OpenCodeNotReadyError,
  readBackendInstanceId,
  resetConnectionStateForTests,
  setShutdownStateReaderForTests,
} from "@/services/opencode/connectionState.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";
import {
  describeOpenCodeRuntime,
  resolveOpenCodeRuntimeTarget,
} from "@/services/opencode/runtimeTarget.ts";

const MANAGED_URL = "http://127.0.0.1:4096";

const originalFetch = globalThis.fetch;
const capturedHeaders: Headers[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  capturedHeaders.length = 0;
  setShutdownStateReaderForTests(null);
  resetConnectionStateForTests();
});

function captureFetch(): void {
  const stub = async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    capturedHeaders.push(new Headers(init?.headers));
    return Response.json({ ok: true });
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  }) as typeof fetch;
}

function decodedCredential(index = 0): string {
  const header = capturedHeaders[index]?.get("authorization") ?? "";
  expect(header.startsWith("Basic ")).toBe(true);
  return Buffer.from(header.slice("Basic ".length), "base64").toString();
}

describe("resolveOpenCodeRuntimeTarget", () => {
  it("starts the managed child when nothing is installed", async () => {
    const target = await resolveOpenCodeRuntimeTarget({
      ensureManaged: async () => MANAGED_URL,
    });

    expect(target.mode).toBe("managed");
    expect(target.baseUrl).toBe(MANAGED_URL);
    expect(target.capabilities).toBeNull();
    captureFetch();
    await target.transport(`${MANAGED_URL}/api/info`, { method: "GET" });
    expect(decodedCredential()).toBe(`opencode:${getOpenCodeAuthPassword()}`);
  });

  it("uses an installed managed target without starting anything", async () => {
    installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
    let starts = 0;
    const target = await resolveOpenCodeRuntimeTarget({
      ensureManaged: async () => {
        starts += 1;
        return MANAGED_URL;
      },
    });

    expect(starts).toBe(0);
    expect(target.mode).toBe("managed");
    expect(target.transport).toBeDefined();
    expect(target.capabilities).toBeNull();
  });

  it("prefers a managed target installed while the managed start was in flight", async () => {
    const target = await resolveOpenCodeRuntimeTarget({
      ensureManaged: async () => {
        installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
        return MANAGED_URL;
      },
    });

    expect(target.mode).toBe("managed");
    expect(target.baseUrl).toBe(MANAGED_URL);
  });

  it("refuses after shutdown", async () => {
    setShutdownStateReaderForTests(() => ({ shutdownEpoch: 1, shutdownStarted: true }));
    await expect(
      resolveOpenCodeRuntimeTarget({ ensureManaged: async () => MANAGED_URL }),
    ).rejects.toBeInstanceOf(OpenCodeNotReadyError);
  });
});

describe("describeOpenCodeRuntime", () => {
  it("reports unresolved with no target", () => {
    expect(describeOpenCodeRuntime()).toEqual({
      mode: "unresolved",
      backendInstanceId: readBackendInstanceId(),
      targetRevision: 0,
      targetId: null,
    });
  });

  it("reports managed", () => {
    const targetId = installManagedTarget({
      baseUrl: MANAGED_URL,
      password: getOpenCodeAuthPassword(),
    });
    expect(describeOpenCodeRuntime()).toEqual({
      mode: "managed",
      backendInstanceId: readBackendInstanceId(),
      targetRevision: 1,
      targetId,
    });
  });

  it("reports unresolved after shutdown", () => {
    installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
    setShutdownStateReaderForTests(() => ({ shutdownEpoch: 1, shutdownStarted: true }));
    expect(describeOpenCodeRuntime()).toEqual({
      mode: "unresolved",
      backendInstanceId: readBackendInstanceId(),
      targetRevision: 1,
      targetId: null,
    });
  });
});
