import { afterEach, describe, expect, it } from "bun:test";
import {
  installManagedTarget,
  resetConnectionStateForTests,
  setShutdownStateReaderForTests,
} from "@/services/opencode/connectionState.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";
import {
  resetOpenCodeRuntimeStartupForTests,
  startOpenCodeRuntime,
  stopOpenCodeRevalidation,
} from "@/services/opencode/startup.ts";

const MANAGED_URL = "http://127.0.0.1:4096";

afterEach(() => {
  resetOpenCodeRuntimeStartupForTests();
  setShutdownStateReaderForTests(null);
  resetConnectionStateForTests();
});

describe("startOpenCodeRuntime — managed-only", () => {
  it("skips in automated test runs", async () => {
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      disabled: true,
      startManaged: async () => {
        starts += 1;
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "test_environment" });
    expect(starts).toBe(0);
  });

  it("skips after shutdown", async () => {
    setShutdownStateReaderForTests(() => ({ shutdownEpoch: 1, shutdownStarted: true }));
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      disabled: false,
      startManaged: async () => {
        starts += 1;
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "shutdown" });
    expect(starts).toBe(0);
  });

  it("starts the managed runtime when nothing is installed", async () => {
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      disabled: false,
      startManaged: async () => {
        starts += 1;
        installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({ status: "managed", reason: "managed_only", baseUrl: MANAGED_URL });
    expect(starts).toBe(1);
  });

  it("returns managed when a managed target is already installed", async () => {
    installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      disabled: false,
      startManaged: async () => {
        starts += 1;
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({ status: "managed", reason: "managed_only", baseUrl: MANAGED_URL });
    expect(starts).toBe(0);
  });

  it("refuses when managed start fails", async () => {
    const outcome = await startOpenCodeRuntime({
      disabled: false,
      startManaged: async () => {
        throw new Error("binary missing");
      },
    });

    expect(outcome).toEqual({
      status: "refused",
      reason: "managed_start_failed",
      adoptionReason: "managed_only",
    });
  });

  it("runs startup only once per process", async () => {
    let starts = 0;
    const startManaged = async () => {
      starts += 1;
      installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
      return MANAGED_URL;
    };

    const first = await startOpenCodeRuntime({ disabled: false, startManaged });
    const second = await startOpenCodeRuntime({ disabled: false, startManaged });

    expect(first).toEqual(second);
    expect(starts).toBe(1);
  });

  it("ignores obsolete external runtime env vars for selection and still starts managed runtime", async () => {
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      disabled: false,
      env: {
        NODE_ENV: "development",
        OPENCODE_URL: "http://127.0.0.1:9999",
        OPENCODE_HOST: "127.0.0.1",
        OPENCODE_PORT: "9999",
      },
      startManaged: async () => {
        starts += 1;
        installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({ status: "managed", reason: "managed_only", baseUrl: MANAGED_URL });
    expect(starts).toBe(1);
  });
});

describe("revalidation compatibility no-ops", () => {
  it("stop remains a compatibility no-op", () => {
    expect(stopOpenCodeRevalidation()).toBe(false);
  });
});
