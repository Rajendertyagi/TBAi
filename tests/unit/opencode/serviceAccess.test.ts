import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  beginShutdown,
  installAdoptedTarget,
  installManagedTarget,
  OpenCodeNotReadyError,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { OpenCodeHistoryBoundaryError } from "@/services/opencode/historyBoundary.ts";
import { OpenCodeOriginMismatchError } from "@/services/opencode/http.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";
import { resolveOpenCodeServiceAccess } from "@/services/opencode/serviceAccess.ts";

/**
 * The single service resolver for history operations (H3/B3, §4.3 of the
 * hybrid plan).
 *
 * What matters here is ordering and reachability, not the shape of the result:
 *
 *  - an installed target decides first, so an adopted-bound conversation is
 *    refused BEFORE the managed manager is asked for anything;
 *  - an adopted-bound conversation with no installed target is refused rather
 *    than served by a managed stand-in — that refusal is what stops a fallback
 *    or a startup race from starting a managed child for adopted history;
 *  - the managed manager is reached only for a conversation with no binding or
 *    a managed binding;
 *  - the access carries the transport captured with the target, so a caller
 *    cannot pair one service's credential with another's address.
 *
 * `ensureBaseUrl` is the process-ownership seam and is replaced by a counter:
 * no child is spawned and no database lease is acquired in this suite.
 * Connection state is real module state and is reset between cases.
 */

type ManagerSeam = { ensureBaseUrl: () => Promise<string> };
const manager = openCodeServerManager as unknown as ManagerSeam;
const originalEnsureBaseUrl = manager.ensureBaseUrl;

let ensureBaseUrlCalls = 0;
let ensureBaseUrlImpl: () => Promise<string>;

beforeEach(() => {
  resetConnectionStateForTests();
  ensureBaseUrlCalls = 0;
  ensureBaseUrlImpl = async () => "http://127.0.0.1:4000";
  manager.ensureBaseUrl = async () => {
    ensureBaseUrlCalls += 1;
    return ensureBaseUrlImpl();
  };
});

afterAll(() => {
  manager.ensureBaseUrl = originalEnsureBaseUrl;
  resetConnectionStateForTests();
});

const ADOPTED_A = "http://127.0.0.1:51234";
const ADOPTED_B = "http://127.0.0.1:51235";
const SYNTHETIC_PASSWORD = "synthetic-adopted-password";

function managedTarget(): void {
  installManagedTarget({ baseUrl: "http://127.0.0.1:4000", password: "synthetic-managed" });
}

function adoptedTarget(origin: string): void {
  installAdoptedTarget({ origin, password: SYNTHETIC_PASSWORD });
}

describe("resolveOpenCodeServiceAccess — installed target decides", () => {
  it("returns the adopted owner and the captured transport without asking the manager", async () => {
    adoptedTarget(ADOPTED_A);

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: "ses_a",
      opencodeServiceOwner: `adopted:${ADOPTED_A}`,
    });

    expect(access.owner).toEqual({ kind: "adopted", origin: ADOPTED_A });
    expect(access.baseUrl).toBe(ADOPTED_A);
    expect(access.transport).toBeDefined();
    expect(ensureBaseUrlCalls).toBe(0);
    expect(Object.isFrozen(access)).toBe(true);
  });

  it("binds the transport to the captured origin, so it cannot be re-pointed", async () => {
    adoptedTarget(ADOPTED_A);
    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    await expect(access.transport?.(`${ADOPTED_B}/api/session`)).rejects.toBeInstanceOf(
      OpenCodeOriginMismatchError,
    );
  });

  it("allows an unbound conversation to bind on the installed adopted service", async () => {
    adoptedTarget(ADOPTED_A);

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    expect(access.owner).toEqual({ kind: "adopted", origin: ADOPTED_A });
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("refuses an adopted binding for a different origin", async () => {
    adoptedTarget(ADOPTED_B);

    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: `adopted:${ADOPTED_A}`,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("cross_service");
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("refuses a legacy managed binding while an adopted target is installed", async () => {
    adoptedTarget(ADOPTED_A);

    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: null,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("cross_service");
    // No managed child may be started to satisfy a managed-bound conversation
    // while the runtime is bound to an adopted service.
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("refuses an adopted binding while a managed target is installed", async () => {
    managedTarget();

    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: `adopted:${ADOPTED_A}`,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("cross_service");
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("serves a managed binding from an installed managed target", async () => {
    managedTarget();

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: "ses_a",
      opencodeServiceOwner: null,
    });

    expect(access.owner).toEqual({ kind: "managed" });
    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    expect(access.transport).toBeDefined();
    expect(ensureBaseUrlCalls).toBe(0);
  });
});

describe("resolveOpenCodeServiceAccess — nothing installed", () => {
  it("refuses an adopted binding instead of starting a managed stand-in", async () => {
    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: `adopted:${ADOPTED_A}`,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("adopted_unavailable");
    // The refusal is reached BEFORE any managed startup work: no spawn, and no
    // database lease, for history that lives on another service.
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("starts the managed service for an unbound conversation and publishes it", async () => {
    ensureBaseUrlImpl = async () => {
      // Mirrors the real manager, which publishes the target before resolving.
      installManagedTarget({ baseUrl: "http://127.0.0.1:4000", password: "synthetic-managed" });
      return "http://127.0.0.1:4000";
    };

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    expect(access.owner).toEqual({ kind: "managed" });
    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    expect(access.transport).toBeDefined();
    expect(ensureBaseUrlCalls).toBe(1);
  });

  it("starts the managed service for a managed binding", async () => {
    ensureBaseUrlImpl = async () => {
      installManagedTarget({ baseUrl: "http://127.0.0.1:4000", password: "synthetic-managed" });
      return "http://127.0.0.1:4000";
    };

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: "ses_a",
      opencodeServiceOwner: "managed",
    });

    expect(access.owner).toEqual({ kind: "managed" });
    expect(ensureBaseUrlCalls).toBe(1);
  });

  it("re-checks after the start: an adopted target installed meanwhile owns the check", async () => {
    ensureBaseUrlImpl = async () => {
      adoptedTarget(ADOPTED_A);
      return ADOPTED_A;
    };

    // The conversation claimed the managed service, but the runtime bound to an
    // adopted service while the start was in flight. The published target wins.
    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: "managed",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("cross_service");
  });

  it("refuses a damaged owner key before any managed work", async () => {
    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: "not-a-service",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("unreadable");
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("keeps the legacy managed client path total when a start publishes no target", async () => {
    // Test-double path: the real manager always publishes before resolving, so
    // this only covers a manager that answers with a URL and nothing else.
    const access = await resolveOpenCodeServiceAccess({
      id: "conv-1",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    expect(access.owner).toEqual({ kind: "managed" });
    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    // The legacy path still gets a REAL transport: bound to the managed origin,
    // so a caller cannot point it at another service.
    expect(typeof access.transport).toBe("function");
    await expect(access.transport("http://127.0.0.1:4001/api/info")).rejects.toBeInstanceOf(
      OpenCodeOriginMismatchError,
    );
    expect(ensureBaseUrlCalls).toBe(1);
  });
});

describe("resolveOpenCodeServiceAccess — shutdown", () => {
  it("refuses before any service work once shutdown has begun", async () => {
    await beginShutdown();

    for (const conversation of [
      { id: "conv-1", opencodeSessionId: null, opencodeServiceOwner: null },
      { id: "conv-1", opencodeSessionId: "ses_a", opencodeServiceOwner: "managed" },
      {
        id: "conv-1",
        opencodeSessionId: "ses_a",
        opencodeServiceOwner: `adopted:${ADOPTED_A}`,
      },
    ]) {
      await expect(resolveOpenCodeServiceAccess(conversation)).rejects.toBeInstanceOf(
        OpenCodeNotReadyError,
      );
    }
    expect(ensureBaseUrlCalls).toBe(0);
  });
});
