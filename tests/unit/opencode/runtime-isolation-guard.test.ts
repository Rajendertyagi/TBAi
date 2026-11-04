import { describe, expect, it } from "bun:test";
import {
  assertTestDatabaseIsolation,
  createRuntimeIsolation,
  isolatedChildEnv,
} from "../../harness/opencodeRuntimeHarness";

describe("OpenCode runtime test database isolation guards", () => {
  it("provisions an isolated xdgDataHome and dataDir inside the disposable tree", () => {
    const isolation = createRuntimeIsolation("guard-test");
    expect(isolation.xdgDataHome).toBeDefined();
    expect(isolation.dataDir).toBeDefined();
    expect(isolation.dataDir).toContain(isolation.root);
    expect(isolation.xdgDataHome).toContain(isolation.root);
  });

  it("exports XDG_DATA_HOME in isolatedChildEnv", () => {
    const isolation = createRuntimeIsolation("env-test");
    const env = isolatedChildEnv(isolation);
    expect(env.XDG_DATA_HOME).toBe(isolation.xdgDataHome);
  });

  it("assertTestDatabaseIsolation throws if preflight resolves to production database", () => {
    // If the preflight resolves to production, assertTestDatabaseIsolation MUST throw.
    // An empty env inherits the developer's normal environment, so the preflight
    // resolves to the production database wherever it lives on this machine
    // (a global XDG_DATA_HOME relocates it).
    const binary = "opencode";
    let thrown = false;
    try {
      assertTestDatabaseIsolation(binary, {});
    } catch (err: any) {
      thrown = true;
      expect(err.message).toContain("FATAL TEST GUARD");
      expect(err.message).toContain("Test isolation violated");
    }
    expect(thrown).toBe(true);
  });

  it("assertTestDatabaseIsolation succeeds when XDG_DATA_HOME points to an isolated temp path", () => {
    const isolation = createRuntimeIsolation("safe-preflight");
    const binary = "opencode";
    expect(() => {
      assertTestDatabaseIsolation(binary, { XDG_DATA_HOME: isolation.xdgDataHome });
    }).not.toThrow();
  });
});
