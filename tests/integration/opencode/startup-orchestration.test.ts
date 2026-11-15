import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import {
  beginShutdown,
  installManagedTarget,
  readConnectionState,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { getOpenCodeAuthPassword } from "@/services/opencode/runtime.ts";
import {
  isOpenCodeRevalidationRunning,
  resetOpenCodeRuntimeStartupForTests,
  startOpenCodeRuntime,
} from "@/services/opencode/startup.ts";

const MANAGED_URL = "http://127.0.0.1:4799";

beforeEach(() => {
  resetConnectionStateForTests();
  resetOpenCodeRuntimeStartupForTests();
});

afterEach(() => {
  resetOpenCodeRuntimeStartupForTests();
  resetConnectionStateForTests();
});

describe("managed-only startup", () => {
  it("starts the managed runtime and installs the managed target", async () => {
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      config: OPENCODE_CONFIG,
      disabled: false,
      startManaged: async () => {
        starts += 1;
        installManagedTarget({ baseUrl: MANAGED_URL, password: getOpenCodeAuthPassword() });
        return MANAGED_URL;
      },
    });

    expect(outcome).toEqual({ status: "managed", reason: "managed_only", baseUrl: MANAGED_URL });
    expect(starts).toBe(1);
    expect(readConnectionState().target).toMatchObject({ mode: "managed", baseUrl: MANAGED_URL });
    expect(isOpenCodeRevalidationRunning()).toBe(false);
  });

  it("reports managed start failure without installing a target", async () => {
    const outcome = await startOpenCodeRuntime({
      config: OPENCODE_CONFIG,
      disabled: false,
      startManaged: async () => {
        throw new Error("managed binary missing");
      },
    });

    expect(outcome).toEqual({
      status: "refused",
      reason: "managed_start_failed",
      adoptionReason: "managed_only",
    });
    expect(readConnectionState().target.mode).toBe("unresolved");
  });

  it("skips when shutdown has begun", async () => {
    await beginShutdown();
    const outcome = await startOpenCodeRuntime({
      config: OPENCODE_CONFIG,
      disabled: false,
      startManaged: async () => MANAGED_URL,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "shutdown" });
  });

  it("ignores obsolete external runtime env vars for selection and still starts managed", async () => {
    let starts = 0;
    const outcome = await startOpenCodeRuntime({
      config: OPENCODE_CONFIG,
      disabled: false,
      env: {
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
    expect(readConnectionState().target).toMatchObject({ mode: "managed", baseUrl: MANAGED_URL });
  });
});
