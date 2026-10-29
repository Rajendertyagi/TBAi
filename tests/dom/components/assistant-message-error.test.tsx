/**
 * Assistant message chrome, asserted BEHAVIOURALLY in the real row composition.
 *
 * ## The defect this file pins
 *
 * `createThreadRowsSelector` (core 0.3.30) emits PART rows for assistant
 * messages and a `message` row only for non-assistant messages. TBAi mounted
 * `AssistantError`, the copy/regenerate action bar and `SessionTimeline` from the
 * `message` branch, so none of them ever mounted for an assistant message: a
 * failed turn carried `status: { type: "incomplete", reason: "error" }` on the
 * message and rendered no error at all.
 *
 * ## Why this harness is the real one
 *
 * It mounts the installed `useExternalStoreRuntime`, the application's OWN row
 * selector (`selectTranscriptRows`) and its OWN row switch (`ChatRow`). A
 * virtualizer needs measurable scroll geometry, which a DOM test does not have;
 * the ROWS are the part whose composition and rendering matter, so they are fed
 * directly to `ThreadPrimitive.Row`.
 *
 * ## What "error" means here
 *
 * Only the typed contract counts: `status.type === "incomplete"` AND
 * `status.reason === "error"`. A cancelled turn, a tool-call interruption and a
 * successful message must produce no error card. The detail text is asserted, not
 * just the presence of a status field.
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

// ── unrelated heavy children, so this suite stays about the transcript ────────

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

// The connection heart reads the OpenCode runtime extras. Its state is the seam
// for the "no duplication" case: the heart must stay Connected while the
// transcript owns the turn's failure.
mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () => ({
    state: {
      connection: { type: "connected", serverVersion: "2.2.0" },
      load: { type: "ready" },
      retry: null,
      execution: { type: "idle" },
      revertRecovery: { type: "none" },
      activity: "unknown",
      auxiliary: { inbox: "current" },
      session: null,
    },
    permissions: [],
  }),
}));

// ── the real composition, imported AFTER the mocks are registered ────────────

const { ChatRow } = await import("@web/components/ChatWindow.tsx");
const { selectTranscriptRows } = await import("@web/components/VirtualizedTranscript.tsx");
const { OpenCodeStatus } = await import("@web/features/opencode/OpenCodeStatus.tsx");
const { createInitialV2ThreadState } = await import("@web/features/opencode/v2Events.ts");
const { projectV2RepositoryItems } = await import("@web/features/opencode/v2MessageProjection.ts");

// ── fixtures ─────────────────────────────────────────────────────────────────

const DETAIL = "Provider rejected the request: unsupported model parameters.";
const USER: ThreadMessageLike = {
  id: "user_1",
  role: "user",
  content: [{ type: "text", text: "hello" }],
};

const TEXT_PART = { type: "text", text: "partial answer", status: { type: "complete" } } as const;

/** A Direct provider failure: the typed status the AI SDK adapter produces. */
function directFailure(parts: ThreadMessageLike["content"] = [TEXT_PART]): ThreadMessageLike {
  return {
    id: "assistant_failed",
    role: "assistant",
    status: { type: "incomplete", reason: "error", error: { code: "unknown", message: DETAIL } },
    content: parts,
  };
}

/** Shell calls, for the timeline case. */
function shellCall(i: number) {
  return {
    type: "tool-call",
    toolCallId: `call_${i}`,
    toolName: "shell",
    args: { command: `echo ${i}` },
    argsText: JSON.stringify({ command: `echo ${i}` }),
    result: { content: [{ type: "text", text: `out ${i}` }] },
  } as const;
}

/**
 * The OpenCode projection's failure, end to end: a normalized V2 state with an
 * execution error, run through the real projection.
 *
 * `withAssistant: false` models the case where the projection cannot name the
 * failed assistant message: it then appends an assistant message with
 * `content: []`, the shape that produces no part rows at all.
 */
function openCodeFailure({ withAssistant = true } = {}): ThreadMessageLike[] {
  const state = {
    ...createInitialV2ThreadState("ses_error_test"),
    messages: {
      msg_user: {
        id: "msg_user",
        parentId: null,
        role: "user" as const,
        createdAt: 1,
        parts: [
          {
            kind: "text" as const,
            id: "text:msg_user:0",
            order: 0,
            value: "do the thing",
            status: "complete" as const,
          },
        ],
        source: null,
      },
      ...(withAssistant
        ? {
            msg_assistant: {
              id: "msg_assistant",
              parentId: "msg_user",
              role: "assistant" as const,
              createdAt: 2,
              parts: [
                {
                  kind: "text" as const,
                  id: "text:msg_assistant:0",
                  order: 0,
                  value: "working on it",
                  status: "complete" as const,
                },
              ],
              source: null,
            },
          }
        : {}),
    },
    messageOrder: withAssistant ? ["msg_user", "msg_assistant"] : ["msg_user"],
    execution: {
      type: "error" as const,
      userMessageId: "msg_user",
      assistantMessageId: withAssistant ? "msg_assistant" : null,
      error: { kind: "server" as const, message: DETAIL },
    },
  };
  return projectV2RepositoryItems(state).map((item) => item.message);
}

// ── harness ──────────────────────────────────────────────────────────────────

interface SceneProps {
  readonly messages: ThreadMessageLike[];
  readonly mode: "chat" | "agent";
  readonly withHeart?: boolean;
}

/**
 * The app's own row composition under the real runtime.
 *
 * The selector is the one `VirtualizedTranscript` feeds its virtualizer, so the
 * row set here is exactly what a reader's transcript is built from.
 */
function Rows({ mode }: { mode: "chat" | "agent" }) {
  const rows = useAuiState(selectTranscriptRows);
  return (
    <>
      {rows.map((row) => (
        // The same wrapper the real transcript gives each row (positioned and
        // measured there), so a case can name the row it means.
        <div key={row.key} data-row-key={row.key}>
          <ThreadPrimitive.Row row={row}>
            {(info) => <ChatRow info={info} mode={mode} />}
          </ThreadPrimitive.Row>
        </div>
      ))}
    </>
  );
}

function Scene({ messages, mode, withHeart = false }: SceneProps) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: false,
    convertMessage: (message) => message,
    onNew: async () => {},
    // Regenerate is a real capability of both production runtimes; without it
    // the action bar would be legitimately absent and the case vacuous.
    onReload: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {withHeart ? <OpenCodeStatus compact /> : null}
      <Rows mode={mode} />
    </AssistantRuntimeProvider>
  );
}

interface Mounted {
  readonly root: Root;
  readonly container: HTMLElement;
}

const mounted: Mounted[] = [];

async function mount(props: SceneProps): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Scene {...props} />);
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

// ── selectors ────────────────────────────────────────────────────────────────

function alerts(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[role="alert"]')];
}

function text(container: HTMLElement): string {
  return container.textContent ?? "";
}

/**
 * Buttons whose visible copy contains `label`.
 *
 * The vendored icon button carries its tooltip in an sr-only span rather than an
 * `aria-label`, so that is where the reader-facing name lives.
 */
function buttonsWithText(scope: ParentNode, label: string): Element[] {
  return [...scope.querySelectorAll("button")].filter((button) =>
    (button.textContent ?? "").includes(label),
  );
}

/** The rows that belong to one message, by the key the transcript gives them. */
function rowsOfMessage(container: HTMLElement, messageId: string): Element[] {
  return [...container.querySelectorAll("[data-row-key]")].filter((row) =>
    (row.getAttribute("data-row-key") ?? "").includes(`:${messageId}:`),
  );
}

// ── the failure itself ───────────────────────────────────────────────────────

describe("a failed assistant message renders its error", () => {
  it("shows a Direct provider failure's detail in a single alert", async () => {
    const { container } = await mount({ messages: [USER, directFailure()], mode: "chat" });

    const found = alerts(container);
    expect(found).toHaveLength(1);
    expect(found[0]?.textContent ?? "").toContain(DETAIL);
  });

  it("shows the OpenCode projection's failure through the same renderer", async () => {
    const { container } = await mount({ messages: openCodeFailure(), mode: "agent" });

    const found = alerts(container);
    expect(found).toHaveLength(1);
    // The projection prefixes the server detail; the detail itself must survive.
    expect(found[0]?.textContent ?? "").toContain(DETAIL);
  });

  it("renders one card for a message with several parts", async () => {
    const { container } = await mount({
      messages: [
        USER,
        directFailure([
          { type: "text", text: "first paragraph", status: { type: "complete" } },
          { type: "text", text: "second paragraph", status: { type: "complete" } },
          shellCall(1),
        ]),
      ],
      mode: "chat",
    });

    expect(alerts(container)).toHaveLength(1);
    expect(text(container)).toContain(DETAIL);
  });

  it("still shows the error when the failed message carries no parts", async () => {
    // Both engines can produce this shape: the AI SDK converter appends an
    // assistant message with `content: []` when the last message is not an
    // assistant, and the OpenCode projection does the same when no assistant
    // message can be named.
    const failed: ThreadMessageLike = {
      id: "assistant_empty",
      role: "assistant",
      status: { type: "incomplete", reason: "error", error: DETAIL },
      content: [],
    };
    const { container } = await mount({ messages: [USER, failed], mode: "chat" });

    const found = alerts(container);
    expect(found).toHaveLength(1);
    expect(found[0]?.textContent ?? "").toContain(DETAIL);
  });

  it("shows the OpenCode projection's appended error message", async () => {
    // The real projection, with no assistant message to attach to: it appends
    // `{ content: [], status: incomplete/error }`, which the selector turns into
    // a single turn-end row.
    const { container } = await mount({
      messages: openCodeFailure({ withAssistant: false }),
      mode: "agent",
    });

    const found = alerts(container);
    expect(found).toHaveLength(1);
    expect(found[0]?.textContent ?? "").toContain(DETAIL);
  });
});

describe("non-error outcomes render no error card", () => {
  it("a successful message shows none", async () => {
    const ok: ThreadMessageLike = {
      id: "assistant_ok",
      role: "assistant",
      status: { type: "complete", reason: "stop" },
      content: [TEXT_PART],
    };
    const { container } = await mount({ messages: [USER, ok], mode: "chat" });

    expect(alerts(container)).toHaveLength(0);
  });

  it("a cancelled turn shows none", async () => {
    const cancelled: ThreadMessageLike = {
      id: "assistant_cancelled",
      role: "assistant",
      status: { type: "incomplete", reason: "cancelled" },
      content: [TEXT_PART],
    };
    const { container } = await mount({ messages: [USER, cancelled], mode: "chat" });

    expect(alerts(container)).toHaveLength(0);
  });

  it("an interrupted tool call shows none", async () => {
    const interrupted: ThreadMessageLike = {
      id: "assistant_tools",
      role: "assistant",
      status: { type: "incomplete", reason: "tool-calls" },
      content: [shellCall(1)],
    };
    const { container } = await mount({ messages: [USER, interrupted], mode: "agent" });

    expect(alerts(container)).toHaveLength(0);
  });
});

describe("message-level chrome is restored exactly once", () => {
  it("renders one copy and one regenerate control for a multi-part message", async () => {
    const ok: ThreadMessageLike = {
      id: "assistant_ok",
      role: "assistant",
      status: { type: "complete", reason: "stop" },
      content: [
        { type: "text", text: "first paragraph", status: { type: "complete" } },
        { type: "text", text: "second paragraph", status: { type: "complete" } },
      ],
    };
    const { container } = await mount({ messages: [USER, ok], mode: "chat" });

    // Two part rows, one action bar: the message footer closes the message, it
    // does not repeat on every part.
    const rows = rowsOfMessage(container, "assistant_ok");
    expect(rows).toHaveLength(2);
    expect(buttonsWithText(container, "Regenerate response")).toHaveLength(1);
    // The user row carries its own copy button, so this is counted inside the
    // assistant's rows only.
    expect(rows.flatMap((row) => buttonsWithText(row, "Copy message"))).toHaveLength(1);
  });

  it("renders the session timeline once, and only on the Code surface", async () => {
    const ok: ThreadMessageLike = {
      id: "assistant_ok",
      role: "assistant",
      status: { type: "complete", reason: "stop" },
      content: [shellCall(1), shellCall(2)],
    };

    const agent = await mount({ messages: [USER, ok], mode: "agent" });
    expect(agent.container.querySelectorAll('[data-slot="tool-timeline"]')).toHaveLength(1);
    expect(text(agent.container).match(/2 steps/g) ?? []).toHaveLength(1);

    const chat = await mount({ messages: [USER, ok], mode: "chat" });
    expect(chat.container.querySelectorAll('[data-slot="tool-timeline"]')).toHaveLength(0);
    expect(text(chat.container)).not.toContain("2 steps");
  });
});

describe("the error is owned by the transcript, not the connection heart", () => {
  it("keeps the heart Connected while the alert reports the turn failure", async () => {
    const { container } = await mount({
      messages: [USER, directFailure()],
      mode: "agent",
      withHeart: true,
    });

    expect(alerts(container)).toHaveLength(1);
    // One occurrence of the detail: the transcript. The heart must not repeat it.
    expect(text(container).split(DETAIL).length - 1).toBe(1);

    const heart = container.querySelector('[aria-label="OpenCode status: Connected"]');
    expect(heart).not.toBeNull();
  });
});
