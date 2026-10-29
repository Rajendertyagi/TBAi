/**
 * The engine gate on the Direct status pill, asserted BEHAVIOURALLY.
 *
 * ## What this file proves
 *
 * `ChatWindow` is shared by both engines. The Direct pill inside it reads the
 * THREAD, so before S3 it rendered in Code mode too — where the OpenCode primary
 * (`OpenCodePrimaryStatus`, supplied by `OpenCodeView`) already owns the same
 * turn. That is two surfaces reporting one fact. S3 gates the Direct pill to
 * `mode === "chat"`; this case is the guard: one `[data-primary-status]` in
 * Direct chat, none in Code mode.
 *
 * ## Why the heavy children are mocked
 *
 * The subject is one line of composition, not the transcript, composer, or
 * welcome flow. `VirtualizedTranscript` would render every message row (and the
 * whole tool-UI tree) and `Composer` pulls the provider/MCP stores; neither can
 * change the gate. They are replaced with `null`, and the REAL `ChatWindow`
 * composes around them under the real `useExternalStoreRuntime`, so the pill's
 * own state path (`useAssistantActivity` → `activityFromParts`) is exercised.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";

// ── heavy, unrelated children ────────────────────────────────────────────────

// The mocked transcript renders nothing, so no element can be inside a
// transcript that owns scroll compensation; that is what the hook reports.
mock.module("@web/components/VirtualizedTranscript.tsx", () => ({
  VirtualizedTranscript: () => null,
  useTranscriptOwnsScrollCompensation: () => false,
}));
mock.module("@web/components/ScrollPill.tsx", () => ({ ScrollPill: () => null }));
mock.module("@web/features/chat/history/DirectViewportBridge.tsx", () => ({
  DirectViewportBridge: () => null,
}));
mock.module("@web/components/assistant-ui/elements/thread-boot-skeleton.tsx", () => ({
  ThreadBootSkeleton: () => null,
}));
mock.module("@web/components/Composer.tsx", () => ({ Composer: () => null }));
mock.module("@web/features/chat/components/WelcomeScreen.tsx", () => ({
  WelcomeScreen: () => null,
}));
mock.module("@web/features/chat/components/WelcomeScopePicker.tsx", () => ({
  WelcomeScopePicker: () => null,
}));

// ── the component, imported AFTER the mocks are registered ───────────────────

const { ChatWindow } = await import("@web/components/ChatWindow.tsx");

/**
 * A running turn: one streaming reasoning part, which is the simplest state that
 * makes the Direct pill render. It is engine-neutral, so both modes read it.
 */
const RUNNING: ThreadMessageLike[] = [
  {
    id: "assistant_running",
    role: "assistant",
    status: { type: "running" },
    content: [{ type: "reasoning", text: "planning the change", status: { type: "running" } }],
  },
];

function Scene({ mode }: { mode: "chat" | "agent" }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: RUNNING,
    isRunning: true,
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatWindow mode={mode} />
    </AssistantRuntimeProvider>
  );
}

interface Mounted {
  readonly root: Root;
  readonly container: HTMLElement;
}

const mounted: Mounted[] = [];

async function mount(mode: "chat" | "agent"): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Scene mode={mode} />);
  });
  // Let the runtime's adapter effect and notification settle before asserting.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const entry = { root, container };
  mounted.push(entry);
  return entry;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("the Direct status pill renders only in Direct chat", () => {
  it("renders exactly one primary in chat mode", async () => {
    const { container } = await mount("chat");

    const primaries = container.querySelectorAll("[data-primary-status]");
    expect(primaries).toHaveLength(1);
    // It is the Direct pill, carrying the activity the hook derived from the
    // thread — not an empty marker.
    expect(primaries[0]?.textContent ?? "").toContain("Thinking…");
  });

  it("renders none in agent mode", async () => {
    const { container } = await mount("agent");

    // Code mode's primary is supplied by its own runtime owner through the
    // `status` slot of `composerExtras`; composing a second one here would
    // report the same turn twice.
    expect(container.querySelectorAll("[data-primary-status]")).toHaveLength(0);
  });
});
