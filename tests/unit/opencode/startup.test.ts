import { afterEach, describe, expect, it } from "bun:test";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import type { AdoptionAttemptOutcome } from "@/services/opencode/adoption.ts";
import {
  installAdoptedTarget,
  installManagedTarget,
  resetConnectionStateForTests,
  setShutdownStateReaderForTests,
} from "@/services/opencode/connectionState.ts";
import type { OpenCodeServiceCapabilities } from "@/services/opencode/compatibility.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";
import {
  isOpenCodeRevalidationRunning,
  resetOpenCodeRuntimeStartupForTests,
  startOpenCodeRevalidation,
  startOpenCodeRuntime,
  stopOpenCodeRevalidation,
} from "@/services/opencode/startup.ts";

/**
 * Adopt-first startup and the revalidation loop (H5/B2, D3).
 *
 * The attempt is injected, so these tests never read a registration file and
 * never probe a service: what they pin is the ORDER (adopt, then — only when
 * adoption did not supply a service — start the managed child eagerly) and the
 * loop's lifetime. The managed start is injected too, so no case spawns a
 * process.
 */

const MANAGED_URL = "http://127.0.0.1:4096";
const ADOPTED_ORIGIN = "http://127.0.0.1:5055";

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

/**
 * LOOP_CONFIG is only used where no tick may fire: a short interval with a
 * real adopted target would probe a fake origin. The tick's own behaviour is
 * driven through the injected seam instead.
 */
const LOOP_CONFIG = { ...OPENCODE_CONFIG, adoptionRevalidateIntervalMs: 60_000 };
const TICK_CONFIG = { ...OPENCODE_CONFIG, adoptionRevalidateIntervalMs: 5 };

const ADOPTED: AdoptionAttemptOutcome = {
  status: "adopted",
  registration: {
    path: "C:\\synthetic\\service.json",
    origin: ADOPTED_ORIGIN,
    pid: 4242,
    password: "synthetic-adopted-password",
    version: "2.2.0",
  },
  capabilities: CAPABILITIES,
};

afterEach(() => {
  resetOpenCodeRuntimeStartupForTests();
  setShutdownStateReaderForTests(null);
  resetConnectionStateForTests();
});

describe("startOpenCodeRuntime", () => {
  it("does nothing in an automated test run", async () => {
    let attempts = 0;
    const outcome = await startOpenCodeRuntime({
      disabled: true,
      adopt: async () => {
        attempts += 1;
        return ADOPTED;
      },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "test_environment" });
    expect(attempts).toBe(0);
  });

  it("does nothing after shutdown", async () => {
    setShutdownStateReaderForTests(() => ({ shutdownEpoch: 1, shutdownStarted: true }));
    let attempts = 0;
    const outcome = await startOpenCodeRuntime({
      disabled: false,
      adopt: async () => {
        attempts += 1;
        return ADOPTED;
      },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "shutdown" });
    expect(attempts).toBe(0);
  });

  it("adopts an eligible service and starts revalidation", async () => {
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      adopt: async () => {
        installAdoptedTarget({
          origin: ADOPTED_ORIGIN,
          password: "synthetic-adopted-password",
          capabilities: CAPABILITIES,
        });
        return ADOPTED;
      },
    });

    expect(outcome.status).toBe("adopted");
    if (outcome.status !== "adopted") throw new Error("expected an adopted outcome");
    // The optional capability this build is missing is reported, not fatal.
    expect(outcome.optionalMissing).toEqual(["config"]);
    expect(isOpenCodeRevalidationRunning()).toBe(true);
  });

  it("starts the managed service eagerly when no candidate is eligible", async () => {
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      adopt: async () => ({ status: "refused", reason: "registration_missing" }),
      startManaged: async () => {
        starts += 1;
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({
      status: "managed",
      reason: "registration_missing",
      baseUrl: MANAGED_URL,
    });
    expect(starts).toBe(1);
    expect(isOpenCodeRevalidationRunning()).toBe(false);
  });

  it("starts the managed service when an essential capability is missing", async () => {
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      adopt: async () => ({ status: "refused", reason: "probe_capability_missing" }),
      startManaged: async () => MANAGED_URL,
    });

    expect(outcome).toEqual({
      status: "managed",
      reason: "probe_capability_missing",
      baseUrl: MANAGED_URL,
    });
  });

  it("starts the managed service after an unexpected adoption failure", async () => {
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      adopt: async () => {
        throw new Error("synthetic adoption defect");
      },
      startManaged: async () => MANAGED_URL,
    });

    expect(outcome).toEqual({ status: "managed", reason: "adoption_failed", baseUrl: MANAGED_URL });
  });

  it("reports a failed managed start instead of waiting for a request", async () => {
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      adopt: async () => ({ status: "refused", reason: "registration_missing" }),
      startManaged: async () => {
        throw new Error("managed binary missing");
      },
    });

    expect(outcome).toEqual({
      status: "refused",
      reason: "managed_start_failed",
      adoptionReason: "registration_missing",
    });
  });

  it("fails closed without calling startManaged when explicit server endpoint is configured and adoption is refused", async () => {
    let managedStarts = 0;
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      env: { OPENCODE_URL: "http://127.0.0.1:56873", OPENCODE_PASSWORD: "secret-password" },
      adopt: async () => ({ status: "refused", reason: "probe_failed" }),
      startManaged: async () => {
        managedStarts += 1;
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({
      status: "refused",
      reason: "managed_start_failed",
      adoptionReason: "probe_failed",
    });
    expect(managedStarts).toBe(0);
  });

  it("fails closed without calling startManaged when explicit server adoption throws", async () => {
    let managedStarts = 0;
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      env: { OPENCODE_PORT: "56873", OPENCODE_PASSWORD: "secret-password" },
      adopt: async () => {
        throw new Error("network connection refused");
      },
      startManaged: async () => {
        managedStarts += 1;
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({
      status: "refused",
      reason: "managed_start_failed",
      adoptionReason: "adoption_failed",
    });
    expect(managedStarts).toBe(0);
  });

  it("starts nothing when shutdown lands during the attempt", async () => {
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      adopt: async () => ({ status: "refused", reason: "shutdown" }),
      startManaged: async () => {
        starts += 1;
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "shutdown" });
    expect(starts).toBe(0);
  });

  it("starts nothing when another attempt superseded this one", async () => {
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      adopt: async () => ({ status: "refused", reason: "attempt_superseded" }),
      startManaged: async () => {
        starts += 1;
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "superseded" });
    expect(starts).toBe(0);
  });

  it("starts nothing when shutdown lands during the managed start", async () => {
    let started = false;
    setShutdownStateReaderForTests(() => ({
      shutdownEpoch: started ? 1 : 0,
      shutdownStarted: started,
    }));
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      adopt: async () => ({ status: "refused", reason: "registration_missing" }),
      startManaged: async () => {
        starts += 1;
        started = true;
        return MANAGED_URL;
      },
    });

    // The start was requested; the shutdown that lands while it runs is
    // reported instead of a managed outcome the process can no longer honour.
    expect(starts).toBe(1);
    expect(outcome).toEqual({ status: "skipped", reason: "shutdown" });
  });

  it("runs the attempt once even when two callers race", async () => {
    let attempts = 0;
    let starts = 0;
    const adopt = async (): Promise<AdoptionAttemptOutcome> => {
      attempts += 1;
      return { status: "refused", reason: "registration_missing" };
    };
    const options = {
      config: LOOP_CONFIG,
      disabled: false,
      adopt,
      startManaged: async () => {
        starts += 1;
        return MANAGED_URL;
      },
    };

    const [first, second] = await Promise.all([
      startOpenCodeRuntime(options),
      startOpenCodeRuntime(options),
    ]);

    expect(attempts).toBe(1);
    expect(starts).toBe(1);
    expect(first).toBe(second);
    expect(first).toEqual({
      status: "managed",
      reason: "registration_missing",
      baseUrl: MANAGED_URL,
    });
  });

  it("does not adopt over an installed target, and watches an adopted one", async () => {
    installAdoptedTarget({ origin: ADOPTED_ORIGIN, password: "synthetic-adopted-password" });
    let attempts = 0;
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      adopt: async () => {
        attempts += 1;
        return ADOPTED;
      },
      startManaged: async () => {
        starts += 1;
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "already_installed" });
    expect(attempts).toBe(0);
    expect(starts).toBe(0);
    expect(isOpenCodeRevalidationRunning()).toBe(true);
  });

  it("does not start a loop for an installed managed target", async () => {
    installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      config: LOOP_CONFIG,
      disabled: false,
      adopt: async () => ADOPTED,
      startManaged: async () => {
        starts += 1;
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "already_installed" });
    expect(starts).toBe(0);
    expect(isOpenCodeRevalidationRunning()).toBe(false);
  });
});

describe("the revalidation loop", () => {
  it("is idempotent", () => {
    installAdoptedTarget({ origin: ADOPTED_ORIGIN, password: "synthetic-adopted-password" });
    startOpenCodeRevalidation(LOOP_CONFIG);
    startOpenCodeRevalidation(LOOP_CONFIG);
    expect(stopOpenCodeRevalidation()).toBe(true);
    expect(stopOpenCodeRevalidation()).toBe(false);
  });

  it("is not started for a managed target", () => {
    installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
    startOpenCodeRevalidation(LOOP_CONFIG);
    expect(isOpenCodeRevalidationRunning()).toBe(false);
  });

  it("stops itself once the target is no longer adopted", async () => {
    installAdoptedTarget({ origin: ADOPTED_ORIGIN, password: "synthetic-adopted-password" });
    let probes = 0;
    startOpenCodeRevalidation(TICK_CONFIG, {
      revalidate: async () => {
        probes += 1;
        return { status: "preserved", lastStatus: 200 };
      },
    });
    expect(isOpenCodeRevalidationRunning()).toBe(true);

    // The target becomes managed (a confirmed-loss fallback does exactly this).
    // The check runs synchronously before the first await, so the very first
    // tick must stop the loop WITHOUT probing.
    installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(isOpenCodeRevalidationRunning()).toBe(false);
    expect(probes).toBe(0);
  });

  it("keeps watching while the service answers", async () => {
    installAdoptedTarget({ origin: ADOPTED_ORIGIN, password: "synthetic-adopted-password" });
    let probes = 0;
    startOpenCodeRevalidation(TICK_CONFIG, {
      revalidate: async () => {
        probes += 1;
        return { status: "preserved", lastStatus: 200 };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(probes).toBeGreaterThan(0);
    expect(isOpenCodeRevalidationRunning()).toBe(true);
  });

  it("stops after a confirmed-loss fallback", async () => {
    installAdoptedTarget({ origin: ADOPTED_ORIGIN, password: "synthetic-adopted-password" });
    let probes = 0;
    startOpenCodeRevalidation(TICK_CONFIG, {
      revalidate: async () => {
        probes += 1;
        return { status: "fallback", managedBaseUrl: MANAGED_URL };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(probes).toBeGreaterThan(0);
    expect(isOpenCodeRevalidationRunning()).toBe(false);
  });

  it("stops when a tick is refused by shutdown", async () => {
    installAdoptedTarget({ origin: ADOPTED_ORIGIN, password: "synthetic-adopted-password" });
    startOpenCodeRevalidation(TICK_CONFIG, {
      revalidate: async () => ({ status: "refused", reason: "shutdown" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(isOpenCodeRevalidationRunning()).toBe(false);
  });
});
