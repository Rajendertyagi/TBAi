import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  beginShutdown,
  installManagedTarget,
  OpenCodeNotReadyError,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { OpenCodeHistoryBoundaryError } from "@/services/opencode/historyBoundary.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";
import { resolveOpenCodeServiceAccess } from "@/services/opencode/serviceAccess.ts";

type ManagerSeam = { ensureBaseUrl: () => Promise<string> };
const manager = openCodeServerManager as unknown as ManagerSeam;
const originalEnsureBaseUrl = manager.ensureBaseUrl;

let ensureBaseUrlCalls = 0;

beforeEach(() => {
  resetConnectionStateForTests();
  ensureBaseUrlCalls = 0;
  manager.ensureBaseUrl = async () => {
    ensureBaseUrlCalls += 1;
    installManagedTarget({ baseUrl: "http://127.0.0.1:4000", password: "synthetic-managed" });
    return "http://127.0.0.1:4000";
  };
});

afterAll(() => {
  manager.ensureBaseUrl = originalEnsureBaseUrl;
  resetConnectionStateForTests();
});

describe("managed-only OpenCode service continuity", () => {
  it("fails closed for legacy external-bound conversations without probing or starting managed runtime", async () => {
    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-remote",
        opencodeSessionId: "ses_remote",
        opencodeServiceOwner: "remote:https://external.example.com",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("adopted_unavailable");
    expect((caught as Error).message).toBe(
      "The original external OpenCode service for this conversation is unavailable. TBAi now supports its managed OpenCode runtime only.",
    );
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("serves local/unbound conversations through the managed runtime", async () => {
    const access = await resolveOpenCodeServiceAccess({
      id: "conv-local",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    expect(typeof access.transport).toBe("function");
    expect(ensureBaseUrlCalls).toBe(1);
  });

  it("refuses service access after shutdown", async () => {
    await beginShutdown();
    await expect(
      resolveOpenCodeServiceAccess({
        id: "conv-local",
        opencodeSessionId: "ses_local",
        opencodeServiceOwner: "local",
      }),
    ).rejects.toBeInstanceOf(OpenCodeNotReadyError);
  });
});
