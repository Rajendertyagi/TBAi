/**
 * P0b — slow history load + a resume stream, on the REAL runtime.
 *
 * ## The incident
 *
 * The persisted rows for a paused approval went missing after a resumed run.
 * The cause was an ordering race: the history `load()` is slow, the library's
 * auto-resume fires before it settles, and the rows that arrive afterwards
 * replace the resumed reply — leaving a placeholder assistant row and dropping
 * the approval, with no history write at all.
 *
 * This file drives that case with the installed packages:
 *
 *   - the real `useChatRuntime` inside the real `useRemoteThreadListRuntime`,
 *     exactly as `web/src/runtime.ts` composes them, so `useExternalHistory`
 *     actually calls `withFormat().load()` (it skips the load entirely without a
 *     `remoteId`);
 *   - the REAL Direct resumable storage (`createDirectResumableStorage`) whose
 *     thread-addressed reads stay suppressed until the conversation's history
 *     load settles;
 *   - a history adapter whose `load()` resolves AFTER a deliberate delay, and
 *     which settles the gate where the real adapter does;
 *   - an ordered event log (`history_load_*`, `resume_request`, `history_append`
 *     / `history_update`) so "which write lands last" is measured, not inferred.
 *
 * Three cases:
 *
 *   natural     — only the production path runs: the auto-resume effect sees the
 *                 pending id once the load has settled, so the resume starts
 *                 AFTER the window is merged and its rows are written under the
 *                 loaded tail.
 *   forced-fast — the gate is opened by the test while `load()` is still pending
 *                 and `chat.resumeStream()` is called directly; the resumed
 *                 stream finishes BEFORE the load resolves.
 *   forced-slow — the same forced resume, but only the stream head arrives
 *                 before the load resolves; the approval-bearing tail arrives
 *                 afterwards, while the Chat is mid-stream.
 *
 * The forced cases bypass the production gate on purpose: they answer "what
 * happens IF a resume and the load overlap". They are not a claim that the
 * production path can reach that state — the `natural` case measures that.
 *
 * ## What is read back
 *
 * Both views are recorded, because they can disagree:
 *   - the assistant-ui thread messages (`data-testid`-free, read through
 *     `useAuiState`) — what the user sees;
 *   - the underlying AI SDK `Chat` (`useAISDKChat`) — whose messages are what
 *     the storage format adapter encodes into rows.
 *
 * Every history write is recorded with the id, parent id, part types and any
 * `approval.id` carried, so a "row exists but lost the approval" outcome is
 * visible rather than inferred from rendered output.
 *
 * ## History
 *
 * Before the gate existed, the natural case measured the defect on
 * 0.15.32 / ai-sdk 0.0.16 / ai 7.0.145: the thread reported `isLoading === false`
 * before `withFormat().load()` was invoked, the resume fired at ~59 ms against a
 * load that resolved at ~308 ms, and the arrived reply was clobbered — absent
 * from the chat, absent from the thread, zero history writes. That case now
 * asserts the fixed ordering; measured on the same versions with the gate in
 * place, the load starts at ~54 ms, resolves at ~305 ms, the resume fires at
 * ~325 ms, and its row is appended at ~503 ms under parent `a0` with the
 * approval intact.
 */

import { describe, expect, it } from "bun:test";
import { act, createElement, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useAuiState,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { AssistantChatTransport, useAISDKChat, useChatRuntime } from "@assistant-ui/ai-sdk";
import {
  createDirectResumableStorage,
  markDirectHistorySettled,
  readDirectResumableStreamId,
} from "@web/features/chat/state/resumable-stream.ts";

const enc = new TextEncoder();
const sse = (chunk: unknown) => enc.encode(`data: ${JSON.stringify(chunk)}\n\n`);

/* ── Ordered event log ────────────────────────────────────────────────────── */

interface LoggedEvent {
  t: number;
  event: string;
  [field: string]: unknown;
}

const events: LoggedEvent[] = [];
let zero = Date.now();
const record = (event: string, fields: Record<string, unknown> = {}) => {
  events.push({ t: Date.now() - zero, event, ...fields });
};
const indexOfEvent = (event: string) => events.findIndex((e) => e.event === event);

/* ── Stored rows ──────────────────────────────────────────────────────────── */

interface StoredRow {
  id: string;
  parent_id: string | null;
  format: "ai-sdk/v6";
  content: unknown;
}

const encodeStored = (message: { id: string } & Record<string, unknown>) => {
  const { id: _id, ...rest } = message;
  return rest;
};
const decodeStored = (row: StoredRow) => ({
  parentId: row.parent_id,
  message: { id: row.id, ...(row.content as Record<string, unknown>) },
});

/**
 * The history that was already on disk when the tab reloaded: the user's prompt
 * and one assistant reply that is itself PAUSED on an approval. That is the
 * incident's shape — the conversation being reloaded is mid-approval, which is
 * why a pending stream id exists in the first place.
 */
const LOADED_ROWS: StoredRow[] = [
  {
    id: "u1",
    parent_id: null,
    format: "ai-sdk/v6",
    content: { role: "user", parts: [{ type: "text", text: "rewrite App.tsx" }] },
  },
  {
    id: "a0",
    parent_id: "u1",
    format: "ai-sdk/v6",
    content: {
      role: "assistant",
      parts: [
        { type: "text", text: "Here is the current version." },
        {
          type: "tool-write_file",
          toolCallId: "call_prev",
          state: "approval-requested",
          input: { path: "D:\\Test\\App.tsx", content: "export const old = 1;" },
          approval: { id: "aitxt-PrevApproval" },
        },
      ],
    },
  },
];

/* ── The resumed server stream ────────────────────────────────────────────── */

/**
 * The head is what a paused-then-resumed run replays before it does anything
 * new: the message identity plus the progress envelope. In the incident the
 * assistant row that DID get written contained only this progress part, so the
 * split between head and tail is the whole point — it lets the load resolve in
 * between the two.
 */
const RESUME_HEAD: readonly unknown[] = [
  { type: "start", messageId: "race-asst" },
  { type: "start-step" },
  { type: "data-tbai-progress", data: { step: 1, label: "Preparing write" } },
];

const RESUME_TAIL: readonly unknown[] = [
  { type: "text-start", id: "txt-race" },
  { type: "text-delta", id: "txt-race", delta: "Rewriting App.tsx now." },
  { type: "text-end", id: "txt-race" },
  { type: "tool-input-start", toolCallId: "call_race", toolName: "write_file", dynamic: false },
  {
    type: "tool-input-available",
    toolCallId: "call_race",
    toolName: "write_file",
    input: { path: "D:\\Test\\App.tsx", content: "export {};" },
    dynamic: false,
  },
  {
    type: "tool-approval-request",
    approvalId: "aitxt-RaceApproval",
    toolCallId: "call_race",
    signature: "race-signature",
  },
  { type: "finish-step" },
  { type: "finish", finishReason: "tool-calls" },
];

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

interface ChatPart {
  type: string;
  toolCallId?: string;
  approval?: { id?: string; approved?: unknown };
}
interface ChatMessage {
  id: string;
  role: string;
  parts?: ChatPart[];
}
interface ThreadPart {
  type: string;
  toolCallId?: string;
  approval?: { id?: string };
  result?: unknown;
}
interface ThreadMessage {
  id: string;
  role: string;
  status?: { type: string; reason?: string };
  content: ThreadPart[];
}

interface HistoryCall {
  op: "append" | "update";
  id: string;
  parentId: string | null;
  parts: string[];
  approvals: string[];
}

interface HistoryItem {
  message: ChatMessage & { id: string };
  parentId?: string | null;
}

function summarize(value: { parts?: ChatPart[] }) {
  const parts = value.parts ?? [];
  return {
    parts: parts.map((p) => p.type),
    approvals: parts.flatMap((p) => (p.approval?.id ? [p.approval.id] : [])),
  };
}

/**
 * Records every write. `load()` resolves only after `delayMs`, which is the
 * "slow server" the race needs; `loadStarted` flips synchronously so a forced
 * resume can be issued inside that window. Settling the resumable read gate
 * here stands in for the real adapter's `finally`.
 */
function makeHistory(delayMs: number, threadId: string) {
  const state = {
    loadCalls: 0,
    loadStarted: false,
    loadResolved: false,
    calls: [] as HistoryCall[],
    stored: [] as StoredRow[],
  };

  const recordWrite = (op: "append" | "update", item: HistoryItem, id?: string) => {
    const summary = summarize(item.message);
    state.calls.push({
      op,
      id: id ?? item.message.id,
      parentId: item.parentId ?? null,
      parts: summary.parts,
      approvals: summary.approvals,
    });
    state.stored.push({
      id: item.message.id,
      parent_id: item.parentId ?? null,
      format: "ai-sdk/v6",
      content: encodeStored(item.message as unknown as { id: string } & Record<string, unknown>),
    });
    record(`history_${op}`, {
      id: id ?? item.message.id,
      parentId: item.parentId ?? null,
      parts: summary.parts,
      approvals: summary.approvals,
    });
  };

  const history = {
    load: async () => ({ messages: [], headId: null }),
    append: async () => {},
    update: async () => {},
    delete: async () => {},
    withFormat: () => ({
      pin: () => {},
      load: async () => {
        state.loadCalls += 1;
        state.loadStarted = true;
        record("history_load_started", { attempt: state.loadCalls });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        state.loadResolved = true;
        record("history_load_resolved", { ids: LOADED_ROWS.map((row) => row.id) });
        markDirectHistorySettled(threadId);
        return { headId: LOADED_ROWS.at(-1)?.id ?? null, messages: LOADED_ROWS.map(decodeStored) };
      },
      append: async (item: HistoryItem) => recordWrite("append", item),
      update: async (item: HistoryItem, id?: string) => recordWrite("update", item, id),
      delete: async () => {},
    }),
  };

  return { history, state };
}

/**
 * The REAL Direct storage, with its history-settled read gate in force: a
 * thread-addressed read returns null until `markDirectHistorySettled` runs.
 * `peek` bypasses the gate, because reading back what was WRITTEN is not a
 * resume decision.
 */
function makeStorage(streamId: string | null, threadId: string) {
  const storage = createDirectResumableStorage(() => threadId);
  if (streamId) storage.setStreamId(streamId, threadId);
  return { storage, peek: () => readDirectResumableStreamId(threadId) };
}

function makeResumeFetch(tailDelayMs: number) {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("/api/chat/resume/")) {
      record("unexpected_request", { url });
      return new Response("{}", { status: 500 });
    }
    record("resume_request", { url });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of RESUME_HEAD) controller.enqueue(sse(chunk));
          record("resume_head_sent", { chunks: RESUME_HEAD.length });
          const sendTail = () => {
            for (const chunk of RESUME_TAIL) controller.enqueue(sse(chunk));
            controller.close();
            record("resume_tail_sent", { chunks: RESUME_TAIL.length });
          };
          if (tailDelayMs === 0) sendTail();
          else setTimeout(sendTail, tailDelayMs);
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;
}

const threadListAdapter = (threadId: string) => ({
  list: async () => ({ threads: [{ remoteId: threadId, title: "p0b", status: "regular" }] }),
  fetch: async (id: string) => ({ remoteId: id, title: "p0b", status: "regular" }),
  initialize: async (id: string) => ({ remoteId: id }),
  rename: async () => {},
  delete: async () => {},
  archive: async () => {},
  unarchive: async () => {},
  generateTitle: async () => new ReadableStream({ start: (c) => c.close() }),
});

/* ── Live state captured from the real runtime ────────────────────────────── */

let threadMessages: readonly ThreadMessage[] = [];
let threadRunning = false;
let threadIsLoading: boolean | null = null;
let chatStatus: string | null = null;
let chatMessages: readonly ChatMessage[] = [];
let chatRef: { resumeStream: () => Promise<void> } | null = null;
let lastReportedLoading: boolean | null = null;

function Probe() {
  threadMessages = useAuiState((s) => s.thread.messages) as unknown as readonly ThreadMessage[];
  threadRunning = useAuiState((s) => s.thread.isRunning);
  threadIsLoading = useAuiState((s) => s.thread.isLoading);
  const chat = useAISDKChat();
  chatRef = chat ? (chat as unknown as { resumeStream: () => Promise<void> }) : null;
  chatStatus = chat?.status ?? null;
  chatMessages = (chat?.messages ?? []) as unknown as readonly ChatMessage[];
  if (threadIsLoading !== lastReportedLoading) {
    lastReportedLoading = threadIsLoading;
    record("thread_isLoading", {
      value: threadIsLoading,
      chatStatus,
      threadCount: threadMessages.length,
    });
  }
  return null;
}

function DirectThread({
  history,
  storage,
  fetchImpl,
}: {
  history: unknown;
  storage: unknown;
  fetchImpl: typeof fetch;
}) {
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        fetch: fetchImpl,
        resumable: {
          storage: storage as never,
          resumeApi: (streamId: string) => `/api/chat/resume/${streamId}`,
        },
      }),
    [fetchImpl, storage],
  );
  return useChatRuntime({
    transport,
    canResume: true,
    isSendDisabled: false,
    adapters: { history },
  } as never);
}

function App({
  history,
  storage,
  fetchImpl,
  threadId,
}: {
  history: unknown;
  storage: unknown;
  fetchImpl: typeof fetch;
  threadId: string;
}) {
  const runtimeHook = useMemo(
    () =>
      function ThreadRuntime() {
        return DirectThread({ history, storage, fetchImpl });
      },
    [fetchImpl, history, storage],
  );
  const adapter = useMemo(() => threadListAdapter(threadId), [threadId]);
  const runtime = useRemoteThreadListRuntime({
    runtimeHook,
    adapter: adapter as never,
    threadId,
  });
  return createElement(AssistantRuntimeProvider, { runtime }, createElement(Probe));
}

const flush = async (ms = 20) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await flush(10);
  }
  console.warn(`P0b wait timed out: ${label}`);
  return false;
}

function mount(props: {
  history: unknown;
  storage: unknown;
  fetchImpl: typeof fetch;
  threadId: string;
}): {
  root: Root;
  container: HTMLElement;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(App, props));
  });
  return { root, container };
}

function resetProbe() {
  events.length = 0;
  zero = Date.now();
  threadMessages = [];
  threadRunning = false;
  threadIsLoading = null;
  chatStatus = null;
  chatMessages = [];
  chatRef = null;
  lastReportedLoading = null;
}

let writesRef: HistoryCall[] = [];
let storedRef: StoredRow[] = [];

interface Measurement {
  mode: string;
  events: LoggedEvent[];
  threadMessages: Array<{
    id: string;
    role: string;
    status: string | null;
    parts: string[];
    approvals: string[];
  }>;
  chatMessages: Array<{ id: string; role: string; parts: string[]; approvals: string[] }>;
  chatStatus: string | null;
  writes: HistoryCall[];
  storedRows: Array<{ id: string; parts: string[]; approvals: string[] }>;
  pendingStreamId: string | null;
}

function measure(mode: string, pendingStreamId: string | null): Measurement {
  return {
    mode,
    events: [...events],
    threadMessages: threadMessages.map((m) => {
      const parts = m.content ?? [];
      return {
        id: m.id,
        role: m.role,
        status: m.status ? `${m.status.type}${m.status.reason ? `/${m.status.reason}` : ""}` : null,
        parts: parts.map((p) => p.type),
        approvals: parts.flatMap((p) => (p.approval?.id ? [p.approval.id] : [])),
      };
    }),
    chatMessages: chatMessages.map((m) => {
      const summary = summarize(m);
      return { id: m.id, role: m.role, parts: summary.parts, approvals: summary.approvals };
    }),
    chatStatus,
    writes: [...writesRef],
    storedRows: storedRef.map((row) => {
      const summary = summarize(
        (row.content as { parts?: ChatPart[] } | undefined) ?? { parts: [] },
      );
      return { id: row.id, parts: summary.parts, approvals: summary.approvals };
    }),
    pendingStreamId,
  };
}

let threadSeq = 0;

async function runCase(mode: "natural" | "forced-fast" | "forced-slow") {
  resetProbe();
  const isNatural = mode === "natural";
  // A stream that closes in the same tick as it starts is not observable as a
  // run; give the natural case a short tail so the runtime sees it start and
  // settle, as a real resume does.
  const tailDelayMs = mode === "forced-slow" ? 450 : mode === "natural" ? 150 : 0;
  // A distinct thread per case: settled-history state is module-wide, and each
  // case must start with its gate CLOSED, exactly as a fresh reload does.
  const threadId = `p0b-${mode}-${++threadSeq}`;
  const { history, state } = makeHistory(250, threadId);
  // The natural case arms the id in storage, exactly as production does after a
  // reload. The forced cases start DISARMED so the library's own auto-resume
  // cannot fire first; the test arms the id and calls the Chat directly inside
  // the load window.
  const { storage, peek } = makeStorage(isNatural ? "stream-race" : null, threadId);
  const fetchImpl = makeResumeFetch(tailDelayMs);
  writesRef = state.calls;
  storedRef = state.stored;

  // The pointer is written but suppressed: this read is what the library's
  // auto-resume effect would see at mount, before any history has loaded.
  record("storage_read_before_load", { value: storage.getStreamId(threadId) });

  const { root } = mount({ history, storage, fetchImpl, threadId });

  await waitFor(() => chatRef !== null, "the AI SDK chat is exposed");

  if (isNatural) {
    // Only the production path can start the resume here: the id becomes
    // visible when the fake adapter settles the gate at load resolution.
    await waitFor(
      () =>
        state.loadResolved &&
        indexOfEvent("resume_request") !== -1 &&
        indexOfEvent("resume_tail_sent") !== -1 &&
        !threadRunning,
      "auto-resume after history load, and it settles",
    );
  } else {
    await waitFor(() => state.loadStarted, "history load in flight");
    await act(async () => {
      // Open the gate by hand: these cases exist to measure the overlap the
      // production gate prevents, so the resume must see the pending id while
      // `load()` is still in flight.
      markDirectHistorySettled(threadId);
      storage.setStreamId("stream-race", threadId);
      void chatRef!.resumeStream();
      await Promise.resolve();
    });
    record("resume_forced", { loadResolved: state.loadResolved });
    await waitFor(
      () => state.loadResolved && indexOfEvent("resume_tail_sent") !== -1 && !threadRunning,
      "forced resume settles after the load",
    );
  }

  // Persistence is scheduled on a `setTimeout(…, 0)` after settle; give the
  // deferred-write chain room to run.
  await waitFor(
    () => state.loadResolved && !threadRunning,
    "the load resolved and the run settled",
  );
  await flush(250);

  const measurement = measure(mode, peek());
  console.log(`P0B_MEASUREMENT_${mode.toUpperCase()} ${JSON.stringify(measurement, null, 2)}`);

  await act(async () => root.unmount());
  return { measurement, state };
}

describe("P0b — slow history load + resume stream", () => {
  it("natural: the resume waits for the history load, and the resumed reply is written under the loaded tail", async () => {
    const { measurement } = await runCase("natural");

    const loadStarted = indexOfEvent("history_load_started");
    const loadResolved = indexOfEvent("history_load_resolved");
    const resume = indexOfEvent("resume_request");

    expect(loadStarted, "the slow history load started").toBeGreaterThan(-1);
    expect(resume, "a resume was requested").toBeGreaterThan(-1);

    // The gate: the pointer IS in storage, but the thread-addressed read is
    // suppressed until the load settles, so the auto-resume cannot fire early.
    expect(
      events.find((e) => e.event === "storage_read_before_load")?.value,
      "the pointer read before the load is suppressed",
    ).toBeNull();

    // The ordering the defect violated: the load resolves first, then the
    // resume starts against merged history.
    expect(loadResolved, "the load resolved before the resume").toBeLessThan(resume);

    // The outcome the incident lost: the resumed reply survives, keeps the
    // approval, and is persisted under the loaded tail instead of a new root.
    const resumed = measurement.chatMessages.find((m) => m.id === "race-asst");
    expect(resumed, "the resumed message exists in the chat").toBeDefined();
    expect(resumed?.approvals, "the live resumed message carries the approval").toContain(
      "aitxt-RaceApproval",
    );

    const raceWrites = measurement.writes.filter((w) => w.id === "race-asst");
    expect(raceWrites.length, "the resumed message was written").toBeGreaterThan(0);
    expect(raceWrites.at(-1)?.approvals, "the written row carries the approval").toContain(
      "aitxt-RaceApproval",
    );
    expect(raceWrites.at(-1)?.parentId, "the resumed row's parent").toBe("a0");
    expect(
      measurement.threadMessages.some((m) => m.approvals.includes("aitxt-RaceApproval")),
      "the resumed approval is visible",
    ).toBe(true);
  }, 20_000);

  it("forced-fast: resume finishes before a pending load resolves; the row is written as a new root", async () => {
    const { measurement, state } = await runCase("forced-fast");

    expect(state.loadResolved, "the load did resolve").toBe(true);
    expect(
      indexOfEvent("resume_request"),
      "the resume was requested while history was still pending",
    ).toBeLessThan(indexOfEvent("history_load_resolved"));
    expect(indexOfEvent("resume_forced"), "the resume was forced from the test").toBeGreaterThan(
      -1,
    );

    const resumed = measurement.chatMessages.find((m) => m.id === "race-asst");
    expect(resumed, "the resumed message exists in the chat").toBeDefined();
    expect(resumed?.approvals, "the live resumed message carries the approval").toContain(
      "aitxt-RaceApproval",
    );

    const raceWrites = measurement.writes.filter((w) => w.id === "race-asst");
    expect(raceWrites.length, "the resumed message was written").toBeGreaterThan(0);
    expect(raceWrites.at(-1)?.approvals, "the written row carries the approval").toContain(
      "aitxt-RaceApproval",
    );
    // Measured: the write lands before the loaded rows are in the persist pass,
    // so its parent is null — a NEW conversation root, not a child of `a0`.
    expect(raceWrites.at(-1)?.parentId, "the resumed row's parent").toBeNull();
  }, 20_000);

  it("forced-slow: the load resolves while the resume stream is mid-flight", async () => {
    const { measurement, state } = await runCase("forced-slow");

    expect(state.loadResolved, "the load did resolve").toBe(true);
    expect(
      indexOfEvent("resume_request"),
      "the resume was requested while history was still pending",
    ).toBeLessThan(indexOfEvent("history_load_resolved"));
    expect(
      indexOfEvent("history_load_resolved"),
      "the load resolved before the resumed tail arrived",
    ).toBeLessThan(indexOfEvent("resume_tail_sent"));

    const resumed = measurement.chatMessages.find((m) => m.id === "race-asst");
    expect(resumed, "the resumed message exists in the chat").toBeDefined();
    expect(resumed?.approvals, "the live resumed message carries the approval").toContain(
      "aitxt-RaceApproval",
    );

    const raceWrites = measurement.writes.filter((w) => w.id === "race-asst");
    expect(raceWrites.length, "the resumed message was written").toBeGreaterThan(0);
    expect(raceWrites.at(-1)?.approvals, "the written row carries the approval").toContain(
      "aitxt-RaceApproval",
    );
    // Here the load was already merged before the settle, so the row links to
    // the loaded tail — the difference between this case and forced-fast.
    expect(raceWrites.at(-1)?.parentId, "the resumed row's parent").toBe("a0");
  }, 20_000);
});
