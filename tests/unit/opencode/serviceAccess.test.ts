import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  beginShutdown,
  installManagedTarget,
  OpenCodeNotReadyError,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";
import { LOCAL_OWNER, OpenCodeHistoryBoundaryError } from "@/services/opencode/historyBoundary.ts";
import { OpenCodeOriginMismatchError } from "@/services/opencode/http.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";
import { resolveOpenCodeServiceAccess } from "@/services/opencode/serviceAccess.ts";

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

const REMOTE_A = "https://remote-a.example.com";
const EXTERNAL_UNAVAILABLE =
  "The original external OpenCode service for this conversation is unavailable. TBAi now supports its managed OpenCode runtime only.";

function managedTarget(): void {
  installManagedTarget({ baseUrl: "http://127.0.0.1:4000", password: "synthetic-managed" });
}

describe("resolveOpenCodeServiceAccess — managed-only runtime", () => {
  it("fails closed for legacy remote-bound conversations with the specified unavailable message", async () => {
    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-remote",
        opencodeSessionId: "ses_remote",
        opencodeServiceOwner: `remote:${REMOTE_A}`,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("external_unavailable");
    expect((caught as Error).message).toBe(EXTERNAL_UNAVAILABLE);
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("fails closed for legacy remote-bound conversations even when managed runtime is installed", async () => {
    managedTarget();

    await expect(
      resolveOpenCodeServiceAccess({
        id: "conv-remote",
        opencodeSessionId: "ses_remote",
        opencodeServiceOwner: `remote:${REMOTE_A}`,
      }),
    ).rejects.toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("serves local-bound conversations from the installed managed target", async () => {
    managedTarget();

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-local",
      opencodeSessionId: "ses_local",
      opencodeServiceOwner: "local",
    });

    expect(access.owner).toEqual(LOCAL_OWNER);
    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    expect(typeof access.transport).toBe("function");
    expect(ensureBaseUrlCalls).toBe(0);
    expect(Object.isFrozen(access)).toBe(true);
  });

  it("starts the managed service for unbound conversations and publishes it", async () => {
    ensureBaseUrlImpl = async () => {
      installManagedTarget({ baseUrl: "http://127.0.0.1:4000", password: "synthetic-managed" });
      return "http://127.0.0.1:4000";
    };

    const access = await resolveOpenCodeServiceAccess({
      id: "conv-new",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    expect(access.owner).toEqual(LOCAL_OWNER);
    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    expect(ensureBaseUrlCalls).toBe(1);
  });

  it("keeps the managed fallback transport origin-bound when start publishes no target", async () => {
    const access = await resolveOpenCodeServiceAccess({
      id: "conv-new",
      opencodeSessionId: null,
      opencodeServiceOwner: null,
    });

    expect(access.owner).toEqual(LOCAL_OWNER);
    expect(access.baseUrl).toBe("http://127.0.0.1:4000");
    await expect(access.transport("http://127.0.0.1:4001/api/info")).rejects.toBeInstanceOf(
      OpenCodeOriginMismatchError,
    );
    expect(ensureBaseUrlCalls).toBe(1);
  });

  it("refuses unreadable owner keys before reaching the manager", async () => {
    let caught: unknown;
    try {
      await resolveOpenCodeServiceAccess({
        id: "conv-bad",
        opencodeSessionId: "ses_bad",
        opencodeServiceOwner: "adopted:not-a-valid-origin",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
    expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("unreadable");
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("refuses before any service work once shutdown has begun", async () => {
    await beginShutdown();

    await expect(
      resolveOpenCodeServiceAccess({
        id: "conv-local",
        opencodeSessionId: "ses_local",
        opencodeServiceOwner: "local",
      }),
    ).rejects.toBeInstanceOf(OpenCodeNotReadyError);
    expect(ensureBaseUrlCalls).toBe(0);
  });

  it("still fails closed for legacy external-bound conversations through the same access path", async () => {
    await expect(
      resolveOpenCodeServiceAccess({
        id: "conv-remote",
        opencodeSessionId: "ses_remote",
        opencodeServiceOwner: `remote:${REMOTE_A}`,
      }),
    ).rejects.toBeInstanceOf(OpenCodeHistoryBoundaryError);
  });
});
