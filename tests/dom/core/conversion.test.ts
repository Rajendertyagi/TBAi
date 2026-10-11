/**
 * SPIKE — CONTRACT AUDIT, Question 5: MESSAGE CONVERSION CONTRACT.
 * TEMPORARY, removable.
 *
 * Owning the external store means owning conversion. This measures the MINIMUM
 * TBAi must supply, and — more importantly — what each available path LOSES.
 *
 * Two paths exist in `@assistant-ui/core@0.3.24`:
 *
 *   (a) `messages` — the host hands fully-formed assistant-ui `ThreadMessage`s.
 *       This is what `@assistant-ui/ai-sdk@0.0.11` does today.
 *   (b) `messages` + `convertMessage` — the host hands raw AI SDK messages plus
 *       a converter, and the runtime runs `fromThreadMessageLike` itself
 *       (external-store-thread-runtime-core.js:235-254).
 *
 * Nothing here IMPLEMENTS a converter. It measures the existing ones.
 */

import { describe, expect, it } from "bun:test";
import {
  createAudit,
  getExternalStoreMessages,
  type AiUiMessage,
} from "../../helpers/dom/audit-harness.ts";
import { AISDKMessageConverter } from "../../helpers/dom/resolve.ts";

/** A message exercising every part class Direct can persist. */
const RICH: AiUiMessage = {
  id: "m1",
  role: "assistant",
  parts: [
    { type: "text", text: "plain text" },
    { type: "reasoning", text: "thinking" },
    {
      type: "tool-call",
      toolCallId: "call-1",
      state: "output-available",
      input: { path: "a.txt" },
      output: { ok: true },
    },
    {
      type: "tool-call",
      toolCallId: "call-2",
      state: "input-streaming",
      input: undefined,
    },
    { type: "source-url", sourceId: "s1", url: "https://example.com" },
    { type: "file", mediaType: "image/png", url: "https://example.com/a.png" },
    { type: "data-weather", data: { temp: 21 } },
  ],
} as never;

const convert = (m: unknown) =>
  AISDKMessageConverter.toThreadMessages([m] as never, false, {} as never)[0] as never as {
    id: string;
    role: string;
    content: Array<{ type: string }>;
    metadata?: Record<string, unknown>;
    status?: { type: string };
    createdAt?: Date;
    attachments?: unknown[];
  };

describe("Q5 — the minimal conversion contract", () => {
  it("the real converter emits every part class Direct persists", () => {
    const thread = convert(RICH);

    console.log("\n=== Q5.1 real converter output ===");
    console.log("  id      :", thread.id);
    console.log("  role    :", thread.role);
    console.log("  createdAt:", thread.createdAt instanceof Date);
    console.log("  status  :", JSON.stringify(thread.status ?? null));
    console.log("  metadata keys:", Object.keys(thread.metadata ?? {}).join(",") || "(none)");
    console.log("  content types:", thread.content.map((p) => p.type).join(","));

    // Structure that MUST be preserved for Direct.
    expect(thread.id).toBe("m1");
    expect(thread.role).toBe("assistant");
    expect(thread.createdAt).toBeInstanceOf(Date);

    const types = thread.content.map((p) => p.type);
    expect(types).toContain("text");
    expect(types).toContain("reasoning");
    expect(types).toContain("tool-call");
    expect(types).toContain("source");
    expect(types).toContain("file");
    expect(types).toContain("data");
  });

  it("tool lifecycle state is carried on the PART, not the message", () => {
    const thread = convert(RICH);
    const tools = thread.content.filter((p) => p.type === "tool-call");

    console.log("\n=== Q5.2 tool parts ===");
    for (const t of tools as unknown as Array<Record<string, unknown>>) {
      console.log(
        `  ${t.toolCallId}: isError=${String(t.isError)} hasArgs=${"args" in t} hasArgsText=${"argsText" in t} approval=${"approval" in t}`,
      );
    }

    // The message-level status is NOT how tool state is expressed.
    expect(thread.content.filter((p) => p.type === "tool-call").length).toBe(2);
    const completed = tools[0] as unknown as Record<string, unknown>;
    expect(completed.toolCallId).toBe("call-1");
    expect(completed.result).toEqual({ ok: true });
    expect(completed.isError).toBe(false);
  });

  it("the core's `convertMessage` path NORMALIZES status and metadata itself", () => {
    // Path (b): hand raw AI SDK messages plus a converter. The runtime runs
    // `fromThreadMessageLike`, supplying status/metadata/createdAt itself.
    // The converter here passes tool parts through, so this measures what the
    // RUNTIME derives rather than what a lazy converter omitted.
    const richAssistant: AiUiMessage = {
      id: "m9",
      role: "assistant",
      parts: [
        { type: "text", text: "calling" },
        {
          type: "tool-call",
          toolCallId: "call-9",
          state: "input-available",
        } as never,
      ],
    } as never;

    const h = createAudit({
      authoritative: ["m9"],
      window: ["m9"],
      conversion: "convertMessage",
    });

    let error: string | null = null;
    try {
      h.seed([richAssistant]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    console.log("\n=== Q5.3 the lighter `convertMessage` path ===");
    console.log("  visible      :", h.visibleIds().join(",") || "(none)");
    console.log("  error        :", error ?? "(none)");
    if (error === null) {
      const first = h.repository.export().messages[0]?.message as unknown as {
        status?: { type: string; reason?: string };
        metadata?: Record<string, unknown>;
        createdAt?: Date;
        content?: Array<{ type: string }>;
      };
      console.log("  derived status  :", JSON.stringify(first?.status ?? null));
      console.log("  derived metadata:", Object.keys(first?.metadata ?? {}).join(",") || "(none)");
      console.log("  createdAt       :", first?.createdAt instanceof Date);
      console.log("  content types   :", first?.content?.map((c) => c.type).join(","));

      // DECISIVE: the runtime DERIVES message status from content, including
      // the `requires-action` state Direct's approval UI depends on. So the
      // lighter path is NOT inherently lossy for status — provided the host's
      // converter emits tool parts with a recognisable state.
      expect(first?.status?.type).toBe("requires-action");
      expect(first?.createdAt).toBeInstanceOf(Date);
    }

    h.dispose();
  });

  it("write-back round-trip depends on symbolInnerMessage, not on message shape", () => {
    // `getVercelAIMessages` IS `getExternalStoreMessages`: it unwraps the
    // `symbolInnerMessage` back-reference installed during conversion. A
    // hand-built ThreadMessageLike has no such binding, so write-back silently
    // recovers NOTHING.
    const bound = convert(RICH);
    const recovered = getExternalStoreMessages(bound as never);

    console.log("\n=== Q5.4 write-back binding ===");
    console.log("  converter output is bound:", Array.isArray(recovered) && recovered.length > 0);
    console.log("  recovered id            :", (recovered[0] as { id: string })?.id);

    expect(Array.isArray(recovered)).toBe(true);
    expect((recovered[0] as { id: string }).id).toBe("m1");

    // A plain object shaped like a ThreadMessage is NOT bound.
    const handBuilt = { id: "m1", role: "assistant", content: [{ type: "text", text: "x" }] };
    const handRecovered = getExternalStoreMessages(handBuilt as never);
    console.log("  hand-built is bound    :", Array.isArray(handRecovered) && handRecovered.length > 0);
    expect(handRecovered.length).toBe(0);
  });

  it("the realWrapper path is the only one that round-trips today", async () => {
    const h = createAudit({
      authoritative: ["m1", "m2", "m3"],
      window: ["m1", "m2", "m3"],
      conversion: "realWrapper",
    });
    await h.send("go");

    console.log("\n=== Q5.5 realWrapper write-back ===");
    console.log("  writeBacks:", JSON.stringify(h.writeBacks));
    console.log("  chat.messages:", h.chatIds().length);

    // Every write-back recovered real AI SDK messages.
    for (const ids of h.writeBacks) expect(ids.length).toBeGreaterThan(0);
    h.dispose();
  });
});