import { describe, it, expect, mock } from "bun:test";
import {
  renameConversation,
  setConversationStatus,
} from "./conversationMutations";
import { deleteConversation } from "./deleteConversation";

describe("Conversation Mutations Domain Module", () => {
  it("renameConversation sends PATCH /api/conversations/:id with title", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return { ok: true, json: async () => ({}) } as Response;
    }) as any;

    await renameConversation("c123", "New Title");

    expect(capturedUrl).toContain("/api/conversations/c123");
    expect(capturedBody).toEqual({ title: "New Title" });

    globalThis.fetch = originalFetch;
  });

  it("renameConversation throws error on empty title", async () => {
    expect(renameConversation("c123", "   ")).rejects.toThrow("Title cannot be empty");
  });

  it("setConversationStatus sends PATCH with status", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return { ok: true, json: async () => ({}) } as Response;
    }) as any;

    await setConversationStatus("c123", "archived");
    expect(capturedUrl).toContain("/api/conversations/c123");
    expect(capturedBody).toEqual({ status: "archived" });

    await setConversationStatus("c123", "regular");
    expect(capturedBody).toEqual({ status: "regular" });

    globalThis.fetch = originalFetch;
  });

  it("deleteConversation performs server teardown and DELETE", async () => {
    const calls: string[] = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const u = url.toString();
      calls.push(u);
      return { ok: true, json: async () => ({ terminated: true }) } as Response;
    }) as any;

    const res = await deleteConversation("c999");
    expect(res.conversationId).toBe("c999");
    expect(calls.some((u) => u.includes("/api/opencode/session/terminate"))).toBe(true);
    expect(calls.some((u) => u.includes("/api/conversations/c999"))).toBe(true);

    globalThis.fetch = originalFetch;
  });
});
