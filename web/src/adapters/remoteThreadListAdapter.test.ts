import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createRemoteThreadListAdapter } from "./remoteThreadListAdapter";
import { useWelcomeScopeStore } from "../features/chat/state/welcomeScope";

const realFetch = globalThis.fetch;

function stubFetch(
  handler: (url: string, init?: RequestInit) => unknown,
): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const result = handler(String(url), init) as {
      ok?: boolean;
      json?: () => Promise<unknown>;
    };
    if (result !== null && typeof result === "object" && "ok" in result) {
      return result as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => result,
    } as Response;
  }) as typeof fetch;
}

function failure(status: number, error: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error }),
  } as Response;
}

describe("adapter initialize() failure contract", () => {
  beforeEach(() => {
    useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("resolves remoteId on success", async () => {
    stubFetch(() => ({ id: "c1" }));
    const adapter = createRemoteThreadListAdapter();
    await expect(adapter.initialize('__LOCALID_test')).resolves.toEqual({ remoteId: "c1" });
  });

  it("POST /api/conversations failure → initialize rejects (never undefined remoteId)", async () => {
    stubFetch((url) => {
      if (String(url).endsWith("/api/conversations")) {
        return failure(500, "CHECK constraint failed");
      }
      return {};
    });
    const adapter = createRemoteThreadListAdapter();
    let thrown: unknown;
    try {
      await adapter.initialize('__LOCALID_test');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Original backend error stays visible (not masked as conversation_missing).
    expect(String((thrown as Error).message)).toContain("CHECK constraint failed");
  });

  it("project fallback failure → initialize rejects", async () => {
    useWelcomeScopeStore
      .getState()
      .setScope({ mode: "project", folderId: "gone" });
    stubFetch((url) => {
      if (String(url).endsWith("/api/conversations")) {
        return failure(400, "workspaceFolderId is required for project chats");
      }
      return {};
    });
    const adapter = createRemoteThreadListAdapter();
    let thrown: unknown;
    try {
      await adapter.initialize('__LOCALID_test');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});

