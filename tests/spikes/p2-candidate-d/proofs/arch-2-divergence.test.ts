/**
 * SPIKE — ARCHITECTURE PROBE: rendered repository vs AI SDK submission.
 * TEMPORARY, removable.
 *
 * THE decisive question for the store choice. The submission payload comes
 * from `chat.messages` (via the transport). The rendered messages come from
 * the store (`messages` or `messageRepository`). Can these two diverge
 * usefully — e.g. a bounded rendered window over a FULL authoritative Chat?
 *
 * If they can, the submission head is always the chain tip and the
 * tip-containment problem changes shape. If they cannot, the window and the
 * submission are the same object, as the approved contract states.
 *
 * Real installed stack: `@assistant-ui/core@0.3.24`, `@ai-sdk/react@4.0.131`,
 * `ai@7.0.93`, `@assistant-ui/ai-sdk@0.0.11`.
 */

import { describe, expect, it } from "bun:test";
import { AssistantChatTransport } from "@assistant-ui/ai-sdk";
import {
  Chat,
  ExternalStoreThreadRuntimeCore,
  ExportedMessageRepository,
  sliceMessagesUntil,
  toCreateMessage,
} from "../../../helpers/dom/resolve.ts";

const contextProvider = {
  getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
  registerModelContextProvider: () => () => {},
} as never;

type AiMsg = { id: string; role: "user" | "assistant"; parts: Array<{ type: "text"; text: string }> };
const ai = (id: string, role: "user" | "assistant"): AiMsg => ({
  id,
  role,
  parts: [{ type: "text", text: `body ${id}` }],
});
const chain = (from: number, to: number): AiMsg[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ai(`m${from + i}`, (from + i) % 2 === 1 ? "user" : "assistant"));

const threadLike = (m: AiMsg) => ({
  id: m.id,
  role: m.role,
  content: m.parts.map((p) => ({ type: "text" as const, text: p.text })),
  // `status` is only valid on assistant messages.
  ...(m.role === "assistant" ? { status: { type: "complete" as const } } : {}),
  metadata: { unstable_state: null },
  createdAt: new Date(0),
});

function makeTransport(submissions: Array<{ ids: string[] }>) {
  return new AssistantChatTransport({
    api: "/api/chat",
    fetch: (async (_u: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      submissions.push({ ids: (body.messages ?? []).map((m: { id: string }) => m.id) });
      return new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch,
  });
}

describe("rendered repository vs AI SDK submission", () => {
  it("submission comes from chat.messages, NOT the repository — they CAN diverge", async () => {
    const submissions: Array<{ ids: string[] }> = [];

    // The Chat holds the FULL authoritative chain.
    const chat = new Chat<never>({
      id: "t",
      transport: makeTransport(submissions),
      messages: chain(1, 500) as never,
      onError: () => {},
    });

    // The rendered repository is a BOUNDED window with explicit parentIds.
    const windowIds = chain(451, 500);
    const repo = ExportedMessageRepository.fromBranchableArray(
      windowIds.map((m, i) => ({
        message: threadLike(m),
        parentId: i === 0 ? null : windowIds[i - 1].id,
      })) as never,
      { headId: "m500" },
    );

    const core = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messageRepository: repo,
      isRunning: false,
      // The host wires onNew to the Chat, exactly as the wrapper does.
      onNew: async (message: never) => {
        const m = message as { role: string; content: unknown[]; runConfig?: unknown };
        await chat.sendMessage(toCreateMessage(m as never) as never, { metadata: m.runConfig as never });
      },
      // Deliberately NO setMessages: the runtime must not overwrite the full
      // Chat with the bounded repository.
    } as never);

    console.log("\n=== divergence: full Chat + bounded repository ===");
    console.log("  chat.messages:", (chat.messages as AiMsg[]).length, "(full chain)");
    console.log("  rendered:", (core.messages as Array<{ id: string }>).length, "(window)");
    console.log("  repository head:", (core.repository as never as { canonicalHeadId: string }).canonicalHeadId);

    // Append at the repository head (m500), which is also the chain tip.
    await core.append({
      role: "user",
      parentId: (core.repository as never as { canonicalHeadId: string }).canonicalHeadId,
      content: [{ type: "text", text: "new" }],
    } as never);
    await new Promise((r) => setTimeout(r, 40));

    const sub = submissions.at(-1);
    console.log("  submission length:", sub?.ids.length);
    console.log("  submission first:", sub?.ids[0], "last:", sub?.ids.at(-1));

    // DECISIVE: the submission is the FULL chain (501), not the window (51).
    // The rendered window and the submission payload are DIFFERENT objects.
    expect((core.messages as Array<{ id: string }>).length).toBe(50);
    expect(sub?.ids.length).toBe(501);
    expect(sub?.ids[0]).toBe("m1");
  });

  it("but the repository head still drives the append parentId", async () => {
    const submissions: Array<{ ids: string[] }> = [];
    const chat = new Chat<never>({
      id: "t",
      transport: makeTransport(submissions),
      messages: chain(1, 500) as never,
      onError: () => {},
    });

    // A HISTORICAL window: repository head m400, but the Chat tip is m500.
    const windowIds = chain(351, 400);
    const repo = ExportedMessageRepository.fromBranchableArray(
      windowIds.map((m, i) => ({
        message: threadLike(m),
        parentId: i === 0 ? null : windowIds[i - 1].id,
      })) as never,
      { headId: "m400" },
    );

    const core = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messageRepository: repo,
      isRunning: false,
      onNew: async (message: never) => {
        const m = message as { role: string; content: unknown[]; runConfig?: unknown };
        await chat.sendMessage(toCreateMessage(m as never) as never, { metadata: m.runConfig as never });
      },
      onEdit: async (message: never) => {
        const m = message as { parentId: string | null; role: string; content: unknown[]; runConfig?: unknown };
        chat.messages = sliceMessagesUntil(chat.messages as never, m.parentId) as never;
        await chat.sendMessage(toCreateMessage(m as never) as never, { metadata: m.runConfig as never });
      },
    } as never);

    console.log("\n=== historical window (repo head m400) + full Chat (tip m500) ===");
    console.log("  repository head:", (core.repository as never as { canonicalHeadId: string }).canonicalHeadId);
    console.log("  chat tip:", (chat.messages as AiMsg[]).at(-1)?.id);

    // Append at the repository head m400. The runtime classifies it as an EDIT
    // because m400 !== the repository's... no — m400 IS the repository head.
    // So it routes to onNew, and the Chat appends after its OWN tip m500.
    await core.append({
      role: "user",
      parentId: "m400",
      content: [{ type: "text", text: "from history" }],
    } as never);
    await new Promise((r) => setTimeout(r, 40));

    const sub = submissions.at(-1);
    console.log("  submission length:", sub?.ids.length, "last:", sub?.ids.at(-1));
    console.log("  => the append went to the Chat tip, NOT the repository head");

    // The submission is the full chain + new, appended at the Chat's tip m500,
    // even though the user was "at" m400 in the rendered window. This is the
    // silent-rebase hazard in a new form: the rendered position and the
    // submission position have diverged.
    expect(sub?.ids.length).toBe(501);
  });

  it("the approved contract shape: chat.messages == window keeps them aligned", async () => {
    const submissions: Array<{ ids: string[] }> = [];
    // The Chat holds ONLY the window (the approved contract's shape).
    const chat = new Chat<never>({
      id: "t",
      transport: makeTransport(submissions),
      messages: chain(451, 500) as never,
      onError: () => {},
    });

    const windowIds = chain(451, 500);
    const repo = ExportedMessageRepository.fromBranchableArray(
      windowIds.map((m, i) => ({
        message: threadLike(m),
        parentId: i === 0 ? null : windowIds[i - 1].id,
      })) as never,
      { headId: "m500" },
    );

    const core = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messageRepository: repo,
      isRunning: false,
      onNew: async (message: never) => {
        const m = message as { role: string; content: unknown[]; runConfig?: unknown };
        await chat.sendMessage(toCreateMessage(m as never) as never, { metadata: m.runConfig as never });
      },
    } as never);

    await core.append({
      role: "user",
      parentId: "m500",
      content: [{ type: "text", text: "new" }],
    } as never);
    await new Promise((r) => setTimeout(r, 40));

    const sub = submissions.at(-1);
    console.log("\n=== contract shape: chat == window ===");
    console.log("  submission length:", sub?.ids.length, "first:", sub?.ids[0]);

    // Submission is the window (51), which P1' repairs to the full chain.
    expect(sub?.ids.length).toBe(51);
    expect(sub?.ids[0]).toBe("m451");
  });
});