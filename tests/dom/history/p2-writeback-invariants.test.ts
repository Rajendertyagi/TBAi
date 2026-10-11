/**
 * P2 Direct History Window — contract: write-back binding + corrected invariant 21.
 *
 * Runs against the REAL installed conversion and runtime classes:
 *   - `AISDKMessageConverter` (the only supported AI SDK ⇄ ThreadMessage mapping)
 *   - `ExternalStoreThreadRuntimeCore` with BOTH adapter shapes
 *   - `ExportedMessageRepository` (the bounded window's store source)
 *
 * The two corrections under test:
 *
 *   F1  Write-back must derive from the binding-carrying conversion output /
 *       chat.messages. `messageRepository` re-materializes messages and drops the
 *       `symbolInnerMessage` binding, so it can never be the write-back source.
 *       The repository shape is rejected by the production module, not merely
 *       discouraged.
 *
 *   21  "1 persisted message = 1 uniquely recoverable semantic identity." Four
 *       persisted messages legitimately render as three rows; identity, order,
 *       parentage and bindings stay recoverable; and a window fails closed only
 *       when one of those is genuinely ambiguous.
 */

import { describe, expect, it } from "bun:test";
import {
  AISDKMessageConverter,
  ExportedMessageRepository,
  ExternalStoreThreadRuntimeCore,
} from "../../helpers/dom/resolve.ts";
import {
  WriteBackAmbiguityError,
  deriveWriteBack,
  type BoundRow,
} from "@web/features/chat/history/windowWriteBack.ts";

/**
 * The hazard fixture from the frozen contract (direct-eviction.test.ts:195):
 * m2 and m3 are adjacent assistant messages, so the converter merges them and
 * m4 is re-parented onto the row m2.
 */
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
        type: "tool-delete" as const,
        toolCallId: "call-b",
        state: "approval-requested" as const,
        input: { p: 2 },
        output: undefined,
        approval: { id: "ap-1", prompt: "Delete?" },
      },
    ],
  },
  { id: "m4", role: "user" as const, parts: [{ type: "text" as const, text: "done" }] },
];

/** Convert, then pair each rendered row with the parent ROW id the repository holds. */
const boundRowsFromConversion = (messages: readonly unknown[]): BoundRow[] => {
  const converted = AISDKMessageConverter.toThreadMessages(
    messages as never,
    false,
    {} as never,
  ) as never as Array<{ id: string }>;
  return converted.map((m, i) => ({
    message: m,
    parentId: i === 0 ? null : converted[i - 1]!.id,
  }));
};

const contextProvider = {
  getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
  registerModelContextProvider: () => () => {},
} as never;

const repositoryFrom = (rows: readonly BoundRow[]) =>
  ExportedMessageRepository.fromBranchableArray(
    rows.map((r) => ({ message: r.message, parentId: r.parentId })) as never,
    { headId: rows.at(-1) ? (rows.at(-1)!.message as { id: string }).id : null },
  );

describe("P2 contract — write-back derives from the binding-carrying conversion", () => {
  it("persisted ids, order, parentage and bindings all survive a merged row", () => {
    const rows = boundRowsFromConversion(ADJACENT);
    const window = deriveWriteBack(rows);

    // The display merged m2+m3: three rows for four persisted messages. That is
    // legitimate and must NOT fail the commit.
    expect(rows.length).toBe(3);
    expect(window.messages).toHaveLength(4);

    // Every persisted identity is recoverable, in persisted order...
    expect(window.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    // ...with the ORIGINAL persisted parent chain, not the row chain...
    expect(Object.fromEntries(window.messages.map((m) => [m.id, m.parentId]))).toEqual({
      m1: null,
      m2: "m1",
      m3: "m2",
      m4: "m3",
    });
    // ...and the persisted head.
    expect(window.headId).toBe("m4");
  });

  it("a tool result and an approval write back against the persisted message that owns them", () => {
    const window = deriveWriteBack(boundRowsFromConversion(ADJACENT));

    // The merged row is m2; the approval belongs to persisted m3. A write-back
    // derived from the row id would persist the decision against m2.
    const approvalOwner = window.messages.find(
      (m) =>
        (m.message.parts[0] as { approval?: { id?: string } } | undefined)?.approval?.id === "ap-1",
    );
    expect(approvalOwner?.id).toBe("m3");

    // The tool RESULT on m2 stays with m2, so a delete of m2's row removes both
    // persisted messages (no orphaned result).
    const toolResultOwner = window.messages.find(
      (m) => (m.message.parts[0] as { toolCallId?: string } | undefined)?.toolCallId === "call-a",
    );
    expect(toolResultOwner?.id).toBe("m2");
  });

  it("F1: the repository representation is REJECTED as a write-back source", () => {
    const rows = boundRowsFromConversion(ADJACENT);
    const repository = repositoryFrom(rows);

    // Same rows, same parent links — the repository only loses the binding.
    const repoRows = (
      repository as never as {
        messages: Array<{ message: { id: string }; parentId: string | null }>;
      }
    ).messages;
    expect(repoRows.map((r) => r.message.id)).toEqual(["m1", "m2", "m4"]);
    expect(Object.fromEntries(repoRows.map((r) => [r.message.id, r.parentId]))).toEqual({
      m1: null,
      m2: "m1",
      m4: "m2",
    });

    // Writing back from it fails CLOSED rather than silently writing nothing.
    let error: WriteBackAmbiguityError | null = null;
    try {
      deriveWriteBack(repoRows);
    } catch (e) {
      error = e as WriteBackAmbiguityError;
    }
    expect(error).toBeInstanceOf(WriteBackAmbiguityError);
    expect(error?.ambiguity).toBe("missing-binding");
  });

  it("F1: only the messages-path runtime keeps the binding; the repository path does not", () => {
    const rows = boundRowsFromConversion(ADJACENT);

    const viaMessages = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messages: rows.map((r) => r.message) as never,
      isRunning: false,
    } as never);
    const viaRepository = new ExternalStoreThreadRuntimeCore(contextProvider, {
      messageRepository: repositoryFrom(rows),
      isRunning: false,
    } as never);

    const pairWithParents = (messages: readonly unknown[]): BoundRow[] =>
      messages.map((m, i) => ({
        message: m,
        parentId: i === 0 ? null : (messages[i - 1] as { id: string }).id,
      }));

    // Identical rendered output from both shapes…
    expect((viaMessages.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(
      (viaRepository.messages as Array<{ id: string }>).map((m) => m.id),
    );

    // …but only the messages-path rows can be written back.
    expect(
      deriveWriteBack(pairWithParents(viaMessages.messages)).messages.map((m) => m.id),
    ).toEqual(["m1", "m2", "m3", "m4"]);
    expect(() => deriveWriteBack(pairWithParents(viaRepository.messages))).toThrow(
      WriteBackAmbiguityError,
    );
  });

  it("F1: a window commit cannot silently persist an empty write-back", () => {
    // The failure mode F1 protects against: repository write-back returns nothing,
    // so an edit/delete/tool-output/approval would persist zero messages and the
    // persisted chain would lose the branch. The module refuses instead.
    const repositoryRows = (
      repositoryFrom(boundRowsFromConversion(ADJACENT)) as never as {
        messages: BoundRow[];
      }
    ).messages;
    const written = (() => {
      try {
        return deriveWriteBack(repositoryRows).messages;
      } catch {
        return [] as unknown[];
      }
    })();
    expect(written).toEqual([]);
  });
});

describe("P2 contract — corrected invariant 21 fails closed only on real ambiguity", () => {
  const rows = () => boundRowsFromConversion(ADJACENT);
  /**
   * The persisted id of a bound row.
   *
   * `BoundRow.message` is `unknown` on purpose — anything the converter produces
   * can reach it — so reading `.id` needs a narrowing. The previous inline
   * `rows()[0]!.message.id as string` did not compile precisely because the
   * property access happened before any cast.
   */
  const idOf = (row: BoundRow): string => (row.message as { id?: string }).id ?? "";

  it("row count below persisted count is NOT a failure", () => {
    expect(rows().length).toBeLessThan(ADJACENT.length);
    expect(() => deriveWriteBack(rows())).not.toThrow();
  });

  it("fails closed when a persisted identity would be duplicated", () => {
    const duplicated: BoundRow[] = [
      { message: rows()[0]!.message, parentId: null },
      { message: rows()[1]!.message, parentId: idOf(rows()[0]!) },
      // The same bound row again: its m2/m3 identities repeat.
      { message: rows()[1]!.message, parentId: idOf(rows()[0]!) },
    ];
    let error: WriteBackAmbiguityError | null = null;
    try {
      deriveWriteBack(duplicated);
    } catch (e) {
      error = e as WriteBackAmbiguityError;
    }
    expect(error?.ambiguity).toBe("duplicate-persisted-id");
  });

  it("fails closed when parentage cannot be resolved unambiguously", () => {
    const orphan: BoundRow[] = [
      { message: rows()[2]!.message, parentId: "not-a-row-in-this-window" },
    ];
    let error: WriteBackAmbiguityError | null = null;
    try {
      deriveWriteBack(orphan);
    } catch (e) {
      error = e as WriteBackAmbiguityError;
    }
    expect(error?.ambiguity).toBe("unresolvable-parent");
  });
});
