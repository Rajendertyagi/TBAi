import { describe, it, expect } from "bun:test";

type ThreadIdentityState = {
  readonly custom?: { readonly conversationId?: unknown } | null;
  readonly remoteId?: unknown;
  readonly id?: unknown;
};

type ResolveConversationId = (state: ThreadIdentityState) => string | null;

async function resolveConversationId(
  state: ThreadIdentityState,
): Promise<string | null> {
  const module = await import("./thread-conversation-id");
  const resolve = module.resolveThreadConversationId as ResolveConversationId;
  return resolve(state);
}

describe("resolveThreadConversationId", () => {
  it("prefers custom.conversationId over remoteId and id", async () => {
    expect(
      await resolveConversationId({
        custom: { conversationId: "conv-custom" },
        remoteId: "remote-session",
        id: "local-thread",
      }),
    ).toBe("conv-custom");
  });

  it("falls back to remoteId when custom conversation identity is absent", async () => {
    expect(
      await resolveConversationId({
        custom: {},
        remoteId: "remote-session",
        id: "local-thread",
      }),
    ).toBe("remote-session");
  });

  it("falls back to id when custom and remote identities are absent", async () => {
    expect(
      await resolveConversationId({
        id: "local-thread",
      }),
    ).toBe("local-thread");
  });

  it("rejects empty, whitespace, and non-string identity values", async () => {
    expect(await resolveConversationId({ custom: { conversationId: "" } })).toBeNull();
    expect(await resolveConversationId({ remoteId: "   " })).toBeNull();
    expect(await resolveConversationId({ id: 42 })).toBeNull();
  });
});
