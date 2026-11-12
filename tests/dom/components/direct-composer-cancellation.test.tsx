/**
 * Direct Composer Send/Stop and cancellation regression suite.
 *
 * Verifies:
 * 1. Send button is available when no Direct execution is active (isRunning = false).
 * 2. Stop button is shown when Direct execution is active (isRunning = true).
 * 3. Clicking Stop invokes Direct cancelActiveRun with the thread id.
 * 4. OpenCode V2's stopComposer separation does NOT invoke Direct cancelActiveRun.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";

// Mock child widgets so this suite isolates Composer action buttons
mock.module("@web/components/composer/DirectChips", () => ({
  ThinkingChip: () => null,
  ModelChip: () => null,
}));
mock.module("@web/components/context-ring", () => ({
  DirectContextRing: () => null,
}));
mock.module("@web/features/opencode/OpenCodeChipsAndRing", () => ({
  OpenCodeChipsAndRing: () => null,
}));

let cancelCalls: (string | null | undefined)[] = [];
mock.module("@web/features/chat/state/deleteConversation", () => ({
  cancelActiveRun: async (threadKey: string | null | undefined) => {
    cancelCalls.push(threadKey);
    return true;
  },
}));

const { Composer } = await import("@web/components/Composer.tsx");

function DirectHarness({
  isRunning,
  isCodeSurface = false,
}: {
  isRunning: boolean;
  isCodeSurface?: boolean;
}) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    isRunning,
    messages: [] as ThreadMessageLike[],
    convertMessage: (message) => message,
    onNew: async () => {},
    onCancel: async () => {},
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Composer isCodeSurface={isCodeSurface} />
    </AssistantRuntimeProvider>
  );
}

describe("Direct Composer Send/Stop and cancellation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    cancelCalls = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("shows Send button when no Direct execution is active", async () => {
    await act(async () => {
      root.render(<DirectHarness isRunning={false} isCodeSurface={false} />);
    });

    const sendBtn = container.querySelector('button[aria-label="Send message"]');
    const stopBtn = container.querySelector('button[aria-label="Stop generating"]');

    expect(sendBtn).not.toBeNull();
    expect(stopBtn).toBeNull();
  });

  it("shows Stop button when Direct execution is active", async () => {
    await act(async () => {
      root.render(<DirectHarness isRunning={true} isCodeSurface={false} />);
    });

    const sendBtn = container.querySelector('button[aria-label="Send message"]');
    const stopBtn = container.querySelector('button[aria-label="Stop generating"]');

    expect(sendBtn).toBeNull();
    expect(stopBtn).not.toBeNull();
    expect((stopBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("clicking Stop in Direct mode triggers cancelActiveRun", async () => {
    await act(async () => {
      root.render(<DirectHarness isRunning={true} isCodeSurface={false} />);
    });

    const stopBtn = container.querySelector(
      'button[aria-label="Stop generating"]',
    ) as HTMLButtonElement | null;
    expect(stopBtn).not.toBeNull();
    expect(stopBtn?.disabled).toBe(false);

    await act(async () => {
      stopBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(cancelCalls.length).toBe(1);
  });

  it("clicking Stop in Code surface mode does NOT invoke Direct cancelActiveRun", async () => {
    await act(async () => {
      root.render(<DirectHarness isRunning={true} isCodeSurface={true} />);
    });

    const stopBtn = container.querySelector(
      'button[aria-label="Stop generating"]',
    ) as HTMLButtonElement | null;
    expect(stopBtn).not.toBeNull();

    await act(async () => {
      stopBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // In Code surface mode, cancellation is handed off to OpenCode V2's onCancel/stopComposer,
    // so Direct cancelActiveRun is never called.
    expect(cancelCalls.length).toBe(0);
  });
});
