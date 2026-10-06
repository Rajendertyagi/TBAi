/**
 * RUNTIME proof that TBAi can actually authenticate to, and drive, a real
 * OpenCode server.
 *
 * ## The failure this pins
 *
 * OpenCode 2.0.22 reads `OPENCODE_PASSWORD` first and only falls back to
 * `OPENCODE_SERVER_PASSWORD`. TBAi's `createChild` inherits `...process.env`, so
 * in any process that already exports its own `OPENCODE_PASSWORD` the child
 * inherited THAT value while TBAi's client sent its own generated one. The
 * server authenticated a different credential than the client presented and
 * answered 401 to everything, including its own readiness probe, so the managed
 * server could never start.
 *
 * Every pre-existing test injected a FAKE binary and asserted against the same
 * production constant, so the whole suite passed while the feature was broken
 * against a real build. These tests close that hole: they spawn the actual
 * binary and use the actual child environment.
 *
 * Skipped unless `TBAI_OPENCODE_RUNTIME_TESTS=1`. See the harness for gating.
 */
import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { OPENCODE_CONFIG } from "../../src/config/opencode";
import {
  runtimeAuthHeaders,
  runtimeChildEnv,
  runtimeTestsRequested,
  runtimeUnavailableReason,
  startRuntimeOpenCodeServer,
  type RuntimeOpenCodeServer,
} from "../harness/opencodeRuntimeHarness";

const reason = runtimeUnavailableReason();
const describeRuntime = runtimeTestsRequested() ? describe : describe.skip;

if (runtimeTestsRequested() && reason) {
  console.warn(`[opencode runtime] enabled but unavailable: ${reason}`);
}

describeRuntime("real OpenCode: the spawned credential is accepted", () => {
  let server: RuntimeOpenCodeServer;

  beforeAll(async () => {
    server = await startRuntimeOpenCodeServer();
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("answers its own readiness probe with 200, not 401", async () => {
    // This IS the bug. Before the fix this returned 401 and startup failed.
    const info = await server.json<{ version: string; pid: number }>("/api/info");
    expect(typeof info.version).toBe("string");
    expect(info.pid).toBeGreaterThan(0);
  });

  it("reports a version inside the managed range", async () => {
    const info = await server.json<{ version: string }>("/api/info");
    const [major, minor, patch] = info.version.split(".").map(Number);
    expect(major).toBe(2);
    expect(minor).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThanOrEqual(0);
  });

  it("rejects an unauthenticated request, so auth is not merely absent", async () => {
    // Proves the server is genuinely protected rather than open. Without this,
    // "we got a 200" would be ambiguous between correct auth and disabled auth.
    const res = await fetch(`${server.baseUrl}/api/info`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong password with the same 401", async () => {
    const res = await fetch(`${server.baseUrl}/api/info`, {
      headers: runtimeAuthHeaders("not-the-password"),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(401);
  });

  it("publishes its provider catalogue for the model-limit check", async () => {
    // The catalogue is what `model.limit.context` is read from, so its presence
    // is the precondition for the limit-propagation runtime evidence.
    const providers = await server.json<unknown>("/api/provider");
    expect(providers).toBeDefined();
  });

  it("supports session creation, the entry point for every Code turn", async () => {
    const created = await server.json<{ id?: string; info?: unknown }>("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // An id is what a Code session binds to for reload/resume.
    if (created && typeof created === "object" && "id" in created) {
      expect(typeof created.id).toBe("string");
    }
  });
});

describe("OpenCode auth env: both names are sent to the child", () => {
  it("includes the name 2.0.22 reads", () => {
    const env = runtimeChildEnv("pw");
    expect(env.OPENCODE_PASSWORD).toBe("pw");
  });

  it("still includes the legacy name for in-range 2.0.x builds", () => {
    // TBAi pins a version RANGE, so a 2.0.15-2.0.21 install must keep working.
    const env = runtimeChildEnv("pw");
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("pw");
  });

  it("sends the same credential under both names", () => {
    const env = runtimeChildEnv("shared-secret");
    expect(env.OPENCODE_PASSWORD).toBe(env.OPENCODE_SERVER_PASSWORD);
  });

  it("names exactly the configured vars, so the list cannot drift from config", () => {
    expect(runtimeChildEnv("pw")).toEqual(
      Object.fromEntries(OPENCODE_CONFIG.authPasswordChildEnvVars.map((n) => [n, "pw"])),
    );
  });

  it("sends the name OpenCode reads FIRST, so an inherited ambient value cannot win", () => {
    // This is the whole bug in one assertion. `createChild` spreads
    // `...process.env` before the auth vars, so if the name OpenCode consults
    // first were missing from the overlay, an ambient value from the parent
    // process would authenticate the server while TBAi's client sent a
    // different credential - a 401 on every request including the readiness
    // probe. Measured against 2.0.22: the current name wins over the legacy one.
    expect(runtimeChildEnv("pw")[OPENCODE_CONFIG.authPasswordEnvVar]).toBe("pw");
  });

  it("the legacy name is still honoured as an override source", async () => {
    // An operator on an older build may have the old var set; dropping it would
    // break them silently.
    const { getOpenCodeAuthPassword } = await import("../../src/services/opencode/runtime");
    const saved = {
      current: process.env.OPENCODE_PASSWORD,
      legacy: process.env.OPENCODE_SERVER_PASSWORD,
    };
    try {
      delete process.env.OPENCODE_PASSWORD;
      process.env.OPENCODE_SERVER_PASSWORD = "legacy-only-value";
      const module = await import(`../../src/services/opencode/runtime?legacy=${Date.now()}`);
      expect(module.getOpenCodeAuthPassword(OPENCODE_CONFIG)).toBe("legacy-only-value");
    } finally {
      if (saved.current === undefined) delete process.env.OPENCODE_PASSWORD;
      else process.env.OPENCODE_PASSWORD = saved.current;
      if (saved.legacy === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
      else process.env.OPENCODE_SERVER_PASSWORD = saved.legacy;
      void getOpenCodeAuthPassword;
    }
  });
});

/**
 * The ambient-environment collision, against the real binary.
 *
 * Every other auth test here starts from a parent process that happens to have
 * no `OPENCODE_PASSWORD` of its own, so it cannot see the bug. These two start
 * from a parent that DOES, which is the situation TBAi is in whenever it is
 * launched from inside another OpenCode server or a terminal that one spawned.
 */
describeRuntime("real OpenCode: an inherited ambient credential cannot win", () => {
  it("authenticates TBAi's credential even when the parent exports a different one", async () => {
    const ambient = "ambient-password-from-the-parent-process";
    const saved = process.env.OPENCODE_PASSWORD;
    process.env.OPENCODE_PASSWORD = ambient;
    let server: RuntimeOpenCodeServer;
    try {
      server = await startRuntimeOpenCodeServer();
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_PASSWORD;
      else process.env.OPENCODE_PASSWORD = saved;
    }
    try {
      // The spawned server must accept what TBAi's client sends. Before the fix
      // this was a 401 and startup never completed.
      const info = await server.json<{ version: string }>("/api/info");
      expect(typeof info.version).toBe("string");

      // And it must NOT accept the ambient value, proving the overlay replaced
      // the inherited one rather than the child simply having no auth at all.
      const res = await fetch(`${server.baseUrl}/api/info`, {
        headers: runtimeAuthHeaders(ambient),
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.stop();
    }
  }, 120_000);

  it("reads OPENCODE_PASSWORD ahead of the legacy name", async () => {
    // Documents the precedence rule the fix depends on, and pins WHY the two
    // names must be set to one value: when they disagree, the server follows
    // the current name. Reproducing the disagreement is exactly what the old
    // code did by accident, so this asserts the resulting 401 directly.
    const server = await startRuntimeOpenCodeServer(
      OPENCODE_CONFIG,
      { OPENCODE_PASSWORD: "someone-elses-password" },
      { requireAuthenticated: false },
    );
    try {
      const res = await fetch(`${server.baseUrl}/api/info`, {
        headers: runtimeAuthHeaders("tbai-opencode-runtime-fixture"),
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(401);

      const winner = await fetch(`${server.baseUrl}/api/info`, {
        headers: runtimeAuthHeaders("someone-elses-password"),
        signal: AbortSignal.timeout(5000),
      });
      expect(winner.status).toBe(200);
    } finally {
      await server.stop();
    }
  }, 120_000);
});