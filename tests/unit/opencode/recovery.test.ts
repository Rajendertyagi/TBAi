import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import {
  beginShutdown,
  installAdoptedTarget,
  installManagedTarget,
  readConnectionState,
  registerManagedChildStopProvider,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { OpenCodeRedirectRefusedError } from "@/services/opencode/http.ts";
import type { OpenCodeTransport } from "@/services/opencode/http.ts";
import {
  getLostAdoptedRecovery,
  resetLostAdoptedRecoveryForTests,
  revalidateAdoptedTarget,
  type RediscoveryCandidate,
} from "@/services/opencode/recovery.ts";
import { conversationService } from "@/services/storage/conversations.ts";

/**
 * P3-A: affinity-safe adopted loss recovery with scoped rediscovery/re-adopt.
 *
 * No case starts, signals or restarts a real process. Probe/rediscovery/session
 * verification are injected. Assertions cover liveness decisions, affinity-safe
 * loss handling, bounded passive rediscovery, compatibility/session checks,
 * restore without unsafe global switching, and absence of non-owned lifecycle ops.
 */

const ORIGIN = "http://127.0.0.1:4321";
const OTHER_ORIGIN = "http://127.0.0.1:4322";
const PASSWORD = "recovery-fixture-password";
const MANAGED_BASE_URL = "http://127.0.0.1:4323";

const FAST_CONFIG = {
  ...OPENCODE_CONFIG,
  adoptedLossConfirmAttempts: 2,
  adoptedLossRetryDelayMs: 0,
  discoveryProbeTimeoutMs: 50,
};

function transportFrom(respond: (url: string) => Response | Promise<Response>): {
  transport: OpenCodeTransport;
  calls: string[];
} {
  const calls: string[] = [];
  const fn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return respond(url);
  };
  return {
    transport: Object.assign(fn, { preconnect: globalThis.fetch.preconnect }),
    calls,
  };
}

function unreachable(): never {
  throw new Error("connect ECONNREFUSED");
}

function installAdopted(origin = ORIGIN, profileId?: string): void {
  installAdoptedTarget({ origin, password: PASSWORD, profileId });
}

function candidate(origin = ORIGIN): RediscoveryCandidate {
  return {
    origin,
    password: PASSWORD,
    capabilities: {
      version: "2.2.0",
      supported: {
        session: true,
        events: true,
        config: true,
        agent: true,
        model: true,
        command: true,
      },
    },
    profileId: undefined,
    runtimePid: 4242,
    dataLocation: undefined,
    registration: {
      path: "rediscovery",
      origin,
      pid: 4242,
      password: PASSWORD,
      version: "2.2.0",
    },
  };
}

const originalList = conversationService.list;

beforeEach(() => {
  resetConnectionStateForTests();
  resetLostAdoptedRecoveryForTests();
  (conversationService as any).list = () => [];
});

afterEach(() => {
  (conversationService as any).list = originalList;
  resetLostAdoptedRecoveryForTests();
  resetConnectionStateForTests();
});

describe("revalidation - the target is not adopted", () => {
  it("does nothing when no target is installed and no lost recovery exists", async () => {
    const { transport, calls } = transportFrom(() => new Response("", { status: 200 }));

    expect(await revalidateAdoptedTarget({ probeTransport: transport })).toEqual({
      status: "not-adopted",
    });
    expect(calls).toHaveLength(0);
  });

  it("does nothing when the managed target is installed and no lost recovery exists", async () => {
    installManagedTarget({ baseUrl: MANAGED_BASE_URL, password: PASSWORD });
    const { transport, calls } = transportFrom(() => new Response("", { status: 200 }));

    expect(await revalidateAdoptedTarget({ probeTransport: transport })).toEqual({
      status: "not-adopted",
    });
    expect(calls).toHaveLength(0);
    expect(readConnectionState().target).toMatchObject({
      mode: "managed",
      baseUrl: MANAGED_BASE_URL,
    });
  });
});

describe("revalidation - a service that answers is alive", () => {
  it("preserves the target on any HTTP status, including 401 and 500", async () => {
    for (const status of [200, 401, 500]) {
      resetConnectionStateForTests();
      resetLostAdoptedRecoveryForTests();
      installAdopted();
      const { transport, calls } = transportFrom(() => new Response("", { status }));

      expect(await revalidateAdoptedTarget({ probeTransport: transport })).toEqual({
        status: "preserved",
        lastStatus: status,
      });
      expect(calls).toEqual([`${ORIGIN}${OPENCODE_CONFIG.readinessProbePath}`]);
      expect(readConnectionState().target).toMatchObject({ mode: "adopted", origin: ORIGIN });
      expect(getLostAdoptedRecovery()).toBeNull();
    }
  });

  it("treats a refused redirect as proof of life, not evidence of loss", async () => {
    installAdopted();
    const { transport } = transportFrom(() => {
      throw new OpenCodeRedirectRefusedError(307);
    });

    expect(await revalidateAdoptedTarget({ probeTransport: transport })).toEqual({
      status: "preserved",
      lastStatus: null,
    });
    expect(readConnectionState().target).toMatchObject({ mode: "adopted", origin: ORIGIN });
  });

  it("preserves the target after one transient failure, before the loss is confirmed", async () => {
    installAdopted();
    let probes = 0;
    const { transport } = transportFrom(() => {
      probes += 1;
      if (probes === 1) unreachable();
      return new Response("", { status: 503 });
    });

    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transport,
      rediscover: async () => candidate(),
      verifySessionAvailability: async () => true,
    });

    expect(outcome).toEqual({ status: "preserved", lastStatus: 503 });
    expect(probes).toBe(2);
    expect(readConnectionState().target).toMatchObject({ mode: "adopted", origin: ORIGIN });
    expect(getLostAdoptedRecovery()).toBeNull();
  });
});

describe("revalidation - confirmed loss is affinity-safe", () => {
  it("clears dead adopted target without installing managed fallback globally", async () => {
    installAdopted();
    const { transport, calls } = transportFrom(unreachable);

    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transport,
      rediscover: async () => null,
      verifySessionAvailability: async () => true,
    });

    expect(outcome).toEqual({ status: "unavailable", origin: ORIGIN, reason: "cannot_rediscover" });
    expect(calls).toHaveLength(FAST_CONFIG.adoptedLossConfirmAttempts);
    expect(readConnectionState().target.mode).toBe("unresolved");
    expect(getLostAdoptedRecovery()?.lost.origin).toBe(ORIGIN);
  });

  it("restores the original adopted service when rediscovered and verified (no duplicate sessions/resubmits)", async () => {
    installAdopted();
    let rediscoverCalls = 0;
    let verifyCalls = 0;

    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transportFrom(unreachable).transport,
      rediscover: async (lost) => {
        rediscoverCalls += 1;
        expect(lost.origin).toBe(ORIGIN);
        return candidate(ORIGIN);
      },
      verifySessionAvailability: async (cand, lost) => {
        verifyCalls += 1;
        expect(cand.origin).toBe(ORIGIN);
        expect(lost.origin).toBe(ORIGIN);
        return true;
      },
    });

    expect(outcome).toEqual({ status: "restored", origin: ORIGIN });
    expect(rediscoverCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(readConnectionState().target).toMatchObject({ mode: "adopted", origin: ORIGIN });
    expect(getLostAdoptedRecovery()).toBeNull();
  });

  it("does not re-adopt an incompatible rediscovered server (different origin)", async () => {
    installAdopted();
    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transportFrom(unreachable).transport,
      rediscover: async () => candidate(OTHER_ORIGIN),
      verifySessionAvailability: async () => true,
    });

    expect(outcome).toEqual({ status: "unavailable", origin: ORIGIN, reason: "incompatible" });
    expect(readConnectionState().target.mode).toBe("unresolved");
    expect(getLostAdoptedRecovery()?.lost.origin).toBe(ORIGIN);
  });

  it("fails safely when session availability cannot be verified", async () => {
    installAdopted();
    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transportFrom(unreachable).transport,
      rediscover: async () => candidate(ORIGIN),
      verifySessionAvailability: async () => false,
    });

    expect(outcome).toEqual({ status: "unavailable", origin: ORIGIN, reason: "incompatible" });
    expect(readConnectionState().target.mode).toBe("unresolved");
    expect(getLostAdoptedRecovery()?.lost.origin).toBe(ORIGIN);
  });

  it("never signals or lifecycle-controls the adopted/external process", async () => {
    installAdopted();
    let enumerations = 0;
    const unregister = registerManagedChildStopProvider({
      stopAllChildrenForShutdown: () => {
        enumerations += 1;
        return [];
      },
    });

    try {
      await revalidateAdoptedTarget({
        config: FAST_CONFIG,
        probeTransport: transportFrom(unreachable).transport,
        rediscover: async () => null,
        verifySessionAvailability: async () => true,
      });
    } finally {
      unregister();
    }

    expect(enumerations).toBe(0);
  });

  it("runs one recovery for concurrent callers sharing the in-flight check", async () => {
    installAdopted();
    const { transport, calls } = transportFrom(unreachable);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rediscoverCalls = 0;
    const options = {
      config: FAST_CONFIG,
      probeTransport: transport,
      rediscover: async () => {
        rediscoverCalls += 1;
        await gate;
        return null;
      },
      verifySessionAvailability: async () => true,
    };

    const first = revalidateAdoptedTarget(options);
    const second = revalidateAdoptedTarget(options);
    expect(second).toBe(first);

    release();
    expect(await Promise.all([first, second])).toEqual([
      { status: "unavailable", origin: ORIGIN, reason: "cannot_rediscover" },
      { status: "unavailable", origin: ORIGIN, reason: "cannot_rediscover" },
    ]);
    expect(rediscoverCalls).toBe(1);
    expect(calls).toHaveLength(FAST_CONFIG.adoptedLossConfirmAttempts);
  });

  it("retries rediscovery on a later tick after unavailable (bounded passive)", async () => {
    installAdopted();
    await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transportFrom(unreachable).transport,
      rediscover: async () => null,
      verifySessionAvailability: async () => true,
    });
    expect(getLostAdoptedRecovery()?.failed).toBe(true);
    expect(readConnectionState().target.mode).toBe("unresolved");

    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      rediscover: async () => candidate(ORIGIN),
      verifySessionAvailability: async () => true,
    });

    expect(outcome).toEqual({ status: "restored", origin: ORIGIN });
    expect(readConnectionState().target).toMatchObject({ mode: "adopted", origin: ORIGIN });
    expect(getLostAdoptedRecovery()).toBeNull();
  });
});

describe("revalidation - refusals and safety", () => {
  it("refuses after shutdown without probing", async () => {
    installAdopted();
    await beginShutdown();
    const { transport, calls } = transportFrom(() => new Response("", { status: 200 }));

    expect(await revalidateAdoptedTarget({ probeTransport: transport })).toEqual({
      status: "refused",
      reason: "shutdown",
    });
    expect(calls).toHaveLength(0);
  });

  it("does not restore if a different target was installed meanwhile", async () => {
    installAdopted();
    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transportFrom(unreachable).transport,
      rediscover: async () => {
        // Simulate concurrent install of managed target (e.g. local fallback path)
        installManagedTarget({ baseUrl: MANAGED_BASE_URL, password: PASSWORD });
        return candidate(ORIGIN);
      },
      verifySessionAvailability: async () => true,
    });

    expect(outcome).toEqual({ status: "refused", reason: "superseded" });
    expect(readConnectionState().target).toMatchObject({
      mode: "managed",
      baseUrl: MANAGED_BASE_URL,
    });
  });
});

describe("revalidation - production probe path", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("probes through the captured, origin-bound transport", async () => {
    installAdopted();
    const calls: string[] = [];
    const stub = async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("", { status: 200 });
    };
    globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });

    expect(await revalidateAdoptedTarget({ config: FAST_CONFIG })).toEqual({
      status: "preserved",
      lastStatus: 200,
    });
    expect(calls).toEqual([`${ORIGIN}${OPENCODE_CONFIG.readinessProbePath}`]);
  });
});
