import { afterEach, describe, expect, it } from "bun:test";
import {
  installAdoptedTarget,
  installManagedTarget,
  OpenCodeNotReadyError,
  resetConnectionStateForTests,
  setShutdownStateReaderForTests,
} from "@/services/opencode/connectionState.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";
import {
  describeOpenCodeRuntime,
  resolveOpenCodeRuntimeTarget,
} from "@/services/opencode/runtimeTarget.ts";
import type { OpenCodeServiceCapabilities } from "@/services/opencode/compatibility.ts";

/**
 * The server-wide target resolver (Phase H wiring).
 *
 * Two properties matter, and both are about which credential can reach which
 * origin:
 *
 *  - an installed ADOPTED target is used with the adopted service's own
 *    password, never the managed one (§1.9.3, D4);
 *  - an unresolved target starts the managed child, and a target installed
 *    while that start was in flight still wins.
 */

const MANAGED_URL = "http://127.0.0.1:4096";
const ADOPTED_ORIGIN = "http://127.0.0.1:5055";
const ADOPTED_PASSWORD = "synthetic-adopted-password";

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

const originalFetch = globalThis.fetch;
const capturedHeaders: Headers[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  capturedHeaders.length = 0;
  setShutdownStateReaderForTests(null);
  resetConnectionStateForTests();
});

/** Stubs fetch so a transport call can be inspected without a server. */
function captureFetch(): void {
  const stub = async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    capturedHeaders.push(new Headers(init?.headers));
    return Response.json({ ok: true });
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  }) as typeof fetch;
}

/** The decoded HTTP Basic credential a captured request carried. */
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
    // The fallback is a REAL transport, bound to the managed origin and
    // carrying the managed credential. There is no header record to misuse.
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

  it("sends the adopted service's own credential to the adopted origin", async () => {
    installAdoptedTarget({
      origin: ADOPTED_ORIGIN,
      password: ADOPTED_PASSWORD,
      capabilities: CAPABILITIES,
    });
    const target = await resolveOpenCodeRuntimeTarget();

    expect(target.mode).toBe("adopted");
    expect(target.baseUrl).toBe(ADOPTED_ORIGIN);
    expect(target.capabilities).toEqual(CAPABILITIES);

    captureFetch();
    const transport = target.transport;
    if (!transport) throw new Error("an installed target must publish a transport");
    await transport(`${ADOPTED_ORIGIN}/api/info`, { method: "GET" });
    expect(decodedCredential()).toBe(`opencode:${ADOPTED_PASSWORD}`);
  });

  it("refuses to send the adopted credential to another origin", async () => {
    installAdoptedTarget({ origin: ADOPTED_ORIGIN, password: ADOPTED_PASSWORD });
    const target = await resolveOpenCodeRuntimeTarget();
    const transport = target.transport;
    if (!transport) throw new Error("an installed target must publish a transport");
    captureFetch();

    await expect(transport("http://127.0.0.1:6000/api/info")).rejects.toThrow();
    expect(capturedHeaders).toHaveLength(0);
  });

  it("prefers a target installed while the managed start was in flight", async () => {
    const target = await resolveOpenCodeRuntimeTarget({
      ensureManaged: async () => {
        installAdoptedTarget({ origin: ADOPTED_ORIGIN, password: ADOPTED_PASSWORD });
        return MANAGED_URL;
      },
    });

    // The managed start happened, but the adopted target is what got installed,
    // so the adopted service owns the runtime.
    expect(target.mode).toBe("adopted");
    expect(target.baseUrl).toBe(ADOPTED_ORIGIN);
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
    expect(describeOpenCodeRuntime()).toEqual({ mode: "unresolved" });
  });

  it("reports managed without a capability snapshot", () => {
    installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
    expect(describeOpenCodeRuntime()).toEqual({ mode: "managed" });
  });

  it("reports the adopted capability snapshot", () => {
    installAdoptedTarget({
      origin: ADOPTED_ORIGIN,
      password: ADOPTED_PASSWORD,
      capabilities: CAPABILITIES,
    });
    expect(describeOpenCodeRuntime()).toEqual({ mode: "adopted", capabilities: CAPABILITIES });
  });

  it("never reports the origin, the password or the registration path", () => {
    installAdoptedTarget({ origin: ADOPTED_ORIGIN, password: ADOPTED_PASSWORD });
    const serialized = JSON.stringify(describeOpenCodeRuntime());
    expect(serialized).not.toContain(ADOPTED_ORIGIN);
    expect(serialized).not.toContain(ADOPTED_PASSWORD);
  });

  it("reports unresolved after shutdown", () => {
    installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
    setShutdownStateReaderForTests(() => ({ shutdownEpoch: 1, shutdownStarted: true }));
    expect(describeOpenCodeRuntime()).toEqual({ mode: "unresolved" });
  });
});
