/**
 * P2 Direct History Window — write-back derivation unit tests.
 *
 * These cover the corrected invariant 21 as enforced in code: a rendered row may
 * group several persisted messages, and anything that cannot be reduced to
 * unambiguous persisted identities fails closed instead of writing back a
 * partial window.
 */

import { describe, expect, it } from "bun:test";
import { bindExternalStoreMessage } from "@assistant-ui/react";
import {
  WriteBackAmbiguityError,
  deriveWriteBack,
  type BoundRow,
  type PersistedMessage,
} from "@web/features/chat/history/windowWriteBack.ts";

const persisted = (id: string, role: "user" | "assistant" = "user"): PersistedMessage => ({
  id,
  role,
  parts: [{ type: "text", text: `body ${id}` }],
});

/** A rendered row bound to the persisted message(s) it represents. */
const row = (id: string, parentId: string | null, inner: readonly PersistedMessage[]): BoundRow => {
  const message = { id, role: "assistant", content: [] } as unknown as Record<string, unknown>;
  bindExternalStoreMessage(message as never, (inner.length === 1 ? inner[0] : inner) as never);
  return { message, parentId };
};

describe("deriveWriteBack — corrected invariant 21", () => {
  it("expands a merged row into every persisted message it represents", () => {
    // m2 absorbs m3 (adjacent assistant merge) — 3 rows, 4 persisted messages.
    const window = deriveWriteBack([
      row("m1", null, [persisted("m1")]),
      row("m2", "m1", [persisted("m2", "assistant"), persisted("m3", "assistant")]),
      row("m4", "m2", [persisted("m4")]),
    ]);

    // Rendered rows may be fewer than persisted messages; that is NOT a failure.
    expect(window.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    // Order is recoverable.
    expect(window.messages.map((m) => m.id)).toEqual([...window.messages].map((m) => m.id));
    // Parentage is the ORIGINAL persisted chain: m4's parent is m3, not the row m2.
    expect(Object.fromEntries(window.messages.map((m) => [m.id, m.parentId]))).toEqual({
      m1: null,
      m2: "m1",
      m3: "m2",
      m4: "m3",
    });
    // Head is the last PERSISTED id, not the last row id.
    expect(window.headId).toBe("m4");
  });

  it("keeps the persisted message object, so a write-back carries its parts", () => {
    const m2 = persisted("m2", "assistant");
    const m3: PersistedMessage = {
      id: "m3",
      role: "assistant",
      parts: [
        {
          type: "tool-delete",
          toolCallId: "tc1",
          state: "approval-requested",
          input: { path: "y" },
          approval: { id: "ap-1" },
        },
      ],
    };
    const window = deriveWriteBack([
      row("m1", null, [persisted("m1")]),
      row("m2", "m1", [m2, m3]),
    ]);

    // The approval lives on a persisted message the write-back actually carries,
    // so responding to it persists against m3 and not against the row id.
    const approvalOwner = window.messages.find((m) =>
      (m.message.parts[0] as { approval?: { id?: string } } | undefined)?.approval?.id === "ap-1",
    );
    expect(approvalOwner?.id).toBe("m3");
    expect(approvalOwner?.message).toBe(m3);
  });

  it("an unbound row fails closed — a repository object can never be a write-back source", () => {
    // This is what ExportedMessageRepository re-materializes: the id and the
    // shape survive, the symbolInnerMessage binding does not.
    const repositoryShaped: BoundRow = {
      message: { id: "m2", role: "assistant", content: [{ type: "tool-call" }] },
      parentId: "m1",
    };

    let error: WriteBackAmbiguityError | null = null;
    try {
      deriveWriteBack([row("m1", null, [persisted("m1")]), repositoryShaped]);
    } catch (e) {
      error = e as WriteBackAmbiguityError;
    }

    expect(error).toBeInstanceOf(WriteBackAmbiguityError);
    expect(error?.ambiguity).toBe("missing-binding");
    // It identifies the row without leaking message text.
    expect(error?.ids).toEqual(["m2"]);
  });

  it("fails closed on a duplicated persisted id", () => {
    let error: WriteBackAmbiguityError | null = null;
    try {
      deriveWriteBack([row("m1", null, [persisted("m1")]), row("m2", "m1", [persisted("m2"), persisted("m2")])]);
    } catch (e) {
      error = e as WriteBackAmbiguityError;
    }
    expect(error?.ambiguity).toBe("duplicate-persisted-id");
    expect(error?.ids).toEqual(["m2"]);
  });

  it("fails closed when a row's parent row is not in the window", () => {
    let error: WriteBackAmbiguityError | null = null;
    try {
      deriveWriteBack([row("m2", "m1", [persisted("m2")])]);
    } catch (e) {
      error = e as WriteBackAmbiguityError;
    }
    expect(error?.ambiguity).toBe("unresolvable-parent");
    expect(error?.ids).toEqual(["m1", "m2"]);
  });

  it("fails closed on a bound value that is not a persisted message", () => {
    const message = { id: "m2", role: "assistant", content: [] } as unknown as Record<string, unknown>;
    bindExternalStoreMessage(message as never, { nope: true } as never);

    let error: WriteBackAmbiguityError | null = null;
    try {
      deriveWriteBack([{ message, parentId: null }]);
    } catch (e) {
      error = e as WriteBackAmbiguityError;
    }
    expect(error?.ambiguity).toBe("invalid-persisted-message");
  });

  it("an empty window has no head", () => {
    const window = deriveWriteBack([]);
    expect(window.messages).toEqual([]);
    expect(window.headId).toBeNull();
  });
});
