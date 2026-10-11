/**
 * P2 — where the write-back binding is produced and lost, through REAL classes.
 *
 * This corrects the spike's earlier conclusion. The binding is NOT lost because
 * the store field is `messageRepository`; it is lost because the SPIKE built its
 * repository with `ExportedMessageRepository.fromBranchableArray`, which
 * re-materializes every message through `fromThreadMessageLike`
 * (message-repository.js) and therefore drops `symbolInnerMessage`.
 *
 * The production construction keeps it:
 *
 *   toExportedMessageRepository(toThreadMessages, repo)   (useExternalHistory.js)
 *     → message = toThreadMessages([m.message])[0]        // bound converter output
 *     → { ...m, message }                                  // parentId kept, object NOT cloned
 *   MessageRepository.import({ headId, messages })         (message-repository.js)
 *     → this.addOrUpdateMessage(parentId, message)         // stored as-is
 *
 * So the supported production path is: hand `useAISDKRuntime` the window in its
 * PUBLIC `unstable_messageRepository` (MessageFormatRepository) shape — AI SDK
 * messages plus PERSISTED parent ids — and let upstream do the conversion and
 * binding. No deep import, no second conversion implementation.
 */

import { describe, expect, it } from "bun:test";
import {
  AISDKMessageConverter,
  ExportedMessageRepository,
  ExternalStoreThreadRuntimeCore,
  getExternalStoreMessages,
} from "../../helpers/dom/resolve.ts";
import {
  deriveWriteBack,
  WriteBackAmbiguityError,
  type BoundRow,
} from "@web/features/chat/history/windowWriteBack.ts";

/** m2/m3 are adjacent assistant messages, so the converter merges them. */
const ADJACENT = [
  { id: "m1", role: "user" as const, parts: [{ type: "text" as const, text: "go" }] },
  {
    id: "m2",
    role: "assistant" as const,
    parts: [
      {
        type: "tool-read" as const,
        toolCallId: "call-a",
        state: "output-available" as const,
        input: { p: 1 },
        output: { ok: true },
      },
    ],
  },
  {
    id: "m3",
    role: "assistant" as const,
    parts: [
      {
        type: "tool-read" as const,
        toolCallId: "call-b",
        state: "output-available" as const,
        input: { p: 2 },
        output: { ok: true },
      },
    ],
  },
  { id: "m4", role: "user" as const, parts: [{ type: "text" as const, text: "done" }] },
];

const contextProvider = {
  getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
  registerModelContextProvider: () => () => {},
} as never;

const convert = () =>
  AISDKMessageConverter.toThreadMessages(ADJACENT as never, false, {} as never) as never as Array<{
    id: string;
  }>;

const recovered = (m: unknown) =>
  (getExternalStoreMessages(m as never) as Array<{ id: string }>).map((x) => x.id).join(",") ||
  "(none)";

/**
 * The production construction, transcribed from
 * `useAISDKRuntime.onLoadExternalState` → `toExportedMessageRepository`:
 * convert each stored message and keep the parent link beside the RESULT (the
 * object is never re-materialized).
 */
/**
 * The shape both constructions are asserted against.
 *
 * `BoundRow.message` is `unknown` by design — any assistant-ui message can reach
 * it and `deriveWriteBack` is what extracts identity — so the repositories this
 * file builds have no useful inferred type. `spikeRepository` in particular goes
 * through an untyped `dist/*` internal. Declaring the contract here is the
 * honest alternative to casting at every read below.
 */
type RepositoryView = {
  readonly headId: string | null;
  readonly messages: readonly {
    readonly parentId: string | null;
    readonly message: { id: string };
  }[];
};

const productionRepository = (
  rows: readonly { message: unknown; parentId: string | null }[],
): RepositoryView => ({
  headId: rows.at(-1) ? (rows.at(-1)!.message as { id: string }).id : null,
  messages: rows.map((r) => ({
    parentId: r.parentId,
    message: r.message as { id: string },
  })),
});

/** What the SPIKE used — and what must never be used for write-back. */
const spikeRepository = (
  rows: readonly { message: unknown; parentId: string | null }[],
): RepositoryView =>
  ExportedMessageRepository.fromBranchableArray(
    rows.map((r) => ({ message: r.message as never, parentId: r.parentId })) as never,
    { headId: rows.at(-1) ? (rows.at(-1)!.message as { id: string }).id : null },
  ) as unknown as RepositoryView;

describe("P2 — binding survival by repository construction", () => {
  it("production construction keeps the binding; fromBranchableArray loses it", () => {
    const converted = convert();
    const rows = converted.map((m, i) => ({
      message: m,
      parentId: i === 0 ? null : converted[i - 1]!.id,
    }));

    const production = productionRepository(rows);
    const spike = spikeRepository(rows);

    console.log("\n=== binding by construction ===");
    console.log(
      `  production rows: ${production.messages.map((r) => `${r.message.id}=${recovered(r.message)}`).join(" | ")}`,
    );
    console.log(
      `  fromBranchable : ${spike.messages.map((r) => `${r.message.id}=${recovered(r.message)}`).join(" | ")}`,
    );

    expect(production.messages.map((r) => recovered(r.message))).toEqual(["m1", "m2,m3", "m4"]);
    expect(spike.messages.map((r) => recovered(r.message))).toEqual(["(none)", "(none)", "(none)"]);
  });

  it("a repository built the production way keeps the binding through the runtime", () => {
    const converted = convert();
    const rows = converted.map((m, i) => ({
      message: m,
      parentId: i === 0 ? null : converted[i - 1]!.id,
    }));

    const core = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messageRepository: productionRepository(rows) as never,
      isRunning: false,
    } as never);

    const live = core.messages as Array<{ id: string }>;
    console.log("\n=== Option B store, production construction ===");
    for (const m of live) console.log(`  ${m.id} -> ${recovered(m)}`);

    expect(live.map((m) => m.id)).toEqual(["m1", "m2", "m4"]);

    // Write-back from the RUNTIME's own messages recovers every persisted id.
    const asRows: BoundRow[] = live.map((m, i) => ({
      message: m,
      parentId: i === 0 ? null : (live[i - 1] as { id: string }).id,
    }));
    const window = deriveWriteBack(asRows);

    console.log(`  write-back ids    : ${window.messages.map((m) => m.id).join(",")}`);
    console.log(
      `  write-back parents: ${JSON.stringify(window.messages.map((m) => [m.id, m.parentId]))}`,
    );
    expect(window.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(Object.fromEntries(window.messages.map((m) => [m.id, m.parentId]))).toEqual({
      m1: null,
      m2: "m1",
      m3: "m2",
      m4: "m3",
    });
    expect(window.headId).toBe("m4");
  });

  it("the same window built the spike way still fails closed (never an empty write)", () => {
    const converted = convert();
    const rows = converted.map((m, i) => ({
      message: m,
      parentId: i === 0 ? null : converted[i - 1]!.id,
    }));

    const core = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messageRepository: spikeRepository(rows) as never,
      isRunning: false,
    } as never);
    const live = core.messages as Array<{ id: string }>;
    const asRows: BoundRow[] = live.map((m, i) => ({
      message: m,
      parentId: i === 0 ? null : (live[i - 1] as { id: string }).id,
    }));

    expect(live.map((m) => m.id)).toEqual(["m1", "m2", "m4"]);
    expect(() => deriveWriteBack(asRows)).toThrow(WriteBackAmbiguityError);
  });
});
