/**
 * WS6 — error/footer DOM position.
 *
 * The error card and the assistant turn footer must sit OUTSIDE the
 * Thinking/Reasoning block and the tool-group container. They are the closing
 * chrome of a turn, not part of a reasoning or tool disclosure. This file pins
 * that structure in the REAL row composition (the same `ChatRow` the transcript
 * uses), for both the Direct (`chat`) and Code (`agent`) surfaces.
 *
 * The assertions use DOM ancestry, not layout: a node is "outside" a container
 * when `closest('[data-slot="..."]')` does not return that container. This is a
 * structural contract, so it holds regardless of CSS. A guard test confirms the
 * reasoning container actually renders, so the ancestry assertion is not
 * vacuous. (This harness renders reasoning reliably; the row selector's groupBy
 * groups only reasoning, so tool calls render as ungrouped `tool-call` parts and
 * no tool-group container is produced here. The selector covers both slots, but
 * the guard asserts the one this harness can render.)
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";

// Unrelated heavy children, so this suite stays about message chrome.
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
mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () => null,
  isV2RuntimeExtras: () => false,
}));

const { ChatRow } = await import("@web/components/ChatWindow.tsx");
const { selectTranscriptRows } = await import("@web/components/VirtualizedTranscript.tsx");

const DETAIL = "Provider rejected the request: unsupported model parameters.";
const USER: ThreadMessageLike = {
  id: "user_1",
  role: "user",
  content: [{ type: "text", text: "build it" }],
};

/** A failed assistant turn with reasoning, a tool call, and text. */
function failedWithParts(): ThreadMessageLike {
  return {
    id: "assistant_failed",
    role: "assistant",
    status: { type: "incomplete", reason: "error", error: { code: "unknown", message: DETAIL } },
    content: [
      { type: "reasoning", text: "planning the change", status: { type: "complete" } },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "shell",
        args: { command: "echo hi" },
        argsText: JSON.stringify({ command: "echo hi" }),
        result: { content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "tool-call",
        toolCallId: "call_2",
        toolName: "shell",
        args: { command: "echo bye" },
        argsText: JSON.stringify({ command: "echo bye" }),
        result: { content: [{ type: "text", text: "bye" }] },
      },
      { type: "text", text: "partial answer", status: { type: "complete" } },
    ],
  };
}

function Rows({ mode }: { mode: "chat" | "agent" }) {
  const rows = useAuiState(selectTranscriptRows);
  return (
    <div>
      {rows.map((row) => (
        <div key={row.key} data-row-key={row.key}>
          <ThreadPrimitive.Row row={row}>
            {(info) => <ChatRow info={info} mode={mode} />}
          </ThreadPrimitive.Row>
        </div>
      ))}
    </div>
  );
}

function Scene({ mode }: { mode: "chat" | "agent" }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [USER, failedWithParts()],
    isRunning: false,
    convertMessage: (m) => m,
    onNew: async () => {},
    onReload: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Rows mode={mode} />
    </AssistantRuntimeProvider>
  );
}

const mounted: { root: Root; container: HTMLElement }[] = [];
async function mount(mode: "chat" | "agent") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Scene mode={mode} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  mounted.push({ root, container });
  return container;
}
afterEach(() => {
  for (const e of mounted.splice(0)) {
    act(() => e.root.unmount());
    e.container.remove();
  }
});

const OUTSIDE_SELECTOR = '[data-slot="reasoning-root"], [data-slot="tool-group-root"]';

function assertOutside(node: Element | null, label: string) {
  expect(node, `${label} must exist`).not.toBeNull();
  expect(
    node?.closest(OUTSIDE_SELECTOR),
    `${label} must be outside reasoning/tool groups`,
  ).toBeNull();
}

describe("message chrome sits outside reasoning and tool groups", () => {
  for (const mode of ["chat", "agent"] as const) {
    it(`${mode}: the fixture actually renders reasoning`, async () => {
      // Guards against a vacuous test: if the containers never render, the
      // `closest` assertions below would pass trivially.
      const container = await mount(mode);
      expect(container.querySelector('[data-slot="reasoning-root"]')).not.toBeNull();
    });

    it(`${mode}: error card is outside reasoning/tool groups`, async () => {
      const container = await mount(mode);
      const alert = container.querySelector('[role="alert"]');
      assertOutside(alert, "error card");
    });

    it(`${mode}: turn footer is outside reasoning/tool groups`, async () => {
      const container = await mount(mode);
      const footer = container.querySelector('[data-slot="turn-footer"]');
      assertOutside(footer, "turn footer");
    });
  }
});
