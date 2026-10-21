/**
 * H2 — a history commit reconciles with the transcript instead of replacing it.
 *
 * A history read pages over time, so the transcript keeps moving while it runs.
 * Replacing it outright lost every event that arrived during the read; never
 * removing anything would leave a deleted message on screen forever. The
 * contract these cases pin is the narrow one in between:
 *
 * - a message the client held and the snapshot omits is DELETED (the snapshot
 *   is authoritative about the pages it covers),
 * - a message the snapshot carries is taken from the SNAPSHOT (that is what
 *   lets a refresh repair a transcript that drifted),
 * - a message a live event changed during the read keeps its LIVE version, and
 * - a message created during the read is kept, after the snapshot's own.
 *
 * Everything here drives the real controller: the merge is a property of the
 * commit, and a reducer-only test would not show which ids the controller
 * supplies.
 */

import { describe, expect, it } from "bun:test";
import type { SessionMessageInfo, SessionMessagesResponse, V2Event } from "@opencode/client";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  SESSION_ID,
  createClient,
  createGeneration,
  deferred,
} from "@web/testing/opencode/v2ThreadControllerHarness";

const ASSISTANT_ONE = "msg_merge_assistant_one";
const ASSISTANT_TWO = "msg_merge_assistant_two";
const ASSISTANT_LATE = "msg_merge_assistant_late";

function assistantText(id: string, text: string, created = 20): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { id: "test-model", providerID: "test-provider" },
    time: { created },
    content: [{ type: "text", text }],
  };
}

function page(...messages: SessionMessageInfo[]): SessionMessagesResponse {
  return { data: messages, cursor: {} };
}

function textDelta(id: string, messageId: string, delta: string): V2Event {
  return {
    id,
    created: 30,
    type: "session.text.delta",
    data: { sessionID: SESSION_ID, assistantMessageID: messageId, ordinal: 0, delta },
  };
}

function textStarted(id: string, messageId: string): V2Event {
  return {
    id,
    created: 30,
    type: "session.text.started",
    durable: { aggregateID: SESSION_ID, seq: 1, version: 1 },
    data: { sessionID: SESSION_ID, assistantMessageID: messageId, ordinal: 0 },
  };
}

/** The concatenated text of a message's text parts. */
function textOf(controller: ReturnType<typeof createV2ThreadController>, id: string): string {
  return (controller.getState().messages[id]?.parts ?? [])
    .map((part) => (part.kind === "text" ? part.value : ""))
    .join("");
}

/**
 * Serves one page per read, and announces when a chosen read has STARTED.
 *
 * The announcement is what makes the "arrived during the read" cases
 * deterministic: the controller opens the read scope immediately before it
 * calls the reader, so a read that has been entered has its scope open.
 */
function pagingReader(pages: SessionMessagesResponse[], waitForRead: number) {
  const readStarted = deferred<void>();
  let call = 0;
  return {
    readStarted: readStarted.promise,
    historyList: async (): Promise<SessionMessagesResponse> => {
      call += 1;
      if (call === waitForRead) readStarted.resolve();
      return pages[call - 1] ?? page();
    },
  };
}

describe("the history commit reconciles with the moving transcript", () => {
  it("removes a message the snapshot no longer contains", async () => {
    const reader = pagingReader([page(assistantText(ASSISTANT_ONE, "one")), page()], 2);
    const controller = createV2ThreadController(
      createClient([createGeneration(1, { historyList: reader.historyList })]),
    );

    try {
      await controller.awaitReady();
      expect(controller.getState().messageOrder).toEqual([ASSISTANT_ONE]);

      // The server no longer lists it: the snapshot's silence is a deletion.
      await controller.refresh();
      expect(controller.getState().messageOrder).toEqual([]);
      expect(controller.getState().messages[ASSISTANT_ONE]).toBeUndefined();
    } finally {
      controller.dispose();
    }
  });

  it("takes the snapshot's copy of a message no live event touched", async () => {
    const reader = pagingReader(
      [page(assistantText(ASSISTANT_ONE, "streamed")), page(assistantText(ASSISTANT_ONE, "final"))],
      2,
    );
    const controller = createV2ThreadController(
      createClient([createGeneration(1, { historyList: reader.historyList })]),
    );

    try {
      await controller.awaitReady();
      expect(textOf(controller, ASSISTANT_ONE)).toBe("streamed");

      await controller.refresh();
      expect(textOf(controller, ASSISTANT_ONE)).toBe("final");
    } finally {
      controller.dispose();
    }
  });

  it("keeps a delta that arrives while the read is in flight", async () => {
    const reader = pagingReader(
      [page(assistantText(ASSISTANT_ONE, "hello")), page(assistantText(ASSISTANT_ONE, "hello"))],
      2,
    );
    const generation = createGeneration(1, { historyList: reader.historyList });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();
      expect(textOf(controller, ASSISTANT_ONE)).toBe("hello");

      const refreshing = controller.refresh();
      await reader.readStarted;

      // A live delta for a message the snapshot ALSO carries. The live copy is
      // strictly newer than the page the server had already produced.
      generation.events.emit(textDelta("evt_merge_delta", ASSISTANT_ONE, " world"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      await refreshing;
      expect(textOf(controller, ASSISTANT_ONE)).toBe("hello world");
    } finally {
      controller.dispose();
    }
  });

  it("keeps a message created during the read, after the snapshot's own", async () => {
    const reader = pagingReader([page(assistantText(ASSISTANT_ONE, "one")), page()], 2);
    const generation = createGeneration(1, { historyList: reader.historyList });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();

      const refreshing = controller.refresh();
      await reader.readStarted;

      generation.events.emit(textStarted("evt_merge_started", ASSISTANT_LATE));
      generation.events.emit(textDelta("evt_merge_late", ASSISTANT_LATE, "late response"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The refresh's own snapshot is empty, so only the live message is left -
      // and it is still last.
      await refreshing;
      expect(controller.getState().messageOrder).toEqual([ASSISTANT_LATE]);
      expect(textOf(controller, ASSISTANT_LATE)).toBe("late response");
    } finally {
      controller.dispose();
    }
  });

  it("keeps the snapshot's own order when nothing moved", async () => {
    const reader = pagingReader(
      [
        page(assistantText(ASSISTANT_ONE, "one"), assistantText(ASSISTANT_TWO, "two", 21)),
        page(assistantText(ASSISTANT_ONE, "one"), assistantText(ASSISTANT_TWO, "two", 21)),
      ],
      2,
    );
    const controller = createV2ThreadController(
      createClient([createGeneration(1, { historyList: reader.historyList })]),
    );

    try {
      await controller.awaitReady();
      const before = controller.getState().messageOrder;

      await controller.refresh();
      // The merge appends nothing and reorders nothing: the snapshot's own
      // order is the transcript's, unchanged. (The loader's page reversal is
      // `v2History`'s contract and is not what this case is about.)
      expect(controller.getState().messageOrder).toEqual(before);
      expect([...before].sort()).toEqual([ASSISTANT_ONE, ASSISTANT_TWO]);
    } finally {
      controller.dispose();
    }
  });
});
