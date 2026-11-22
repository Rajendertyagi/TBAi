/**
 * FirstPromptHandoff — the handoff operation must end when the FIRST run
 * settles, not at unmount. The defect this guards: `handoffPending` used to be
 * a ref written inside a promise `.then()`, so the watcher effect never
 * re-evaluated `isRunning` after dispatch and a true→false settle was missed —
 * the handoff id stayed active and was inherited by every later prompt.
 *
 * These tests mount the REAL component in happy-dom with only `useAuiState`
 * faked, then drive `isRunning` through the transitions that broke it.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import * as realReactExports from "@assistant-ui/react";

let fakeBoundSessionId: string | null = null;
let fakeIsRunning = false;

const useAuiStateMock = mock((selector: (state: unknown) => unknown) =>
  selector({
    threadListItem: { externalId: fakeBoundSessionId, remoteId: null },
    thread: { isRunning: fakeIsRunning },
  }),
);

mock.module("@assistant-ui/react", () => ({
  ...realReactExports,
  useAuiState: useAuiStateMock,
}));

const { FirstPromptHandoff } = await import("@web/features/opencode/FirstPromptHandoff");
const { currentOperationId, resetOperationsForTests } = await import("@web/lib/operation");
const { setPendingFirstMessage } = await import("@web/features/chat/state/pendingFirstMessage");

interface Mounted {
  render(sessionId?: string, conversationId?: string): Promise<void>;
  unmount(): void;
}

const mounted: Mounted[] = [];

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(conversationId: string, sessionId: string): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  let currentSession = sessionId;
  let currentConversation = conversationId;
  let unmounted = false;
  const render = async (nextSession?: string, nextConversation?: string): Promise<void> => {
    if (nextSession !== undefined) currentSession = nextSession;
    if (nextConversation !== undefined) currentConversation = nextConversation;
    await act(async () => {
      root.render(
        <FirstPromptHandoff
          conversationId={currentConversation}
          sessionId={currentSession}
          runtime={{ thread: { append: () => Promise.resolve() } }}
          sendWithId={() => Promise.resolve()}
        />,
      );
    });
    await settle();
  };
  await render();
  const handle: Mounted = {
    render,
    unmount() {
      if (unmounted) return;
      unmounted = true;
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(handle);
  return handle;
}

beforeEach(() => {
  resetOperationsForTests();
  fakeBoundSessionId = null;
  fakeIsRunning = false;
  localStorage.clear();
});

afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
  localStorage.clear();
});

describe("FirstPromptHandoff — first-run settle ends the handoff operation", () => {
  it("ends the operation on isRunning true→false after dispatch", async () => {
    setPendingFirstMessage("conv-lc-1", "first prompt");
    fakeBoundSessionId = "ses_lc_1";
    const m = await mount("conv-lc-1", "ses_lc_1");

    // Dispatch resolved and armed the watcher; the id is live for the run.
    expect(currentOperationId("ses_lc_1")).toMatch(/^op_/);

    // Run starts, then settles.
    fakeIsRunning = true;
    await m.render();
    expect(currentOperationId("ses_lc_1")).toMatch(/^op_/);

    fakeIsRunning = false;
    await m.render();
    expect(currentOperationId("ses_lc_1")).toBeUndefined();
  });

  it("ends the operation when isRunning was already true at dispatch time", async () => {
    // This is the case the ref-only watcher missed: isRunning flips true
    // before the dispatch promise resolves, so the watcher must re-evaluate
    // with the current value once armed.
    setPendingFirstMessage("conv-lc-2", "first prompt");
    fakeBoundSessionId = "ses_lc_2";
    fakeIsRunning = true;
    const m = await mount("conv-lc-2", "ses_lc_2");

    expect(currentOperationId("ses_lc_2")).toMatch(/^op_/);

    fakeIsRunning = false;
    await m.render();
    expect(currentOperationId("ses_lc_2")).toBeUndefined();
  });

  it("does not end a later session's handoff when an earlier one settles", async () => {
    setPendingFirstMessage("conv-lc-a", "a");
    setPendingFirstMessage("conv-lc-b", "b");
    fakeBoundSessionId = "ses_lc_a";
    const a = await mount("conv-lc-a", "ses_lc_a");
    fakeBoundSessionId = "ses_lc_b";
    const b = await mount("conv-lc-b", "ses_lc_b");

    const idA = currentOperationId("ses_lc_a");
    const idB = currentOperationId("ses_lc_b");
    expect(idA).toMatch(/^op_/);
    expect(idB).toMatch(/^op_/);
    expect(idA).not.toBe(idB);

    fakeIsRunning = true;
    await a.render();
    await b.render();
    fakeIsRunning = false;
    await a.render();

    expect(currentOperationId("ses_lc_a")).toBeUndefined();
    expect(currentOperationId("ses_lc_b")).toBe(idB);
  });

  it("does not let a previous session's stale state end the new session's handoff", async () => {
    // The component is not keyed by sessionId: switching sessions reuses the
    // instance. Stale `armed`/`runObserved` from A must not end B's just-started
    // operation, and a late A dispatch must not re-arm the watcher for B.
    setPendingFirstMessage("conv-sess-a", "a");
    setPendingFirstMessage("conv-sess-b", "b");
    fakeBoundSessionId = "ses_sess_a";
    const m = await mount("conv-sess-a", "ses_sess_a");

    fakeIsRunning = true;
    await m.render();
    expect(currentOperationId("ses_sess_a")).toMatch(/^op_/);

    // A's run settles in the store, but the session switches to B before the
    // watcher can process that settle (same component instance, no key).
    fakeIsRunning = false;
    fakeBoundSessionId = "ses_sess_b";
    await m.render("ses_sess_b", "conv-sess-b");
    expect(currentOperationId("ses_sess_a")).toBeUndefined();
    expect(currentOperationId("ses_sess_b")).toMatch(/^op_/);

    // B's own run starts and settles normally.
    fakeIsRunning = true;
    await m.render();
    fakeIsRunning = false;
    await m.render();
    expect(currentOperationId("ses_sess_b")).toBeUndefined();
  });

  it("ends the operation on unmount before the run settles", async () => {
    setPendingFirstMessage("conv-unmount", "first");
    fakeBoundSessionId = "ses_unmount";
    const m = await mount("conv-unmount", "ses_unmount");
    expect(currentOperationId("ses_unmount")).toMatch(/^op_/);

    m.unmount();
    expect(currentOperationId("ses_unmount")).toBeUndefined();
  });

  it("characterizes the fast-run window where isRunning is never observed true", async () => {
    // Documented tradeoff: without ever seeing isRunning true, the watcher
    // cannot distinguish "run already finished" from "run not yet started".
    // Ending eagerly would risk cutting off the first run's requests during a
    // state-update lag, so the op stays armed until unmount. The first run's
    // requests are still correctly correlated (the op was live at dispatch).
    setPendingFirstMessage("conv-fast", "first");
    fakeBoundSessionId = "ses_fast";
    fakeIsRunning = false;
    const m = await mount("conv-fast", "ses_fast");
    expect(currentOperationId("ses_fast")).toMatch(/^op_/);

    m.unmount();
    expect(currentOperationId("ses_fast")).toBeUndefined();
  });
});
