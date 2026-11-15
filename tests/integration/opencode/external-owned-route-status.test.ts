import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import openCodeApp from "@/routes/opencode.ts";
import { conversationService } from "@/services/storage/conversations.ts";
import { resetConnectionStateForTests } from "@/services/opencode/connectionState.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";

const EXTERNAL_UNAVAILABLE_MESSAGE =
  "The original external OpenCode service for this conversation is unavailable. TBAi now supports its managed OpenCode runtime only.";

type ManagerSeam = { ensureBaseUrl: () => Promise<string> };
const manager = openCodeServerManager as unknown as ManagerSeam;
const originalEnsureBaseUrl = manager.ensureBaseUrl;
const realFetch = globalThis.fetch;

let ensureBaseUrlCalls = 0;
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function stubFetch(): void {
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init });
    return new Response("unexpected fetch", { status: 599 });
  };
  globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
}

let seq = 0;

async function createExternalOwnedConversation(): Promise<string> {
  seq += 1;
  const conv = await conversationService.create({
    title: "external-owned",
    engine: "opencode",
    providerId: null,
    workspaceMode: "simple",
    opencodeSessionId: `ses_external_legacy_${seq}`,
    opencodeServiceOwner: "remote:https://external.example.com",
  });
  return conv.id;
}

async function expectUnavailable503(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  const body = (await response.json()) as { error?: string };
  expect(body.error).toBe(EXTERNAL_UNAVAILABLE_MESSAGE);
}

beforeEach(() => {
  resetConnectionStateForTests();
  ensureBaseUrlCalls = 0;
  fetchCalls = [];
  manager.ensureBaseUrl = async () => {
    ensureBaseUrlCalls += 1;
    return "http://127.0.0.1:4096";
  };
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetConnectionStateForTests();
});

afterAll(() => {
  manager.ensureBaseUrl = originalEnsureBaseUrl;
  globalThis.fetch = realFetch;
  resetConnectionStateForTests();
});

describe("external-owned OpenCode conversation routes (managed-only)", () => {
  it("POST /session returns 503 without starting managed runtime or probing services", async () => {
    const conversationId = await createExternalOwnedConversation();
    const before = await conversationService.get(conversationId);

    const response = await openCodeApp.request("http://localhost/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });

    await expectUnavailable503(response);
    expect(ensureBaseUrlCalls).toBe(0);
    expect(fetchCalls).toEqual([]);

    const after = await conversationService.get(conversationId);
    expect(after?.opencodeSessionId).toBe(before?.opencodeSessionId);
    expect(after?.opencodeServiceOwner).toBe("remote:https://external.example.com");
  });

  it("POST /session/reconcile-directory returns 503 without side effects", async () => {
    const conversationId = await createExternalOwnedConversation();
    const before = await conversationService.get(conversationId);

    const response = await openCodeApp.request("http://localhost/session/reconcile-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });

    await expectUnavailable503(response);
    expect(ensureBaseUrlCalls).toBe(0);
    expect(fetchCalls).toEqual([]);

    const after = await conversationService.get(conversationId);
    expect(after?.opencodeSessionId).toBe(before?.opencodeSessionId);
    expect(after?.opencodeServiceOwner).toBe("remote:https://external.example.com");
  });

  it("POST /session/terminate returns 503 without mutating ownership or probing services", async () => {
    const conversationId = await createExternalOwnedConversation();
    const before = await conversationService.get(conversationId);

    const response = await openCodeApp.request("http://localhost/session/terminate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });

    await expectUnavailable503(response);
    expect(ensureBaseUrlCalls).toBe(0);
    expect(fetchCalls).toEqual([]);

    const after = await conversationService.get(conversationId);
    expect(after?.opencodeSessionId).toBe(before?.opencodeSessionId);
    expect(after?.opencodeServiceOwner).toBe("remote:https://external.example.com");
  });

  it("POST /session/activity returns 503 without probing the managed or external service", async () => {
    const conversationId = await createExternalOwnedConversation();
    const before = await conversationService.get(conversationId);

    const response = await openCodeApp.request("http://localhost/session/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, sessionId: before?.opencodeSessionId }),
    });

    await expectUnavailable503(response);
    expect(ensureBaseUrlCalls).toBe(0);
    expect(fetchCalls).toEqual([]);

    const after = await conversationService.get(conversationId);
    expect(after?.opencodeSessionId).toBe(before?.opencodeSessionId);
    expect(after?.opencodeServiceOwner).toBe("remote:https://external.example.com");
  });
});
