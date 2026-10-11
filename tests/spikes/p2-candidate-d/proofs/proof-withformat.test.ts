/**
 * SPIKE — OPTION B PROOF: withFormat / history flow (section 5).
 * TEMPORARY, removable.
 *
 * The format adapter (`aiSDKV6FormatAdapter`) is pass-through: it strips the id
 * on encode and operates on the AI SDK UIMessage, NOT the assistant-ui
 * ThreadMessage. So the history flow is preserved IF the AI SDK UIMessage →
 * ThreadMessage → AI SDK UIMessage round-trip (converter + binding) preserves
 * every field Direct needs.
 */

import { describe, expect, it } from "bun:test";
import {
  AISDKMessageConverter,
  getExternalStoreMessages,
} from "../../../helpers/dom/resolve.ts";

// The real format adapter (assistant-cloud/ai-sdk), resolved through the store.
async function loadFormatAdapter() {
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const aiSdk = req.resolve("@assistant-ui/ai-sdk");
  const acReq = createRequire(aiSdk);
  const mod = (await import(acReq.resolve("assistant-cloud/ai-sdk"))) as {
    aiSDKV6FormatAdapter: {
      format: string;
      encode: (item: { message: Record<string, unknown> }) => unknown;
      decode: (stored: unknown) => unknown;
      getId: (m: { id: string }) => string;
    };
  };
  return mod.aiSDKV6FormatAdapter;
}

const RICH = {
  id: "m1",
  role: "assistant",
  parts: [
    { type: "text", text: "reading" },
    {
      type: "tool-read",
      toolCallId: "tc1",
      state: "output-available",
      input: { path: "x" },
      output: { content: "data" },
    },
    {
      type: "tool-delete",
      toolCallId: "tc2",
      state: "approval-requested",
      input: { path: "y" },
      approval: { id: "ap-1", prompt: "Delete y?" },
    },
    { type: "reasoning", text: "thinking" },
  ],
  metadata: { custom: { key: "value" } },
};

describe("Option B — withFormat / history flow", () => {
  it("converter round-trip preserves every field Direct needs", () => {
    const [thread] = AISDKMessageConverter.toThreadMessages([RICH] as never, false, {} as never) as never as unknown[];
    const [recovered] = getExternalStoreMessages(thread as never) as Array<typeof RICH>;

    console.log("\n=== withFormat: converter round-trip ===");
    console.log("  recovered id:", recovered.id);
    console.log("  parts:", recovered.parts.map((p) => p.type).join(","));
    console.log("  tool tc1 state:", (recovered.parts[1] as { state?: string }).state);
    console.log("  approval:", JSON.stringify((recovered.parts[2] as { approval?: unknown }).approval));
    console.log("  metadata:", JSON.stringify(recovered.metadata));

    expect(recovered.id).toBe("m1");
    expect(recovered.parts.map((p) => p.type)).toEqual(["text", "tool-read", "tool-delete", "reasoning"]);
    expect((recovered.parts[1] as { output?: unknown }).output).toEqual({ content: "data" });
    expect(((recovered.parts[2] as { approval?: { id?: string } }).approval)?.id).toBe("ap-1");
    expect(recovered.metadata).toEqual({ custom: { key: "value" } });
  });

  it("the format adapter encode/decode round-trips the recovered message", async () => {
    const fmt = await loadFormatAdapter();
    const [thread] = AISDKMessageConverter.toThreadMessages([RICH] as never, false, {} as never) as never as unknown[];
    const [recovered] = getExternalStoreMessages(thread as never) as Array<Record<string, unknown>>;

    // The history adapter encodes the recovered AI SDK message for storage.
    const encoded = fmt.encode({ message: recovered });
    const decoded = fmt.decode({ id: fmt.getId(recovered as { id: string }), parent_id: null, format: fmt.format, content: encoded } as never) as { parentId: string | null; message: { id: string; parts: unknown[] } };

    console.log("\n=== withFormat: format adapter round-trip ===");
    console.log("  format:", fmt.format);
    console.log("  getId:", fmt.getId(recovered as { id: string }));
    console.log("  decoded id:", decoded.message.id);
    console.log("  decoded parts:", decoded.message.parts.length);

    expect(fmt.getId(recovered as { id: string })).toBe("m1");
    expect(decoded.message.id).toBe("m1");
    expect(decoded.message.parts.length).toBe(4);
  });

  it("history load → chat.messages → repository preserves ids (the production flow)", () => {
    // Simulate: persisted rows decode to AI SDK messages, become chat.messages,
    // become the repository. Ids must match at every step.
    const persisted = [RICH];
    const chatMessages = persisted; // format adapter is pass-through
    const converted = AISDKMessageConverter.toThreadMessages(chatMessages as never, false, {} as never) as never as Array<{ id: string }>;

    console.log("\n=== withFormat: load → chat → repository ===");
    console.log("  persisted ids:", persisted.map((m) => m.id).join(","));
    console.log("  repository ids:", converted.map((m) => m.id).join(","));

    expect(converted.map((m) => m.id)).toEqual(persisted.map((m) => m.id));
  });
});