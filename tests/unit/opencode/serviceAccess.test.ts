import { describe, it, expect, beforeEach, afterAll, afterEach } from "bun:test";
import {
  beginShutdown,
  installAdoptedTarget,
  installManagedTarget,
  OpenCodeNotReadyError,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { LOCAL_OWNER, OpenCodeHistoryBoundaryError } from "@/services/opencode/historyBoundary.ts";
import { OpenCodeOriginMismatchError } from "@/services/opencode/http.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";
import { resolveOpenCodeServiceAccess } from "@/services/opencode/serviceAccess.ts";
import { resetLostAdoptedRecoveryForTests } from "@/services/opencode/recovery.ts";

/**
 * The single service resolver for history operations.
 *
 * Contract:
 *  - an installed target decides first;
 *  - loopback endpoints (managed or adopted, any port) belong to the "local" scope;
 *  - an explicit loopback endpoint is isolated as remote scope;
 *  - a remote-bound conversation with no installed target is refused rather
 *    than served by a managed stand-in;
 *  - the managed manager is reached only for an unbound or local conversation;
 *  - local-to-remote mismatch throws cross_service;
 *  - the access carries the transport captured with the target.
 */

type ManagerSeam = { ensureBaseUrl: () => Promise<string> };
const manager = openCodeServerManager as unknown as ManagerSeam;
const originalEnsureBaseUrl = manager.ensureBaseUrl;

let ensureBaseUrlCalls = 0;
let ensureBaseUrlImpl: () => Promise<string>;

beforeEach(() => {
  resetConnectionStateForTests();
  resetLostAdoptedRecoveryForTests();
  ensureBaseUrlCalls = 0;
  ensureBaseUrlImpl = async () => "http://127.0.0.1:4000";
  manager.ensureBaseUrl = async () => {
    ensureBaseUrlCalls += 1;
    return ensureBaseUrlImpl();
  };
});

afterEach(() => {
  resetLostAdoptedRecoveryForTests();
});

afterAll(() => {
  manager.ensureBaseUrl = originalEnsureBaseUrl;
  resetLostAdoptedRecoveryForTests();
  resetConnectionStateForTests();
});

const LOCAL_ADOPTED_A = "http://127.0.0.1:51234";
const LOCAL_ADOPTED_B = "http://127.0.0.1:51235";
const EXPLICIT_LOOPBACK = "http://127.0.0.1:4000";
const REMOTE_A = "https://remote-a.example.com";
const SYNTHETIC_PASSWORD = "synthetic-password";

function managedTarget(): void {
  installManagedTarget({ baseUrl: "http://127.0.0.1:4000", password: "synthetic-managed" });
}

function adoptedTarget(origin: string, profileId?: string): void {
  installAdoptedTarget({ origin, password: SYNTHETIC_PASSWORD, profileId });
}

describe("resolveOpenCodeServiceAccess â€” installed target decides", () => {
  it("returns the local owner and captured transport for loopback adopted target without asking manager", async () => {
    adoptedTarget(LOCAL_ADOPTED_A);

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: "ses_a",
      opencodeServiceOwner: "local",
    });

    expect(access.owner).toEqual(LOCAL_OWNER);
    expect(access.baseUrl).toBe(LOCAL_ADOPTED_A);
    expect(access.transport).toBeDefined();
    expect(ensureBaseUrlCalls).toBe(0);
    expect(Object.isFrozen(access)).toBe(true);
  });

  it("serves legacy managed and legacy loopback adopted owners through local loopback target", async () => {
    adoptedTarget(LOCAL_ADOPTED_A);

    // Legacy 'managed'
    const accessManaged = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: "ses_a",
      opencodeServiceOwner: "managed",
    });
    expect(accessManaged.owner).toEqual(LOCAL_OWNER);

    // Legacy 'adopted:http://127.0.0.1:51235' (different port, but loopback)
    const accessAdoptedOtherPort = await resolveOpenCodeServiceAccess({
      id: "conv-2",
      opencodeSessionId: "ses_b",
      opencodeServiceOwner: `adopted:${LOCAL_ADOPTED_B}`,
    });
    expect(accessAdoptedOtherPort.owner).toEqual(LOCAL_OWNER);
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("isolates explicit loopback target from local conversations", async () => {
    adoptedTarget(EXPLICIT_LOOPBACK, `explicit:${EXPLICIT_LOOPBACK}`);

    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: "local",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("cross_service");
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("serves explicit loopback conversation through matching explicit loopback target", async () => {
    adoptedTarget(EXPLICIT_LOOPBACK, `explicit:${EXPLICIT_LOOPBACK}`);

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: "ses_a",
      opencodeServiceOwner: `remote:${EXPLICIT_LOOPBACK}`,
    });

    expect(access.owner).toEqual({
      kind: "remote",
      origin: EXPLICIT_LOOPBACK,
      profileId: `explicit:${EXPLICIT_LOOPBACK}`,
    });
    expect(access.baseUrl).toBe(EXPLICIT_LOOPBACK);
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("binds the transport to the captured origin, so it cannot be re-pointed", async () => {
    adoptedTarget(LOCAL_ADOPTED_A);
    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    await expect(access.transport?.(`${LOCAL_ADOPTED_B}/api/session`)).rejects.toBeInstanceOf(
      OpenCodeOriginMismatchError,
    );
  });

  it("allows an unbound conversation to bind on the installed adopted service", async () => {
    adoptedTarget(LOCAL_ADOPTED_A);

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    expect(access.owner).toEqual(LOCAL_OWNER);
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("refuses a remote binding while a local adopted target is installed", async () => {
    adoptedTarget(LOCAL_ADOPTED_A);

    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: `remote:${REMOTE_A}`,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("cross_service");
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("refuses a remote binding while a local managed target is installed", async () => {
    managedTarget();

    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: `remote:${REMOTE_A}`,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("cross_service");
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("serves a local binding from an installed managed target", async () => {
    managedTarget();

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: "ses_a",
      opencodeServiceOwner: "local",
    });

    expect(access.owner).toEqual(LOCAL_OWNER);
    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    expect(access.transport).toBeDefined();
    expect(ensureBaseUrlCalls).toBe(0);
  });
});

describe("resolveOpenCodeServiceAccess â€” nothing installed", () => {
  it("refuses a remote binding instead of starting a managed stand-in", async () => {
    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: `remote:${REMOTE_A}`,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("adopted_unavailable");
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("starts the managed service for an unbound conversation and publishes it", async () => {
    ensureBaseUrlImpl = async () => {
      installManagedTarget({ baseUrl: "http://127.0.0.1:4000", password: "synthetic-managed" });
      return "http://127.0.0.1:4000";
    };

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    expect(access.owner).toEqual(LOCAL_OWNER);
    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    expect(access.transport).toBeDefined();
    expect(ensureBaseUrlCalls).toBe(1);
  });

  it("starts the managed service for a local binding", async () => {
    ensureBaseUrlImpl = async () => {
      installManagedTarget({ baseUrl: "http://127.0.0.1:4000", password: "synthetic-managed" });
      return "http://127.0.0.1:4000";
    };

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: "ses_a",
      opencodeServiceOwner: "local",
    });

    expect(access.owner).toEqual(LOCAL_OWNER);
    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    expect(access.transport).toBeDefined();
    expect(ensureBaseUrlCalls).toBe(1);
  });

  it("refuses an unreadable owner key before reaching the manager", async () => {
    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: "adopted:not-a-valid-origin",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("unreadable");
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("keeps the legacy managed client path total when a start publishes no target", async () => {
    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    expect(access.owner).toEqual(LOCAL_OWNER);
    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    expect(typeof access.transport).toBe("function");
    await expect(access.transport("http://127.0.0.1:4001/api/info")).rejects.toBeInstanceOf(
      OpenCodeOriginMismatchError,
    );
    expect(ensureBaseUrlCalls).toBe(1);
  });
});

describe("resolveOpenCodeServiceAccess â€” shutdown", () => {
  it("refuses before any service work once shutdown has begun", async () => {
    await beginShutdown();

    for (const conversation of [
      { id: "conv-1", opencodeSessionId: null, opencodeServiceOwner: null },
      { id: "conv-1", opencodeSessionId: "ses_a", opencodeServiceOwner: "local" },
      {
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: `remote:${REMOTE_A}`,
      },
    ]) {
      await expect(resolveOpenCodeServiceAccess(conversation)).rejects.toBeInstanceOf(
        OpenCodeNotReadyError,
      );
    }
    expect(ensureBaseUrlCalls).toBe(0);
  });
});

describe("resolveOpenCodeServiceAccess - lost adopted recovery affinity (P3-A)", () => {
  it("refuses a conversation bound to a lost adopted service as unavailable even when managed is installed", async () => {
    const { revalidateAdoptedTarget } = await import("@/services/opencode/recovery.ts");
    const { OPENCODE_CONFIG } = await import("@/config/opencode.ts");
    installAdoptedTarget({
      origin: EXPLICIT_LOOPBACK,
      password: SYNTHETIC_PASSWORD,
      profileId: `explicit:${EXPLICIT_LOOPBACK}`,
    });
    await revalidateAdoptedTarget({
      config: { ...OPENCODE_CONFIG, adoptedLossConfirmAttempts: 1, adoptedLossRetryDelayMs: 0 },
      probeTransport: Object.assign(
        async () => {
          throw new Error("connect ECONNREFUSED");
        },
        { preconnect: globalThis.fetch.preconnect },
      ) as any,
      rediscover: async () => null,
      verifySessionAvailability: async () => true,
    });
    installManagedTarget({ baseUrl: "http://127.0.0.1:4000", password: "synthetic-managed" });

    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-remote",
        opencodeSessionId: "ses_remote",
        opencodeServiceOwner: `remote:${EXPLICIT_LOOPBACK}`,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("adopted_unavailable");
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("allows local/unbound conversations to use managed fallback while lost adopted recovery is pending", async () => {
    const { revalidateAdoptedTarget } = await import("@/services/opencode/recovery.ts");
    const { OPENCODE_CONFIG } = await import("@/config/opencode.ts");
    installAdoptedTarget({
      origin: EXPLICIT_LOOPBACK,
      password: SYNTHETIC_PASSWORD,
      profileId: `explicit:${EXPLICIT_LOOPBACK}`,
    });
    await revalidateAdoptedTarget({
      config: { ...OPENCODE_CONFIG, adoptedLossConfirmAttempts: 1, adoptedLossRetryDelayMs: 0 },
      probeTransport: Object.assign(
        async () => {
          throw new Error("connect ECONNREFUSED");
        },
        { preconnect: globalThis.fetch.preconnect },
      ) as any,
      rediscover: async () => null,
      verifySessionAvailability: async () => true,
    });
    ensureBaseUrlImpl = async () => {
      installManagedTarget({ baseUrl: "http://127.0.0.1:4000", password: "synthetic-managed" });
      return "http://127.0.0.1:4000";
    };

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-local",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    expect(access.owner).toEqual(LOCAL_OWNER);
    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    expect(ensureBaseUrlCalls).toBe(1);
  });
});
