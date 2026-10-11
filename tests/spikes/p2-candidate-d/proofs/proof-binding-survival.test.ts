/**
 * SPIKE — where is the write-back binding lost on the messageRepository path?
 * TEMPORARY, removable.
 *
 * §14 finding under investigation: production write-back unwraps via
 * `getExternalStoreMessages` (useAISDKRuntime setMessages ← getVercelAIMessages).
 * With `store.messages` that recovers the persisted AI SDK messages. With
 * Option B's `store.messageRepository` the audit showed NOTHING recovered.
 * This isolates which step drops the `symbolInnerMessage` binding:
 *
 *   (a) AISDKMessageConverter.toThreadMessages      — should be bound
 *   (b) ExportedMessageRepository.fromBranchableArray — ?
 *   (c) after ExternalStoreThreadRuntimeCore.addOrUpdateMessage — ?
 *   (d) what the runtime publishes as thread messages — ?
 */

import { describe, expect, it } from "bun:test";
import {
  AISDKMessageConverter,
  ExportedMessageRepository,
  ExternalStoreThreadRuntimeCore,
  getExternalStoreMessages,
} from "../../../helpers/dom/resolve.ts";
import { createProof, type AiMsg } from "./proof-harness";

const ADJACENT: AiMsg[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "go" }] },
  {
    id: "m2",
    role: "assistant",
    parts: [{ type: "tool-call", toolCallId: "call-a", state: "output-available", input: { p: 1 }, output: { ok: true } }],
  },
  {
    id: "m3",
    role: "assistant",
    parts: [{ type: "tool-call", toolCallId: "call-b", state: "output-available", input: { p: 2 }, output: { ok: true } }],
  },
  { id: "m4", role: "user", parts: [{ type: "text", text: "done" }] },
];

const ids = (msgs: readonly unknown[]) =>
  (msgs as Array<{ id: string }>).map((m) => m.id).join(",") || "(none)";

const recoveredOf = (m: unknown) =>
  (getExternalStoreMessages(m as never) as Array<{ id: string }>).map((x) => x.id).join(",") ||
  "(none)";

describe("write-back binding across the messageRepository path", () => {
  it("isolates the step that drops symbolInnerMessage", () => {
    console.log("\n=== binding survival (4 persisted → 3 rendered rows) ===");

    // (a) raw converter output
    const converted = AISDKMessageConverter.toThreadMessages(
      ADJACENT as never,
      false,
      {} as never,
    ) as never as Array<{ id: string }>;
    console.log(`  (a) converter rows          : ${ids(converted)}`);
    for (const m of converted) console.log(`        ${m.id} → ${recoveredOf(m)}`);

    // (b) inside ExportedMessageRepository
    const repo = ExportedMessageRepository.fromBranchableArray(
      converted.map((m, i) => ({ message: m, parentId: i === 0 ? null : converted[i - 1].id })) as never,
      { headId: converted.at(-1)?.id ?? null },
    );
    const repoMessages = (repo as never as { messages: Array<{ message: { id: string } }> }).messages;
    console.log(`  (b) repository.messages     : ${ids(repoMessages.map((e) => e.message))}`);
    for (const e of repoMessages) console.log(`        ${e.message.id} → ${recoveredOf(e.message)}`);

    // (c) after the runtime core has ingested the repository
    const contextProvider = {
      getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
      registerModelContextProvider: () => () => {},
    } as never;
    let core: InstanceType<typeof ExternalStoreThreadRuntimeCore> | null = null;
    try {
      core = new ExternalStoreThreadRuntimeCore(contextProvider, {
        messageRepository: repo,
        isRunning: false,
      } as never);
    } catch (e) {
      console.log("  (c) core construction threw:", String(e));
    }
    if (core) {
      const published = core.messages as Array<{ id: string }>;
      console.log(`  (c) core.messages           : ${ids(published)}`);
      for (const m of published) console.log(`        ${m.id} → ${recoveredOf(m)}`);

      const internal = (core as never as {
        repository: { export: () => { messages: Array<{ message: { id: string } }> } };
      }).repository.export();
      console.log(`  (c) repository.export()     : ${ids(internal.messages.map((e) => e.message))}`);
      for (const e of internal.messages) console.log(`        ${e.message.id} → ${recoveredOf(e.message)}`);
    }

    // (d) the Option B proof harness (same composition as the scroll harness)
    const h = createProof({ window: ADJACENT });
    const published = h.runtime.messages as Array<{ id: string }>;
    console.log(`  (d) harness runtime.messages: ${ids(published)}`);
    for (const m of published) console.log(`        ${m.id} → ${recoveredOf(m)}`);
    console.log(`  (d) harness chat.messages   : ${ids(h.chatIds())}`);

    // Facts, not conclusions: the assertions below only pin (a).
    expect(recoveredOf(converted[1])).toBe("m2,m3");
    h.dispose();
  });

  it("the store.messages path KEEPS the binding — the loss is path-specific", () => {
    // Same 4 persisted messages, published through `store.messages` (what
    // @assistant-ui/ai-sdk does after seeding) instead of
    // `store.messageRepository` (Option B).
    const converted = AISDKMessageConverter.toThreadMessages(
      ADJACENT as never,
      false,
      {} as never,
    ) as never as Array<{ id: string }>;
    const contextProvider = {
      getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
      registerModelContextProvider: () => () => {},
    } as never;

    const viaMessages = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messages: converted as never,
      isRunning: false,
    } as never);
    const viaRepository = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messageRepository: ExportedMessageRepository.fromBranchableArray(
        converted.map((m, i) => ({
          message: m,
          parentId: i === 0 ? null : converted[i - 1].id,
        })) as never,
        { headId: converted.at(-1)?.id ?? null },
      ),
      isRunning: false,
    } as never);

    const fromMessages = (viaMessages.messages as Array<{ id: string }>).map(recoveredOf);
    const fromRepository = (viaRepository.messages as Array<{ id: string }>).map(recoveredOf);

    console.log("\n=== binding by adapter path ===");
    console.log(`  store.messages       rows=${ids(viaMessages.messages as never)} recovered=[${fromMessages.join(" | ")}]`);
    console.log(`  store.messageRepository rows=${ids(viaRepository.messages as never)} recovered=[${fromRepository.join(" | ")}]`);

    // The published rows are the SAME 3 messages either way...
    expect(ids(viaMessages.messages as never)).toBe("m1,m2,m4");
    expect(ids(viaRepository.messages as never)).toBe("m1,m2,m4");
    // ...but only the `messages` path still carries the persisted binding.
    expect(fromMessages).toEqual(["m1", "m2,m3", "m4"]);
    expect(fromRepository).toEqual(["(none)", "(none)", "(none)"]);
  });
});
