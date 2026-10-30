/**
 * The assistant turn footer, asserted through the app's real row composition.
 *
 * ## What this file pins
 *
 * One footer line, in reading order: model details, agent (Code only), the
 * turn's duration, when it was sent, then the token count and the
 * copy/regenerate actions — one flow at one type size, with nothing pinned to
 * the trailing edge.
 *
 * Three defects are guarded here:
 *
 * 1. **Liveness is per MESSAGE.** It used to be
 *    `timing?.totalStreamTime == null && thread.isRunning` — a per-MESSAGE signal
 *    that is never persisted, ANDed with a per-THREAD boolean, so every restored
 *    or completed answer looked live while any turn streamed.
 * 2. **The duration is the server's turn record.** The vendor's streaming
 *    timing lives in memory only and starts at the first chunk, so after a
 *    reload the footer used to fall back to the save-time clock and the number
 *    silently changed meaning. Both engines now write `custom.turnStartedAt`
 *    and `custom.turnTiming`, and the live count is anchored to the start
 *    stamp — a remount when a new part arrives cannot restart it.
 * 3. **The line reads as names.** The metadata holds a provider name and a model
 *    id as stored; a footer that prints them verbatim shows `google
 *    gemini-3.5-flash-lite` at the reader. The turn record is the data, the
 *    footer is the reading surface.
 *
 * The harness is the one the transcript itself uses — the installed
 * `useExternalStoreRuntime`, the application's own `selectTranscriptRows` and
 * `ChatRow` — so a pass here is about the composition the reader sees, not a
 * stand-in. The row fixtures differ only in the metadata each engine actually
 * writes: Direct answers carry a server turn record, OpenCode answers come out
 * of the real projection reading the assistant record's `time`/`tokens`.
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

// ── unrelated heavy children, so this suite stays about the footer ───────────

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
}));

// ── the real composition, imported AFTER the mocks are registered ────────────

const { ChatRow } = await import("@web/components/ChatWindow.tsx");
const { selectTranscriptRows } = await import("@web/components/VirtualizedTranscript.tsx");
const { createInitialV2ThreadState } = await import("@web/features/opencode/v2Events.ts");
const { projectV2RepositoryItems } = await import("@web/features/opencode/v2MessageProjection.ts");
const { useSettingsStore } = await import("@web/features/providers/state/providersStore.ts");
const { formatDuration } = await import("@web/tools/elapsed.tsx");

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * A local wall-clock time two days before "today", computed from the clock the
 * test environment actually has (the DOM preload's `Date` is not the shell's).
 */
function twoDaysAgoAt(hour: number, minute: number): number {
  const at = new Date();
  at.setDate(at.getDate() - 2);
  at.setHours(hour, minute, 0, 0);
  return at.getTime();
}

const TURN_DURATION_MS = 63_000;

/** A turn from a previous day, so the footer must name the day, not the clock. */
const OLD_TURN_START = twoDaysAgoAt(20, 40);

const USER: ThreadMessageLike = {
  id: "user_1",
  role: "user",
  content: [{ type: "text", text: "hello" }],
};

/**
 * The turn record the server persists with a settled Direct answer.
 * `usage` is per-turn traffic, which is what the chip beside it reports.
 */
function directCustom(overrides: Record<string, unknown> = {}) {
  return {
    usage: { totalTokens: 4660 },
    modelId: "gemini-3.5-flash-lite",
    providerId: "google",
    reasoningLevel: "low",
    turnStartedAt: OLD_TURN_START,
    turnTiming: {
      startedAt: OLD_TURN_START,
      endedAt: OLD_TURN_START + TURN_DURATION_MS,
      durationMs: TURN_DURATION_MS,
    },
    ...overrides,
  };
}

/** An answer still in flight: start stamp only, no closed turn record. */
function liveCustom(startedAt: number) {
  return {
    usage: { totalTokens: 120 },
    modelId: "gemini-3.5-flash-lite",
    providerId: "google",
    reasoningLevel: "low",
    turnStartedAt: startedAt,
  };
}

function directAnswer(
  id: string,
  custom: Record<string, unknown> = directCustom(),
): ThreadMessageLike {
  return {
    id,
    role: "assistant",
    createdAt: new Date(OLD_TURN_START),
    content: [{ type: "text", text: `answer ${id}`, status: { type: "complete" } }],
    metadata: { custom },
  };
}

/**
 * An OpenCode assistant record as the projection reads it: `time` closes the
 * turn and `tokens` carries the usage it reports.
 */
function openCodeSource(id: string, start: number, completed?: number) {
  return {
    id,
    type: "assistant" as const,
    agent: "build",
    model: { id: "gemini-3.5-flash-lite", providerID: "google" },
    time: { created: start, ...(completed === undefined ? {} : { completed }) },
    tokens: { input: 3000, output: 660, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ type: "text" as const, text: `assistant text ${id}` }],
  };
}

/**
 * Two Code turns from the real projection — the first settled, the second in
 * flight — so the footer is asserted over what Code mode actually renders.
 */
function openCodeThread(): ThreadMessageLike[] {
  const message = (
    id: string,
    role: "user" | "assistant",
    order: number,
    source: ReturnType<typeof openCodeSource> | null,
  ) => ({
    id,
    parentId: role === "user" ? null : `msg_user_${order}`,
    role,
    createdAt: OLD_TURN_START + order,
    parts: [
      {
        kind: "text" as const,
        id: `text:${id}:0`,
        order: 0,
        value: `${role} text`,
        status: "complete" as const,
      },
    ],
    source,
  });
  const settledStart = OLD_TURN_START;
  const liveStart = Date.now() - 5_000;
  const state = {
    ...createInitialV2ThreadState("ses_footer_test"),
    messages: {
      msg_user_1: message("msg_user_1", "user", 1, null),
      msg_assistant_1: message(
        "msg_assistant_1",
        "assistant",
        1,
        openCodeSource("msg_assistant_1", settledStart, settledStart + TURN_DURATION_MS),
      ),
      msg_user_2: message("msg_user_2", "user", 2, null),
      msg_assistant_2: message(
        "msg_assistant_2",
        "assistant",
        2,
        openCodeSource("msg_assistant_2", liveStart),
      ),
    },
    messageOrder: ["msg_user_1", "msg_assistant_1", "msg_user_2", "msg_assistant_2"],
  };
  return projectV2RepositoryItems(state).map((item) => item.message);
}

// ── harness ──────────────────────────────────────────────────────────────────

function Rows({ mode }: { mode: "chat" | "agent" }) {
  const rows = useAuiState(selectTranscriptRows);
  return (
    <>
      {rows.map((row) => (
        <div key={row.key} data-row-key={row.key}>
          <ThreadPrimitive.Row row={row}>
            {(info) => <ChatRow info={info} mode={mode} />}
          </ThreadPrimitive.Row>
        </div>
      ))}
    </>
  );
}

interface SceneProps {
  readonly messages: ThreadMessageLike[];
  readonly mode: "chat" | "agent";
  readonly isRunning: boolean;
}

function Scene({ messages, mode, isRunning }: SceneProps) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning,
    convertMessage: (message) => message,
    onNew: async () => {},
    onReload: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
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
  useSettingsStore.setState({ providers: [], activeProviderId: null });
});

// ── selectors ────────────────────────────────────────────────────────────────

const LIVE = '[data-slot="live-turn"]';
const FOOTER = '[data-slot="turn-footer"]';
const ACTIONS = '[data-slot="message-actions"]';
const MODEL = '[data-slot="message-model"]';
const AGENT = '[data-slot="message-agent"]';
const DURATION = '[data-slot="turn-duration"]';
const SENT_AT = '[data-slot="message-sent-at"]';
const TOKENS = '[data-slot="message-tokens"]';

/** The rows that belong to one message, by the key the transcript gives them. */
function rowsOfMessage(container: HTMLElement, messageId: string): Element[] {
  return [...container.querySelectorAll("[data-row-key]")].filter((row) =>
    (row.getAttribute("data-row-key") ?? "").includes(`:${messageId}:`),
  );
}

function liveIndicators(scope: ParentNode): Element[] {
  return [...scope.querySelectorAll(LIVE)];
}

function one(scope: ParentNode, selector: string): Element {
  const [element] = [...scope.querySelectorAll(selector)];
  if (!element) throw new Error(`expected exactly one ${selector}`);
  return element;
}

/** Document order: true when `a` comes before `b`. */
function precedes(a: Node, b: Node): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

// ── per-message liveness ─────────────────────────────────────────────────────

describe("the live indicator is per message, not per thread", () => {
  it("marks only the in-flight Direct answer while the thread runs", async () => {
    const { container } = await mount({
      messages: [
        USER,
        directAnswer("assistant_settled"),
        directAnswer("assistant_live", liveCustom(Date.now() - 5_000)),
      ],
      mode: "chat",
      isRunning: true,
    });

    expect(liveIndicators(container)).toHaveLength(1);
    expect(rowsOfMessage(container, "assistant_live").flatMap(liveIndicators)).toHaveLength(1);
    // The completed answer from earlier in the SAME running thread: no spinner.
    expect(rowsOfMessage(container, "assistant_settled").flatMap(liveIndicators)).toHaveLength(0);
  });

  it("keeps the settled answer's model details while another turn runs", async () => {
    const { container } = await mount({
      messages: [
        USER,
        directAnswer("assistant_settled"),
        directAnswer("assistant_live", liveCustom(Date.now() - 5_000)),
      ],
      mode: "chat",
      isRunning: true,
    });

    const settled = rowsOfMessage(container, "assistant_settled");
    expect(settled.flatMap((row) => [...row.querySelectorAll(FOOTER)])).toHaveLength(1);
    expect(
      settled.flatMap((row) => [...row.querySelectorAll(MODEL)])[0]?.textContent ?? "",
    ).toContain("Gemini 3.5 Flash Lite");
  });

  it("marks only the in-flight OpenCode answer while the thread runs", async () => {
    const { container } = await mount({
      messages: openCodeThread(),
      mode: "agent",
      isRunning: true,
    });

    expect(liveIndicators(container)).toHaveLength(1);
    // The finished Code answer above it carries no live timer at all.
    expect(rowsOfMessage(container, "msg_assistant_1").flatMap(liveIndicators)).toHaveLength(0);
  });

  it("shows no live indicator anywhere once the thread settles", async () => {
    const { container } = await mount({
      messages: [
        USER,
        directAnswer("assistant_settled"),
        directAnswer("assistant_live", liveCustom(Date.now() - 5_000)),
      ],
      mode: "chat",
      isRunning: false,
    });

    expect(liveIndicators(container)).toHaveLength(0);
  });
});

// ── the footer line ──────────────────────────────────────────────────────────

describe("the footer line shows both times, in one left-to-right flow", () => {
  it("shows the turn duration and the sent-at clock side by side", async () => {
    const { container } = await mount({
      messages: [USER, directAnswer("assistant_settled")],
      mode: "chat",
      isRunning: false,
    });

    const duration = one(container, DURATION);
    expect(duration.textContent ?? "").toBe(formatDuration(TURN_DURATION_MS));

    // Both readings, always: the clock is not a hover reveal and is not the
    // value the duration replaces after a reload.
    const sentAt = one(container, SENT_AT);
    const sentText = sentAt.textContent ?? "";
    expect(sentText).not.toBe("");
    expect(sentText).not.toBe(duration.textContent);
  });

  it("names the day for older turns and shows only the clock for today", async () => {
    const now = Date.now();
    const { container } = await mount({
      messages: [
        USER,
        directAnswer("assistant_old", directCustom()),
        directAnswer(
          "assistant_today",
          directCustom({
            turnStartedAt: now - 90_000,
            turnTiming: { startedAt: now - 90_000, endedAt: now, durationMs: 90_000 },
          }),
        ),
      ],
      mode: "chat",
      isRunning: false,
    });

    const oldLabel =
      rowsOfMessage(container, "assistant_old").flatMap((row) => [
        ...row.querySelectorAll(SENT_AT),
      ])[0]?.textContent ?? "";
    const todayLabel =
      rowsOfMessage(container, "assistant_today").flatMap((row) => [
        ...row.querySelectorAll(SENT_AT),
      ])[0]?.textContent ?? "";

    expect(oldLabel.length).toBeGreaterThan(todayLabel.length);
    expect(todayLabel).toMatch(/\d{1,2}:\d{2}/);
  });

  it("counts from the server's start stamp instead of mounting at zero", async () => {
    const { container } = await mount({
      messages: [USER, directAnswer("assistant_live", liveCustom(Date.now() - 5_000))],
      mode: "chat",
      isRunning: true,
    });

    const live = one(container, LIVE);
    // The old counter was mount-local and read `0.0s` here. Anchored to the
    // request start, the very first paint already shows the real elapsed time.
    expect(live.textContent ?? "").toMatch(/^[5-9]\.\ds$/);
  });

  it("shows no clock for an answer recorded before the turn clock existed", async () => {
    // The runtime gives restored Direct history a `createdAt` of import time, so
    // a message with no turn record must NOT fall back to it — that is how the
    // footer used to print the moment the page loaded as the send time.
    const { container } = await mount({
      messages: [
        USER,
        directAnswer("assistant_legacy", {
          usage: { totalTokens: 4660 },
          modelId: "gemini-3.5-flash-lite",
          providerId: "google",
        }),
      ],
      mode: "chat",
      isRunning: false,
    });

    expect(
      rowsOfMessage(container, "assistant_legacy").flatMap((r) => [...r.querySelectorAll(SENT_AT)]),
    ).toHaveLength(0);
    // The model details and the token count still render; only the guessed
    // clock is gone.
    expect(one(container, MODEL).textContent ?? "").toContain("Gemini 3.5 Flash Lite");
    expect(one(container, TOKENS).textContent ?? "").toContain("tok");
  });

  it("reads left to right: model, agent, duration, sent-at, tokens, then actions", async () => {
    const { container } = await mount({
      messages: openCodeThread(),
      mode: "agent",
      isRunning: false,
    });

    const settled = rowsOfMessage(container, "msg_assistant_1");
    const [model] = settled.flatMap((row) => [...row.querySelectorAll(MODEL)]);
    const [agent] = settled.flatMap((row) => [...row.querySelectorAll(AGENT)]);
    const [duration] = settled.flatMap((row) => [...row.querySelectorAll(DURATION)]);
    const [sentAt] = settled.flatMap((row) => [...row.querySelectorAll(SENT_AT)]);
    const [tokens] = settled.flatMap((row) => [...row.querySelectorAll(TOKENS)]);
    const [actions] = settled.flatMap((row) => [...row.querySelectorAll(ACTIONS)]);
    const [footer] = settled.flatMap((row) => [...row.querySelectorAll(FOOTER)]);

    if (!model || !agent || !duration || !sentAt || !tokens || !actions || !footer) {
      throw new Error("expected every footer segment to render");
    }

    expect(precedes(model, agent)).toBe(true);
    expect(precedes(agent, duration)).toBe(true);
    expect(precedes(duration, sentAt)).toBe(true);
    expect(precedes(sentAt, tokens)).toBe(true);
    expect(precedes(tokens, actions)).toBe(true);

    // Nothing is pushed to the trailing edge. The tokens and the actions are
    // segments of the same flowing line, so on a wide window they still read
    // right after the clock instead of jumping to the far right.
    for (const node of [footer, ...footer.querySelectorAll("*")]) {
      expect(node.getAttribute("class") ?? "").not.toContain("ml-auto");
    }
    expect(tokens.parentElement === footer).toBe(true);
    expect(actions.parentElement === footer).toBe(true);

    // OpenCode's own words for the parts it reports.
    expect(agent.textContent).toBe("build");
    expect(tokens.textContent ?? "").toContain("tok");
    expect(tokens.textContent ?? "").toContain("3.7k");
  });
});

// ── names and type scale ─────────────────────────────────────────────────────

describe("the footer reads as names, at one type size", () => {
  it("writes a slug-shaped model id as a name and keeps the id in the title", async () => {
    // The metadata carries `providerId: "google"` and a model id with no
    // configured label — the normal case for Gemini, whose discovery endpoint
    // reports no display name. Printed verbatim that is
    // `google gemini-3.5-flash-lite thinking:low` at the reader.
    useSettingsStore.setState({ providers: [] });
    const { container } = await mount({
      messages: [USER, directAnswer("assistant_settled")],
      mode: "chat",
      isRunning: false,
    });

    const text = one(container, MODEL).textContent ?? "";
    expect(text.startsWith("Google ")).toBe(true);
    expect(text).toContain("Gemini 3.5 Flash Lite");
    expect(text).not.toContain("gemini-3.5-flash-lite");
    // The id is the fact; the name is only its reading form.
    expect(one(container, MODEL).getAttribute("title")).toBe("gemini-3.5-flash-lite");
  });

  it("prefers a configured model label over the id", async () => {
    act(() =>
      useSettingsStore.setState({
        providers: [
          {
            id: "google",
            name: "google",
            type: "google",
            model: "gemini-3.5-flash-lite",
            models: [
              {
                id: "gemini-3.5-flash-lite",
                label: "Gemini 3.5 Flash Lite (Preview)",
                provider: "google",
              },
            ],
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        ],
      }),
    );
    try {
      const { container } = await mount({
        messages: [USER, directAnswer("assistant_settled")],
        mode: "chat",
        isRunning: false,
      });

      const text = one(container, MODEL).textContent ?? "";
      expect(text).toContain("Gemini 3.5 Flash Lite (Preview)");
      expect(text.startsWith("Google ")).toBe(true);
    } finally {
      act(() => useSettingsStore.setState({ providers: [], activeProviderId: null }));
    }
  });

  it("sets one type size for the whole line, including the token chip", async () => {
    const { container } = await mount({
      messages: [USER, directAnswer("assistant_settled")],
      mode: "chat",
      isRunning: false,
    });

    const footer = one(container, FOOTER);
    // The root declares the size once; nothing that renders text may re-declare
    // one, so the token chip and the separators cannot be a step smaller again.
    // The icon buttons are exempt because they are icons — their only text is
    // the screen-reader label.
    expect(footer.getAttribute("class") ?? "").toContain("text-2xs");
    const textBearing = [...footer.querySelectorAll("*")].filter((node) =>
      [...node.childNodes].some(
        (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() !== "",
      ),
    );
    expect(textBearing.length).toBeGreaterThan(0);
    for (const node of textBearing) {
      expect(node.getAttribute("class") ?? "").not.toMatch(/(?:^|\s)text-(?:\[|3xs|xs|sm|base)/);
    }
  });
});
