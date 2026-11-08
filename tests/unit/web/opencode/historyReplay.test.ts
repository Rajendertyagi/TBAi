/**
 * The rule that decides what a held event may re-apply to a snapshot.
 *
 * The defect these pin: the commit installed the snapshot's copy of a message,
 * and every held event was then replayed on top of it. A text delta that the
 * snapshot already contained (the server persists a part at `text.ended`, which
 * it commits BEFORE publishing) was therefore appended a second time, and a
 * delta the server had NOT persisted yet (a streaming part is stored empty) was
 * dropped whenever it predated the read's ordinal boundary. The first shows the
 * answer twice, the second shows it truncated; both are text the reader sees.
 */

import { describe, expect, it } from "bun:test";
import type { V2Event } from "@opencode/client";
import type { V2MessageState, V2MessagePartState } from "@web/features/opencode/v2Types.ts";
import {
  coveredTextPartIds,
  deltaPartId,
  shouldReplayBuffered,
} from "@web/features/opencode/sync/historyReplay.ts";

const MESSAGE_ID = "assistant-replay-test";
const BOUNDARY = 4;

function textDelta(ordinal: number, delta: string): V2Event {
  return {
    id: `evt_text_${ordinal}_${delta}`,
    created: 10,
    type: "session.text.delta",
    data: { sessionID: "ses_replay_test", assistantMessageID: MESSAGE_ID, ordinal, delta },
  } as V2Event;
}

function reasoningDelta(ordinal: number, delta: string): V2Event {
  return {
    id: `evt_reasoning_${ordinal}_${delta}`,
    created: 10,
    type: "session.reasoning.delta",
    data: { sessionID: "ses_replay_test", assistantMessageID: MESSAGE_ID, ordinal, delta },
  } as V2Event;
}

function toolInputDelta(toolId: string, delta: string): V2Event {
  return {
    id: `evt_tool_${toolId}_${delta}`,
    created: 10,
    type: "session.tool.input.delta",
    data: { sessionID: "ses_replay_test", assistantMessageID: MESSAGE_ID, id: toolId, delta },
  } as V2Event;
}

function textEnded(ordinal: number, text: string): V2Event {
  return {
    id: `evt_ended_${ordinal}`,
    created: 10,
    type: "session.text.ended",
    durable: { aggregateID: "ses_replay_test", seq: 9, version: 1 },
    data: { sessionID: "ses_replay_test", assistantMessageID: MESSAGE_ID, ordinal, text } as never,
  } as V2Event;
}

/** A message carrying exactly the parts given. */
function message(parts: readonly V2MessagePartState[]): V2MessageState {
  return {
    id: MESSAGE_ID,
    parentId: null,
    role: "assistant",
    createdAt: 1,
    parts,
    source: null,
  };
}

const TEXT_PART: V2MessagePartState = {
  kind: "text",
  id: `text:${MESSAGE_ID}:0`,
  order: 0,
  value: "Hello",
  status: "complete",
};

const EMPTY_TEXT_PART: V2MessagePartState = { ...TEXT_PART, value: "" };

describe("the history replay rule", () => {
  it("names the part each delta writes to", () => {
    expect(deltaPartId(textDelta(2, "x"))).toBe(`text:${MESSAGE_ID}:2`);
    expect(deltaPartId(reasoningDelta(1, "x"))).toBe(`reasoning:${MESSAGE_ID}:1`);
    expect(deltaPartId(toolInputDelta("tool-1", "{"))).toBe(`tool:${MESSAGE_ID}:tool-1`);
    expect(deltaPartId(textEnded(0, "x"))).toBeNull();
  });

  it("covers a part only when the snapshot carries text for it", () => {
    expect([...coveredTextPartIds([message([TEXT_PART])])]).toEqual([`text:${MESSAGE_ID}:0`]);
    expect([...coveredTextPartIds([message([EMPTY_TEXT_PART])])]).toEqual([]);
    expect([
      ...coveredTextPartIds([
        message([{ ...TEXT_PART, kind: "reasoning", id: `reasoning:${MESSAGE_ID}:0` }]),
      ]),
    ]).toEqual([`reasoning:${MESSAGE_ID}:0`]);
    // A tool part speaks for its arguments only through the raw text the server
    // persisted; parsed input alone is not a stream this rule can extend.
    expect([
      ...coveredTextPartIds([
        message([
          {
            kind: "tool",
            id: `tool:${MESSAGE_ID}:tool-1`,
            order: 0,
            name: "shell",
            input: { text: '{"command":"ls"}' },
            output: undefined,
            status: "running",
          },
        ]),
      ]),
    ]).toEqual([`tool:${MESSAGE_ID}:tool-1`]);
    expect([
      ...coveredTextPartIds([
        message([
          {
            kind: "tool",
            id: `tool:${MESSAGE_ID}:tool-1`,
            order: 0,
            name: "shell",
            input: { command: "ls" },
            output: undefined,
            status: "running",
          },
        ]),
      ]),
    ]).toEqual([]);
  });

  it("does not replay a held delta into a part the snapshot finished", () => {
    const covered = coveredTextPartIds([message([TEXT_PART])]);
    expect(
      shouldReplayBuffered(
        { ordinal: BOUNDARY + 1, event: textDelta(0, "Hello") },
        BOUNDARY,
        covered,
      ),
    ).toBe(false);
  });

  it("replays every delta of a part the snapshot carries empty, including ones before the read", () => {
    const covered = coveredTextPartIds([message([EMPTY_TEXT_PART])]);
    expect(
      shouldReplayBuffered({ ordinal: 2, event: textDelta(0, "Hel") }, BOUNDARY, covered),
    ).toBe(true);
    expect(
      shouldReplayBuffered({ ordinal: BOUNDARY + 1, event: textDelta(0, "lo") }, BOUNDARY, covered),
    ).toBe(true);
  });

  it("replays a pre-read text delta, but not a pre-read event whose effect is persisted", () => {
    const covered = coveredTextPartIds([message([EMPTY_TEXT_PART])]);
    expect(
      shouldReplayBuffered(
        { ordinal: BOUNDARY + 1, event: textEnded(0, "Hello") },
        BOUNDARY,
        covered,
      ),
    ).toBe(true);
    expect(
      shouldReplayBuffered({ ordinal: 2, event: textEnded(0, "Hello") }, BOUNDARY, covered),
    ).toBe(false);
  });

  it("replays a tool-input delta only when it arrived during the read", () => {
    // A delta alone cannot rebuild a tool part: the name arrives only in
    // `session.tool.input.started`, so a pre-read one is dropped rather than
    // replaying an "unknown" part.
    const covered = coveredTextPartIds([message([])]);
    expect(
      shouldReplayBuffered({ ordinal: 2, event: toolInputDelta("tool-1", "{") }, BOUNDARY, covered),
    ).toBe(false);
    expect(
      shouldReplayBuffered(
        { ordinal: BOUNDARY + 1, event: toolInputDelta("tool-1", "{") },
        BOUNDARY,
        covered,
      ),
    ).toBe(true);
  });
});
