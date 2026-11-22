/**
 * OpenCode activity publisher — teardown and hide behavior.
 *
 * A Dockview panel may be hidden or unmounted while the backend session keeps
 * executing. The publisher must leave the last honest state in the projection:
 * it must never publish `idle` on hide or unmount, because that would silence a
 * running indicator for work that is still happening detached.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { V2ExecutionOutcomeRecord } from "@web/features/opencode/sync/executionFacts";

const CONVERSATION = "conv-opencode-unmount";

interface ProjectionSlice {
  hasActiveSessionWork: boolean;
  pendingLifecycle: { cancellationPending: boolean };
  health: { degraded: boolean };
  lastOutcome: V2ExecutionOutcomeRecord;
}

function noOutcome(): V2ExecutionOutcomeRecord {
  return {
    outcome: "none",
    attribution: "unattributed",
    binding: { kind: "unbound" },
    evidence: {
      serverEventId: null,
      durableAggregateId: null,
      durableSeq: null,
      durableVersion: null,
    },
  };
}

/** Mutable projection slice; null models a hidden surface with no native extras. */
let projection: ProjectionSlice | null = null;

mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () => (projection === null ? null : { projection }),
}));

const { OpenCodeActivityPublisher } = await import(
  "@web/features/opencode/openCodeActivityPublisher"
);
const { useConversationActivityStore } = await import(
  "@web/features/chat/state/conversationActivity"
);

function runningProjection(): ProjectionSlice {
  return {
    hasActiveSessionWork: true,
    pendingLifecycle: { cancellationPending: false },
    health: { degraded: false },
    lastOutcome: noOutcome(),
  };
}

describe("OpenCodeActivityPublisher teardown", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mounted = false;
    projection = runningProjection();
    useConversationActivityStore.getState().clear(CONVERSATION);
  });

  afterEach(() => {
    if (mounted) act(() => root.unmount());
    container.remove();
    projection = null;
  });

  it("keeps the running state when the host unmounts", () => {
    act(() => {
      root.render(<OpenCodeActivityPublisher conversationId={CONVERSATION} />);
    });
    mounted = true;
    expect(useConversationActivityStore.getState().get(CONVERSATION)?.execution).toBe("running");

    act(() => root.unmount());
    mounted = false;
    expect(useConversationActivityStore.getState().get(CONVERSATION)?.execution).toBe("running");
  });

  it("does not publish idle when the surface is hidden", () => {
    act(() => {
      root.render(<OpenCodeActivityPublisher conversationId={CONVERSATION} />);
    });
    mounted = true;
    expect(useConversationActivityStore.getState().get(CONVERSATION)?.execution).toBe("running");

    // Hiding removes the native extras; the publisher must leave the state alone.
    projection = null;
    act(() => {
      root.render(<OpenCodeActivityPublisher conversationId={CONVERSATION} />);
    });
    expect(useConversationActivityStore.getState().get(CONVERSATION)?.execution).toBe("running");
    expect(useConversationActivityStore.getState().get(CONVERSATION)?.execution).not.toBe("idle");
  });
});
