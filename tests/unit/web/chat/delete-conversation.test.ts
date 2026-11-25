import { describe, expect, it, mock, beforeEach } from "bun:test";

type FetchCall = { input: string; init?: RequestInit };
const calls: FetchCall[] = [];

const platformMock = {
  apiFetch: async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ success: true, deleted: true }), { status: 200 });
  },
  resolveApiUrl: (path: string) => `http://localhost${path}`,
};

mock.module("@/lib/platform", () => platformMock);
mock.module("@web/lib/platform", () => platformMock);
mock.module("@/features/preferences/state/preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ closeSharedTab: async () => undefined }) },
}));
mock.module("@web/features/preferences/state/preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ closeSharedTab: async () => undefined }) },
}));
mock.module("@/features/chat/state/chatTabs", () => ({
  useChatTabsStore: { getState: () => ({ closeLocal: () => undefined }) },
}));
mock.module("@web/features/chat/state/chatTabs", () => ({
  useChatTabsStore: { getState: () => ({ closeLocal: () => undefined }) },
}));
mock.module("@/features/chat/state/resumable-stream", () => ({
  readDirectResumableStreamId: () => null,
}));
mock.module("@web/features/chat/state/resumable-stream", () => ({
  readDirectResumableStreamId: () => null,
}));

const { deleteConversation } = await import("@web/features/chat/state/deleteConversation.ts");

describe("deleteConversation — local-only teardown", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("issues only the local conversation DELETE, with no OpenCode terminate request", async () => {
    const result = await deleteConversation("conv-1");

    expect(calls.map((call) => call.input)).toEqual(["/api/conversations/conv-1"]);
    expect(calls[0]?.init?.method).toBe("DELETE");
    expect(result).toEqual({ conversationId: "conv-1", runCancelled: false });
  });
});
