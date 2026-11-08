import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import {
  beginAttempt,
  beginShutdown,
  captureOpenCodeRequestContext,
  installAdoptedTarget,
  installManagedTarget,
  readConnectionState,
  registerManagedChildStopProvider,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { OpenCodeRedirectRefusedError } from "@/services/opencode/http.ts";
import type { OpenCodeTransport } from "@/services/opencode/http.ts";
import { revalidateAdoptedTarget } from "@/services/opencode/recovery.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";

/**
 * D3 / §1.5.1 rows 5–9 — revalidating an adopted service and the managed
 * fallback.
 *
 * No case starts, signals or restarts a real process: the probe transport and
 * the managed-start function are injected. What is asserted is the decision
 * logic — preservation on a transient failure, fallback only on confirmed
 * loss, one managed start under concurrency, and a typed refusal at every
 * lifecycle boundary.
 */

const ORIGIN = "http://127.0.0.1:4321";
const OTHER_ORIGIN = "http://127.0.0.1:4322";
const PASSWORD = "recovery-fixture-password";
/** The newer adoption's OWN credential — distinct, so a reuse would be visible. */
const NEW_PASSWORD = "recovery-newer-adoption-password";
const MANAGED_BASE_URL = "http://127.0.0.1:4323";

const FAST_CONFIG = {
  ...OPENCODE_CONFIG,
  adoptedLossConfirmAttempts: 2,
  adoptedLossRetryDelayMs: 0,
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

function installAdopted(origin = ORIGIN): void {
  installAdoptedTarget({ origin, password: PASSWORD });
}

beforeEach(() => {
  resetConnectionStateForTests();
});

afterEach(() => {
  resetConnectionStateForTests();
});

describe("revalidation — the target is not adopted", () => {
  it("does nothing when no target is installed", async () => {
    const { transport, calls } = transportFrom(() => new Response("", { status: 200 }));

    expect(await revalidateAdoptedTarget({ probeTransport: transport })).toEqual({
      status: "not-adopted",
    });
    expect(calls).toHaveLength(0);
  });

  it("does nothing when the managed target is installed", async () => {
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

describe("revalidation — a service that answers is alive", () => {
  it("preserves the target on any HTTP status, including 401 and 500", async () => {
    for (const status of [200, 401, 500]) {
      resetConnectionStateForTests();
      installAdopted();
      const { transport, calls } = transportFrom(() => new Response("", { status }));

      expect(await revalidateAdoptedTarget({ probeTransport: transport })).toEqual({
        status: "preserved",
        lastStatus: status,
      });
      expect(calls).toEqual([`${ORIGIN}${OPENCODE_CONFIG.readinessProbePath}`]);
      expect(readConnectionState().target).toMatchObject({ mode: "adopted", origin: ORIGIN });
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
    let starts = 0;

    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transport,
      startManaged: async () => {
        starts += 1;
        return MANAGED_BASE_URL;
      },
    });

    expect(outcome).toEqual({ status: "preserved", lastStatus: 503 });
    expect(probes).toBe(2);
    expect(starts).toBe(0);
    expect(readConnectionState().target).toMatchObject({ mode: "adopted", origin: ORIGIN });
  });
});

describe("revalidation — confirmed loss falls back to the managed service", () => {
  it("clears the adopted target and installs the managed one", async () => {
    installAdopted();
    const { transport, calls } = transportFrom(unreachable);
    const starts: string[] = [];

    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transport,
      startManaged: async () => {
        starts.push(MANAGED_BASE_URL);
        return MANAGED_BASE_URL;
      },
    });

    expect(outcome).toEqual({ status: "fallback", managedBaseUrl: MANAGED_BASE_URL });
    expect(starts).toHaveLength(1);
    // Every bounded attempt ran before the loss was confirmed.
    expect(calls).toHaveLength(FAST_CONFIG.adoptedLossConfirmAttempts);
    expect(readConnectionState().target).toMatchObject({
      mode: "managed",
      baseUrl: MANAGED_BASE_URL,
    });
  });

  /**
   * AT6: an adoption that succeeded and then suffers a SECOND loss observation.
   *
   * After the first confirmed loss the target is managed. A second loss must
   * not start another managed child, must not move the binding again, and must
   * not even probe: it reports `not-adopted` because there is no adopted
   * service left to lose.
   */
  it("AT6 — a second loss after fallback starts nothing and preserves the target", async () => {
    installAdopted();
    let starts = 0;
    const startManaged = async (): Promise<string> => {
      starts += 1;
      return MANAGED_BASE_URL;
    };

    const first = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transportFrom(unreachable).transport,
      startManaged,
    });
    expect(first).toEqual({ status: "fallback", managedBaseUrl: MANAGED_BASE_URL });
    expect(starts).toBe(1);
    const afterFallback = readConnectionState();
    expect(afterFallback.target).toMatchObject({ mode: "managed", baseUrl: MANAGED_BASE_URL });

    const secondProbe = transportFrom(unreachable);
    const second = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: secondProbe.transport,
      startManaged,
    });
    expect(second).toEqual({ status: "not-adopted" });
    expect(starts).toBe(1);
    expect(secondProbe.calls).toHaveLength(0);
    expect(readConnectionState().revision).toBe(afterFallback.revision);
    expect(readConnectionState().target).toMatchObject({
      mode: "managed",
      baseUrl: MANAGED_BASE_URL,
    });
  });

  it("honours the configured confirmation count", async () => {
    installAdopted();
    const { transport, calls } = transportFrom(unreachable);
    const config = { ...FAST_CONFIG, adoptedLossConfirmAttempts: 3 };

    await revalidateAdoptedTarget({
      config,
      probeTransport: transport,
      startManaged: async () => MANAGED_BASE_URL,
    });

    expect(calls).toHaveLength(3);
  });

  it("runs one managed start for concurrent callers sharing the in-flight check", async () => {
    installAdopted();
    const { transport, calls } = transportFrom(unreachable);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let starts = 0;
    const options = {
      config: FAST_CONFIG,
      probeTransport: transport,
      startManaged: async () => {
        starts += 1;
        await gate;
        return MANAGED_BASE_URL;
      },
    };

    const first = revalidateAdoptedTarget(options);
    const second = revalidateAdoptedTarget(options);
    // The second caller joins the first run rather than starting its own.
    expect(second).toBe(first);

    release();
    expect(await Promise.all([first, second])).toEqual([
      { status: "fallback", managedBaseUrl: MANAGED_BASE_URL },
      { status: "fallback", managedBaseUrl: MANAGED_BASE_URL },
    ]);
    expect(starts).toBe(1);
    expect(calls).toHaveLength(FAST_CONFIG.adoptedLossConfirmAttempts);
  });

  it("starts a fresh check after the shared run settles", async () => {
    installAdopted();
    const { transport, calls } = transportFrom(() => new Response("", { status: 200 }));

    await revalidateAdoptedTarget({ probeTransport: transport });
    await revalidateAdoptedTarget({ probeTransport: transport });

    expect(calls).toHaveLength(2);
  });

  it("never signals the adopted process", async () => {
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
        startManaged: async () => MANAGED_BASE_URL,
      });
    } finally {
      unregister();
    }

    // The managed-child owner was not even asked: recovery has no stop path for
    // an adopted service (§3.3).
    expect(enumerations).toBe(0);
  });
});

describe("revalidation — refusals", () => {
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

  it("leaves the target unresolved when the managed start fails", async () => {
    installAdopted();
    const { transport } = transportFrom(unreachable);

    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transport,
      startManaged: async () => {
        throw new Error("managed binary missing");
      },
    });

    expect(outcome).toEqual({ status: "refused", reason: "managed_start_failed" });
    // Row 9: no retry loop and no silent restore of the cleared binding.
    expect(readConnectionState().target.mode).toBe("unresolved");
  });

  it("AT7 — a newer adoption supersedes the fallback and keeps its own credential", async () => {
    installAdopted(ORIGIN);
    const { transport } = transportFrom(unreachable);
    let revisionAtAdoption = -1;

    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transport,
      startManaged: async () => {
        // A concurrent adoption wins the state while the managed start is in
        // flight. Its own attempt is the current one.
        const attempt = beginAttempt("manual");
        installAdoptedTarget({ origin: OTHER_ORIGIN, password: NEW_PASSWORD, attempt });
        revisionAtAdoption = readConnectionState().revision;
        return MANAGED_BASE_URL;
      },
    });

    expect(outcome).toEqual({ status: "refused", reason: "superseded" });
    // The newer adoption REMAINS installed, and it kept its own credential: the
    // stale fallback neither replaced it nor rotated it back to the previous
    // adopted password or TBAi's managed one.
    expect(readConnectionState().target).toMatchObject({
      mode: "adopted",
      baseUrl: OTHER_ORIGIN,
      origin: OTHER_ORIGIN,
      credential: { kind: "adopted", origin: OTHER_ORIGIN, password: NEW_PASSWORD },
    });
    expect(readConnectionState().target).not.toMatchObject({
      credential: { password: PASSWORD },
    });
    expect(readConnectionState().target).not.toMatchObject({
      credential: { password: getOpenCodeAuthPassword() },
    });
    // The stale run wrote nothing after the newer install: same revision.
    expect(readConnectionState().revision).toBe(revisionAtAdoption);

    // Origin and credential come from ONE capture, and the transport sends that
    // pair: the request reaches the newer origin bearing the newer secret.
    const realFetch = globalThis.fetch;
    const captured: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({});
      },
      { preconnect: realFetch.preconnect },
    );
    try {
      const context = captureOpenCodeRequestContext();
      expect(context.baseUrl).toBe(OTHER_ORIGIN);
      await context.transport(`${context.baseUrl}${OPENCODE_CONFIG.readinessProbePath}`);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(`${OTHER_ORIGIN}${OPENCODE_CONFIG.readinessProbePath}`);
    const decoded = Buffer.from(
      (captured[0]?.authorization ?? "").replace(/^Basic /, ""),
      "base64",
    ).toString("utf8");
    expect(decoded).toBe(`${OPENCODE_CONFIG.authUsername}:${NEW_PASSWORD}`);
  });

  it("AT7 — a revalidation that goes stale during the probe clears and installs nothing", async () => {
    installAdopted(ORIGIN);
    let adoptedDuringProbe = false;
    const { transport, calls } = transportFrom(() => {
      // The target changes underneath the bounded confirmation probes.
      if (!adoptedDuringProbe) {
        adoptedDuringProbe = true;
        const attempt = beginAttempt("manual");
        installAdoptedTarget({ origin: OTHER_ORIGIN, password: NEW_PASSWORD, attempt });
      }
      return unreachable();
    });
    const starts: string[] = [];

    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      probeTransport: transport,
      startManaged: async () => {
        starts.push(MANAGED_BASE_URL);
        return MANAGED_BASE_URL;
      },
    });

    // The origin guard refuses at the decision point: a stale revalidation can
    // neither clear the newer binding nor install the old one, and it never
    // starts the managed fallback.
    expect(outcome).toEqual({ status: "refused", reason: "superseded" });
    expect(starts).toHaveLength(0);
    expect(calls).toHaveLength(FAST_CONFIG.adoptedLossConfirmAttempts);
    expect(readConnectionState().target).toMatchObject({
      mode: "adopted",
      baseUrl: OTHER_ORIGIN,
      origin: OTHER_ORIGIN,
      credential: { kind: "adopted", origin: OTHER_ORIGIN, password: NEW_PASSWORD },
    });
  });
});

describe("revalidation — the production probe path", () => {
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
