/**
 * The real Composer and the real queued-prompt controls, wired to the real
 * native runtime and controller.
 *
 * The existing `OpenCodeQueuedPrompts.test.tsx` proves the control's own
 * behaviour against a mocked extras surface, and the controller suite proves
 * A/B isolation at the wire. Neither proves the SEAM: that the Stop control the
 * reader actually clicks is bound to the active execution, and that the Cancel
 * control beside it reaches only `cancelQueuedPrompt` for its own queued
 * prompt. A projection proxy can agree with itself while the mounted Composer
 * is wired to the wrong callback, so this file mounts both real surfaces.
 *
 * Only the OpenCode chips are stubbed: they are independent of this contract
 * and read session stores this harness does not stand up. The Composer, the
 * queued control, the runtime adapter and the controller are the real ones.
 */

import { describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { V2Event } from "@opencode/client";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import { useV2AssistantRuntime } from "@web/features/opencode/v2Runtime.tsx";
import {
  SESSION_ID,
  USER_MESSAGE,
  createClient,
  createGeneration,
  userInbox,
} from "@web/testing/opencode/v2ThreadControllerHarness";

mock.module("@web/features/opencode/OpenCodeChipsAndRing.tsx", () => ({
  OpenCodeChipsAndRing: () => null,
}));

const { Composer } = await import("@web/components/Composer.tsx");
const { OpenCodeQueuedPrompts } = await import("@web/features/opencode/OpenCodeQueuedPrompts.tsx");

const STOP_LABEL = "Stop generating";

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function executionStarted(): V2Event {
  return {
    id: "evt_exec_a_started",
    created: 10,
    type: "session.execution.started",
    durable: { aggregateID: SESSION_ID, seq: 10, version: 1 },
    data: { sessionID: SESSION_ID },
  } as V2Event;
}

function inboxCancelled(inboxId: string, seq: number): V2Event {
  return {
    id: `evt_cancelled_${inboxId}`,
    created: 10 + seq,
    type: "session.inbox.cancelled",
    durable: { aggregateID: SESSION_ID, seq, version: 1 },
    data: { sessionID: SESSION_ID, inboxID: inboxId },
  } as V2Event;
}

describe("Code composer + queued prompts integration", () => {
  it("keeps Stop bound to A while Cancel targets only queued B", async () => {
    const generation = createGeneration(1);
    const controller = createV2ThreadController(createClient([generation]), {
      promptAdmissionTimeoutMs: 5_000,
    });
    await controller.awaitReady();

    function Harness() {
      const runtime = useV2AssistantRuntime(controller, null);
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <OpenCodeQueuedPrompts />
          <Composer isCodeSurface />
        </AssistantRuntimeProvider>
      );
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);

    try {
      await act(async () => {
        root.render(<Harness />);
      });

      // A: an active execution bound to prompt msg_a.
      generation.setPromptHandler(async () => userInbox("inbox_a", "steer"));
      await act(async () => {
        await controller.sendMessage(USER_MESSAGE, {
          messageId: "msg_a",
          delivery: "steer",
        });
        generation.events.emit(executionStarted());
        // A steer prompt is admitted as an inbox item; once execution is active
        // it is no longer a queued prompt the reader can cancel independently.
        // The server removes a consumed inbox entry; model that here so only B
        // remains in the queued list.
        generation.events.emit(inboxCancelled("inbox_a", 11));
        await waitFor(() => controller.getProjection().composerStopAvailable);
        await waitFor(
          () =>
            !controller
              .getProjection()
              .queuedPromptActions.some((action) => action.promptId === "msg_a"),
        );
      });

      // B: an admitted queued prompt, independently cancellable.
      generation.setPromptHandler(async () => userInbox("inbox_b", "queue"));
      await act(async () => {
        await controller.sendMessage(USER_MESSAGE, {
          messageId: "msg_b",
          delivery: "queue",
        });
        await waitFor(() =>
          controller
            .getProjection()
            .queuedPromptActions.some((action) => action.promptId === "msg_b"),
        );
      });

      const stopOperation = controller.getProjection().composerStopOperation;
      expect(stopOperation.kind).toBe("stop-current-execution");
      if (stopOperation.kind === "stop-current-execution") {
        // No runtime evidence binds the execution to a prompt today, so Stop is
        // an explicit session-wide stop of the ACTIVE execution. It must not
        // borrow A's prompt identity (or B's) merely because A started it.
        expect(stopOperation.promptId).toBeNull();
        expect(stopOperation.inboxId).toBeNull();
        expect(stopOperation.scope).toBe("session-wide");
      }

      const stop = container.querySelector<HTMLButtonElement>(`button[aria-label="${STOP_LABEL}"]`);
      expect(stop).not.toBeNull();

      const cancelB = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Cancel queued prompt msg_b"]',
      );
      expect(cancelB).not.toBeNull();
      expect(cancelB?.disabled).toBe(false);

      // Cancel B reaches only the queued-prompt cancellation.
      await act(async () => {
        cancelB?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(generation.inboxCancelInputs).toHaveLength(1);
      expect(generation.inboxCancelInputs[0]?.inboxID).toBe("inbox_b");
      expect(generation.interruptInputs).toHaveLength(0);

      // A and its Stop control survive cancelling B.
      expect(
        container.querySelector<HTMLButtonElement>(`button[aria-label="${STOP_LABEL}"]`),
      ).not.toBeNull();
      expect(controller.getProjection().composerStopAvailable).toBe(true);
      expect(controller.getProjection().hasActiveSessionWork).toBe(true);
      const cancelBAfter = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Cancel queued prompt msg_b"]',
      );
      expect(cancelBAfter?.disabled).toBe(true);
      expect(cancelBAfter?.textContent ?? "").toContain("Cancelling");

      // Confirmed by server evidence: the inbox row is gone, so the queued
      // control disappears and no cancellation intent remains pending. The row
      // leaving the list IS the confirmed render — a "confirmed" label is never
      // shown for a prompt the reader can no longer see.
      generation.events.emit(inboxCancelled("inbox_b", 12));
      await act(async () => {
        await waitFor(
          () =>
            !controller
              .getProjection()
              .queuedPromptActions.some((action) => action.promptId === "msg_b"),
        );
      });
      expect(controller.getProjection().pendingLifecycle.cancellationPending).toBe(false);
      await act(async () => {
        await waitFor(
          () => container.querySelector('[data-slot="opencode-queued-prompts"]') === null,
        );
      });
      expect(container.querySelector('[data-slot="opencode-queued-prompts"]')).toBeNull();
      expect(generation.inboxCancelInputs).toHaveLength(1);
      expect(controller.getProjection().pendingLifecycle.cancellationPending).toBe(false);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
      {
        const queue = container.querySelector('[data-slot="opencode-queued-prompts"]');
        if (queue)
          throw new Error(
            `DIAG2 queue remains: ${queue.outerHTML} projection=${JSON.stringify(controller.getProjection().queuedPromptActions)}`,
          );
      }
      expect(container.querySelector('[data-slot="opencode-queued-prompts"]')).toBeNull();
      expect(generation.inboxCancelInputs).toHaveLength(1);

      // Stop is the active execution's own cancellation, not a queue action.
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(`button[aria-label="${STOP_LABEL}"]`)
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(generation.interruptInputs).toHaveLength(1);
      expect(generation.interruptInputs[0]?.sessionID).toBe(SESSION_ID);
      expect(generation.inboxCancelInputs).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      container.remove();
      controller.dispose();
    }
  });
});
