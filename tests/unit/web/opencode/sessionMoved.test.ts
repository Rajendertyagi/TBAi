import { describe, expect, it } from "bun:test";
import type { V2Event } from "@opencode/client";
import {
  createInitialV2ThreadState,
  reduceV2Event,
  reduceV2ThreadState,
} from "@web/features/opencode/v2Events.ts";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  SESSION_ID,
  DIRECTORY,
  createClient,
  createGeneration,
  waitForState,
} from "@web/testing/opencode/v2ThreadControllerHarness";

const CONVERSATION_ID = "conv_move_test";
const NEW_DIR = "D:\\workspace\\moved_target";

function createMovedEvent(opts: {
  sessionId: string;
  newDirectory: string;
  eventLocationDirectory?: string;
  id?: string;
}): V2Event {
  return {
    id: opts.id ?? "evt_moved_001",
    created: Date.now(),
    type: "session.moved",
    ...(opts.eventLocationDirectory
      ? { location: { directory: opts.eventLocationDirectory } }
      : {}),
    data: {
      sessionID: opts.sessionId,
      location: { directory: opts.newDirectory },
      projectID: "proj_moved_test",
    },
  } as unknown as V2Event;
}

describe("session.moved event handling", () => {
  describe("reduceV2Event reducer", () => {
    it("updates directory and session location on session.moved for current session", () => {
      const state = createInitialV2ThreadState(SESSION_ID, DIRECTORY);
      const hydrated = reduceV2ThreadState(state, {
        type: "session_hydrated",
        session: {
          id: SESSION_ID,
          projectID: "proj_1",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          location: { directory: DIRECTORY },
        },
      });

      const movedEvent = createMovedEvent({
        sessionId: SESSION_ID,
        newDirectory: NEW_DIR,
      });

      const next = reduceV2Event(hydrated, movedEvent);

      expect(next.directory).toBe(NEW_DIR);
      expect(next.session?.location.directory).toBe(NEW_DIR);
      expect(next.diagnosticCount).toBe(0);
    });

    it("admits session.moved into scope even when its location differs from subscribed directory", () => {
      // Event carries the new directory in event.location, but state is still subscribed to DIRECTORY
      const state = createInitialV2ThreadState(SESSION_ID, DIRECTORY);
      const movedEvent = createMovedEvent({
        sessionId: SESSION_ID,
        newDirectory: NEW_DIR,
        eventLocationDirectory: NEW_DIR,
      });

      const next = reduceV2Event(state, movedEvent);

      // Must be applied, not dropped by isEventInScope
      expect(next.directory).toBe(NEW_DIR);
      expect(next.diagnosticCount).toBe(0);
    });

    it("ignores session.moved for a different session ID", () => {
      const state = createInitialV2ThreadState(SESSION_ID, DIRECTORY);
      const movedEvent = createMovedEvent({
        sessionId: "ses_other_unrelated",
        newDirectory: NEW_DIR,
      });

      const next = reduceV2Event(state, movedEvent);

      expect(next.directory).toBe(DIRECTORY);
      // Ignored and counted in diagnostics
      expect(next.diagnosticCount).toBe(1);
    });

    it("handles stale or duplicate session.moved idempotently", () => {
      const state = createInitialV2ThreadState(SESSION_ID, NEW_DIR);
      const duplicateEvent = createMovedEvent({
        sessionId: SESSION_ID,
        newDirectory: NEW_DIR,
      });

      const next = reduceV2Event(state, duplicateEvent);

      expect(next.directory).toBe(NEW_DIR);
      expect(next.diagnosticCount).toBe(0);
    });
  });

  describe("v2ThreadController move reconciliation", () => {
    it("triggers reconcileDirectory and reconnects event stream while preserving session and history", async () => {
      const gen1 = createGeneration(1);
      const gen2 = createGeneration(2);
      const client = createClient([gen1, gen2]);

      const reconciledCalls: Array<{ conversationId: string; sessionId: string }> = [];
      const onDirectoryChangedCalls: string[] = [];

      const reconcileDirectory = async (input: { conversationId: string; sessionId: string }) => {
        reconciledCalls.push(input);
        return { directory: NEW_DIR };
      };

      const onDirectoryChanged = (newDir: string) => {
        onDirectoryChangedCalls.push(newDir);
      };

      const controller = createV2ThreadController(client, undefined, {
        conversationId: CONVERSATION_ID,
        fetchActivity: async () => "not-running",
        reconcileDirectory,
        onDirectoryChanged,
      });

      try {
        await controller.awaitReady();
        expect(controller.getState().directory).toBe(DIRECTORY);

        // Deliver session.moved event on the first stream
        const movedEvent = createMovedEvent({
          sessionId: SESSION_ID,
          newDirectory: NEW_DIR,
        });

        gen1.events.emit(movedEvent);

        // Wait for asynchronous reconciliation to complete
        await waitForState(controller, () => onDirectoryChangedCalls.length > 0);

        expect(reconciledCalls).toEqual([
          { conversationId: CONVERSATION_ID, sessionId: SESSION_ID },
        ]);
        expect(onDirectoryChangedCalls).toEqual([NEW_DIR]);

        // Same session ID and conversation ID preserved
        expect(controller.getState().sessionId).toBe(SESSION_ID);
        expect(controller.getState().directory).toBe(NEW_DIR);
      } finally {
        controller.dispose();
      }
    });

    it("ignores session.moved for an unrelated session without calling reconcileDirectory", async () => {
      const gen1 = createGeneration(1);
      const client = createClient([gen1]);

      let reconcileCalled = false;
      const reconcileDirectory = async () => {
        reconcileCalled = true;
        return { directory: NEW_DIR };
      };

      const controller = createV2ThreadController(client, undefined, {
        conversationId: CONVERSATION_ID,
        fetchActivity: async () => "not-running",
        reconcileDirectory,
      });

      try {
        await controller.awaitReady();

        const unrelatedEvent = createMovedEvent({
          sessionId: "ses_unrelated_foreign",
          newDirectory: NEW_DIR,
        });

        gen1.events.emit(unrelatedEvent);

        // Allow microtasks to settle
        await new Promise((r) => setTimeout(r, 50));

        expect(reconcileCalled).toBe(false);
        expect(controller.getState().directory).toBe(DIRECTORY);
      } finally {
        controller.dispose();
      }
    });
  });
});
