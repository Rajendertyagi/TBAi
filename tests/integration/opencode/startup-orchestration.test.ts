import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OPENCODE_CONFIG, type OpenCodeConfig } from "@/config/opencode.ts";
import {
  beginShutdown,
  installManagedTarget,
  readConnectionState,
  registerManagedChildStopProvider,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import type { OpenCodeTransport } from "@/services/opencode/http.ts";
import { revalidateAdoptedTarget } from "@/services/opencode/recovery.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";
import {
  isOpenCodeRevalidationRunning,
  resetOpenCodeRuntimeStartupForTests,
  startOpenCodeRuntime,
} from "@/services/opencode/startup.ts";

/**
 * H5/B2 + D3 — the startup orchestration end to end.
 *
 * The real `startOpenCodeRuntime` runs here: the registration is a disposable
 * file in a temp directory, the candidate is a test-owned `Bun.serve` instance
 * on loopback, and the managed child is a seam that performs the same state
 * publication `ensureBaseUrl()` performs. No real registration, credential,
 * service or managed binary is read, probed or spawned, and no process is
 * signalled.
 *
 * What is asserted is the decision the boot path must make: adopt a compatible
 * service, or OWN the runtime and start the managed child immediately. The
 * managed start is never left for the first Code request.
 */

const PASSWORD = "startup-orchestration-password";
const FAKE_PID = 4242;
const VERSION = "2.2.0";
const MANAGED_URL = "http://127.0.0.1:4799";

const FAST_CONFIG = {
  ...OPENCODE_CONFIG,
  discoveryProbeTimeoutMs: 1_000,
  registrationReadTimeoutMs: 1_000,
  adoptionRevalidateIntervalMs: 60_000,
  adoptedLossConfirmAttempts: 1,
  adoptedLossRetryDelayMs: 0,
};

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tbai-opencode-startup-"));
  resetConnectionStateForTests();
  resetOpenCodeRuntimeStartupForTests();
});

afterEach(() => {
  resetOpenCodeRuntimeStartupForTests();
  resetConnectionStateForTests();
  rmSync(root, { recursive: true, force: true });
});

interface FakeOpenCode {
  readonly origin: string;
  readonly requests: string[];
  stop(): void;
}

interface FakeServiceOptions {
  readonly version?: string;
  /** Capability routes answered 404, to model an older or partial service. */
  readonly missingRoutes?: readonly string[];
  /** Held open so a test can shut down while the readiness probe is in flight. */
  readonly infoGate?: Promise<void>;
}

/** A test-owned OpenCode stand-in: `/api/info` plus the probed capability routes. */
function startFakeOpenCode(options: FakeServiceOptions = {}): FakeOpenCode {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === OPENCODE_CONFIG.readinessProbePath) {
        if (options.infoGate) await options.infoGate;
        return Response.json({ pid: FAKE_PID, version: options.version ?? VERSION });
      }
      if (url.pathname === "/api/event") {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (options.missingRoutes?.includes(url.pathname)) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 200 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

function writeRegistration(name: string, value: unknown): string {
  const file = path.join(root, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

function registrationFor(origin: string): Record<string, unknown> {
  return { url: origin, pid: FAKE_PID, password: PASSWORD, version: VERSION };
}

interface ManagedStarts {
  count: number;
  readonly baseUrls: string[];
}

/**
 * The managed-start seam. It publishes the target exactly as `ensureBaseUrl()`
 * does, so the state assertions below describe the production outcome.
 */
function managedStart(
  starts: ManagedStarts,
  options: { gate?: Promise<void>; baseUrl?: string } = {},
): () => Promise<string> {
  return async () => {
    starts.count += 1;
    if (options.gate) await options.gate;
    const baseUrl = options.baseUrl ?? MANAGED_URL;
    starts.baseUrls.push(baseUrl);
    installManagedTarget({ baseUrl, password: getOpenCodeAuthPassword() });
    return baseUrl;
  };
}

function newStarts(): ManagedStarts {
  return { count: 0, baseUrls: [] };
}

describe("H5/B2 — a compatible candidate is adopted and nothing is spawned", () => {
  it("adopts the service and leaves the managed path untouched", async () => {
    const fake = startFakeOpenCode();
    try {
      const starts = newStarts();
      const outcome = await startOpenCodeRuntime({
        config: FAST_CONFIG,
        disabled: false,
        registrationPath: writeRegistration("service.json", registrationFor(fake.origin)),
        startManaged: managedStart(starts),
      });

      expect(outcome.status).toBe("adopted");
      expect(starts.count).toBe(0);
      expect(readConnectionState().target).toMatchObject({
        mode: "adopted",
        origin: fake.origin,
      });
      expect(isOpenCodeRevalidationRunning()).toBe(true);

      // The adopted process is still serving: adoption read it, never took it.
      const response = await fetch(`${fake.origin}${OPENCODE_CONFIG.readinessProbePath}`);
      expect(response.status).toBe(200);
      await response.body?.cancel();
    } finally {
      fake.stop();
    }
  });

  it("adopts a degraded service (optional capability absent) without a spawn", async () => {
    const fake = startFakeOpenCode({ missingRoutes: ["/api/config"] });
    try {
      const starts = newStarts();
      const outcome = await startOpenCodeRuntime({
        config: FAST_CONFIG,
        disabled: false,
        registrationPath: writeRegistration("degraded.json", registrationFor(fake.origin)),
        startManaged: managedStart(starts),
      });

      expect(outcome.status).toBe("adopted");
      if (outcome.status === "adopted") expect(outcome.optionalMissing).toEqual(["config"]);
      expect(starts.count).toBe(0);
      expect(readConnectionState().target).toMatchObject({
        mode: "adopted",
        capabilities: { supported: { config: false, session: true, events: true } },
      });
    } finally {
      fake.stop();
    }
  });
});

describe("H5/B2 — every refused adoption starts the managed service at boot", () => {
  async function expectManagedFallback(input: {
    registration: unknown;
    config?: OpenCodeConfig;
  }): Promise<string | undefined> {
    const starts = newStarts();
    const outcome = await startOpenCodeRuntime({
      config: input.config ?? FAST_CONFIG,
      disabled: false,
      registrationPath: writeRegistration("service.json", input.registration),
      startManaged: managedStart(starts),
    });

    expect(outcome.status).toBe("managed");
    if (outcome.status !== "managed") return undefined;
    expect(starts.count).toBe(1);
    expect(outcome.baseUrl).toBe(MANAGED_URL);
    expect(readConnectionState().target).toMatchObject({
      mode: "managed",
      baseUrl: MANAGED_URL,
    });
    return outcome.reason;
  }

  it("empty registration file", async () => {
    const reason = await expectManagedFallback({ registration: "" });
    expect(reason).toBe("registration_malformed");
  });

  it("absent registration file", async () => {
    const starts = newStarts();
    const outcome = await startOpenCodeRuntime({
      config: FAST_CONFIG,
      disabled: false,
      registrationPath: path.join(root, "absent.json"),
      startManaged: managedStart(starts),
    });

    expect(outcome).toEqual({
      status: "managed",
      reason: "registration_missing",
      baseUrl: MANAGED_URL,
    });
    expect(starts.count).toBe(1);
  });

  it("invalid registration shape", async () => {
    const reason = await expectManagedFallback({
      registration: {
        url: "http://127.0.0.1:1",
        pid: "not-a-number",
        password: PASSWORD,
        version: VERSION,
      },
    });
    expect(reason).toBe("registration_invalid_pid");
  });

  it("non-loopback registration url", async () => {
    const reason = await expectManagedFallback({
      registration: {
        url: "http://10.0.0.5:4096",
        pid: FAKE_PID,
        password: PASSWORD,
        version: VERSION,
      },
    });
    expect(reason).toBe("registration_non_loopback");
  });

  it("missing adopted password", async () => {
    const reason = await expectManagedFallback({
      registration: { url: "http://127.0.0.1:1", pid: FAKE_PID, password: "", version: VERSION },
    });
    expect(reason).toBe("missing_credential");
  });

  it("unsupported essential capability", async () => {
    const fake = startFakeOpenCode({ missingRoutes: ["/api/session"] });
    try {
      const reason = await expectManagedFallback({
        registration: registrationFor(fake.origin),
      });
      expect(reason).toBe("probe_capability_missing");
      expect(readConnectionState().target.mode).toBe("managed");
    } finally {
      fake.stop();
    }
  });

  it("a candidate that no longer answers", async () => {
    const fake = startFakeOpenCode();
    const origin = fake.origin;
    fake.stop();

    const reason = await expectManagedFallback({
      registration: registrationFor(origin),
    });
    expect(reason).toBe("probe_failed");
  });

  it("reports a failed managed start instead of leaving the runtime unresolved", async () => {
    const outcome = await startOpenCodeRuntime({
      config: FAST_CONFIG,
      disabled: false,
      registrationPath: path.join(root, "absent.json"),
      startManaged: async () => {
        throw new Error("managed binary missing");
      },
    });

    expect(outcome).toEqual({
      status: "refused",
      reason: "managed_start_failed",
      adoptionReason: "registration_missing",
    });
    expect(readConnectionState().target.mode).toBe("unresolved");
  });
});

describe("H5/B2 — shutdown during an adoption attempt", () => {
  it("prevents a late installation and starts nothing", async () => {
    let release!: () => void;
    const infoGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = startFakeOpenCode({ infoGate });
    try {
      const starts = newStarts();
      const pending = startOpenCodeRuntime({
        config: FAST_CONFIG,
        disabled: false,
        registrationPath: writeRegistration("service.json", registrationFor(fake.origin)),
        startManaged: managedStart(starts),
      });

      // Wait until the real adoption attempt is inside the readiness probe.
      const deadline = Date.now() + 2_000;
      while (!fake.requests.includes(OPENCODE_CONFIG.readinessProbePath)) {
        if (Date.now() > deadline) throw new Error("adoption never reached the probe");
        await Bun.sleep(1);
      }

      const completion = beginShutdown();
      release();

      expect(await pending).toEqual({ status: "skipped", reason: "shutdown" });
      expect(await completion).toEqual({ ok: true });
      // Nothing was installed late, and the managed path was never started.
      expect(readConnectionState().target.mode).toBe("unresolved");
      expect(starts.count).toBe(0);
    } finally {
      fake.stop();
    }
  });
});

describe("B7 — the version strategy at the startup boundary", () => {
  it("adopts a newer stable build above the managed release ceiling", async () => {
    const fake = startFakeOpenCode({ version: "2.4.0" });
    try {
      const starts = newStarts();
      const outcome = await startOpenCodeRuntime({
        config: FAST_CONFIG,
        disabled: false,
        registrationPath: writeRegistration("newer.json", registrationFor(fake.origin)),
        startManaged: managedStart(starts),
      });

      expect(outcome.status).toBe("adopted");
      if (outcome.status === "adopted") expect(outcome.capabilities.version).toBe("2.4.0");
      expect(starts.count).toBe(0);
    } finally {
      fake.stop();
    }
  });

  it("refuses a prerelease build and starts the managed service (D2)", async () => {
    const fake = startFakeOpenCode({ version: "2.3.0-beta.1" });
    try {
      const starts = newStarts();
      const outcome = await startOpenCodeRuntime({
        config: FAST_CONFIG,
        disabled: false,
        registrationPath: writeRegistration("beta.json", registrationFor(fake.origin)),
        startManaged: managedStart(starts),
      });

      expect(outcome).toEqual({
        status: "managed",
        reason: "probe_version_unsupported",
        baseUrl: MANAGED_URL,
      });
      expect(starts.count).toBe(1);
      expect(readConnectionState().target.mode).toBe("managed");
    } finally {
      fake.stop();
    }
  });

  it("refuses an adopted service below 2.2.0 and falls back to the managed service", async () => {
    const fake = startFakeOpenCode({ version: "2.1.4" });
    try {
      const starts = newStarts();
      const outcome = await startOpenCodeRuntime({
        config: FAST_CONFIG,
        disabled: false,
        registrationPath: writeRegistration("old.json", registrationFor(fake.origin)),
        startManaged: managedStart(starts),
      });

      expect(outcome).toEqual({
        status: "managed",
        reason: "probe_version_unsupported",
        baseUrl: MANAGED_URL,
      });
      expect(starts.count).toBe(1);
      expect(fake.requests).not.toContain("/api/session");
      expect(readConnectionState().target.mode).toBe("managed");
    } finally {
      fake.stop();
    }
  });
});

describe("D3 — loss after adoption falls back to the managed service, once", () => {
  async function adoptFake(fake: FakeOpenCode): Promise<ManagedStarts> {
    const starts = newStarts();
    const outcome = await startOpenCodeRuntime({
      config: FAST_CONFIG,
      disabled: false,
      registrationPath: writeRegistration("service.json", registrationFor(fake.origin)),
      startManaged: managedStart(starts),
    });
    expect(outcome.status).toBe("adopted");
    expect(starts.count).toBe(0);
    return starts;
  }

  it("a confirmed loss starts one managed service and clears the adopted target", async () => {
    const fake = startFakeOpenCode();
    const starts = await adoptFake(fake);
    fake.stop();

    const outcome = await revalidateAdoptedTarget({
      config: FAST_CONFIG,
      startManaged: managedStart(starts),
    });

    expect(outcome).toEqual({ status: "fallback", managedBaseUrl: MANAGED_URL });
    expect(starts.count).toBe(1);
    expect(readConnectionState().target).toMatchObject({
      mode: "managed",
      baseUrl: MANAGED_URL,
    });
  });

  it("repeated recovery events share one managed start", async () => {
    const fake = startFakeOpenCode();
    const starts = await adoptFake(fake);
    fake.stop();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const options = {
      config: FAST_CONFIG,
      startManaged: managedStart(starts, { gate }),
    };

    const first = revalidateAdoptedTarget(options);
    const second = revalidateAdoptedTarget(options);
    expect(second).toBe(first);

    release();
    expect(await Promise.all([first, second])).toEqual([
      { status: "fallback", managedBaseUrl: MANAGED_URL },
      { status: "fallback", managedBaseUrl: MANAGED_URL },
    ]);
    expect(starts.count).toBe(1);
  });

  it("one transient probe failure preserves the adopted target", async () => {
    const fake = startFakeOpenCode();
    const starts = await adoptFake(fake);

    let probes = 0;
    const transport: OpenCodeTransport = Object.assign(
      async (): Promise<Response> => {
        probes += 1;
        if (probes === 1) throw new TypeError("fetch failed");
        return new Response("", { status: 503 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const outcome = await revalidateAdoptedTarget({
      config: { ...FAST_CONFIG, adoptedLossConfirmAttempts: 2 },
      probeTransport: transport,
      startManaged: managedStart(starts),
    });

    expect(outcome).toEqual({ status: "preserved", lastStatus: 503 });
    expect(starts.count).toBe(0);
    expect(readConnectionState().target).toMatchObject({
      mode: "adopted",
      origin: fake.origin,
    });
    fake.stop();
  });

  it("never asks the managed-child owner to stop an adopted process", async () => {
    const fake = startFakeOpenCode();
    const starts = await adoptFake(fake);

    let enumerations = 0;
    const unregister = registerManagedChildStopProvider({
      stopAllChildrenForShutdown: () => {
        enumerations += 1;
        return [];
      },
    });

    try {
      fake.stop();
      await revalidateAdoptedTarget({
        config: FAST_CONFIG,
        startManaged: managedStart(starts),
      });
    } finally {
      unregister();
    }

    expect(starts.count).toBe(1);
    expect(enumerations).toBe(0);
  });
});
