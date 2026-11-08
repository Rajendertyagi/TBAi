/**
 * P0 DIAGNOSTIC — what the LIVE runtime reports for a route-`toolApproval` pause,
 * and what survives a reload.
 *
 * TEST-ONLY MEASUREMENT. This file changes no production behaviour; it exists to
 * decide Phase 1 of `docs/2026-11-06-tool-approval-persistence-plan.md` with data
 * instead of inference.
 *
 * ## What it measures
 *
 * The real `useChatRuntime` — the same wrapper `web/src/runtime.ts` mounts — is
 * fed a replay of the chunk tail recorded in the incident stream. Three things are
 * read back from the live thread:
 *
 *   1. the assistant message's `status.type` and `status.reason` at the pause;
 *   2. whether its `tool-call` part carries `approval` (and what is in it);
 *   3. whether the history adapter's `append`/`update` were actually called —
 *      asserted on the adapter, never on rendered output, because a rendered card
 *      can survive while the row does not exist.
 *
 * The second case then reloads from exactly the rows case 1 wrote, so the
 * restore path (F5-2) is measured against the real converter rather than a
 * fixture someone wrote by hand.
 *
 * ## The replay is transcribed, not invented
 *
 * The chunk sequence mirrors stream `qt0qlv20nkvtmegl3u945bv3` (conversation
 * `l3a3wajur7egicyihwszccn3`, 2099 chunks, `finishReason: "tool-calls"`), read
 * from a read-only database copy. It is trimmed to the parts that shape the
 * message — reasoning and the `data-tbai-progress` envelope are omitted — and the
 * file content is shortened. Everything the assertions depend on is byte-for-byte
 * the shape the server emitted: `tool-input-start` → `tool-input-delta` →
 * `tool-input-available` → `tool-approval-request` → `finish-step` → `finish`.
 *
 * Both approval carriers (`needsApproval` on the tool, and the route-level
 * `toolApproval` map) produce this identical wire sequence: `resolveToolApproval`
 * in `ai` 7.0.145 returns `{ type: "user-approval" }` for either, and the UI chunk
 * carries no tool name. So one replay measures both.
 *
 * ## Why the log comes before the assertions
 *
 * The measurement is printed first and asserted second. If the runtime disagrees
 * with the plan's precondition, the printed block is still the evidence, and the
 * failing assertion names which precondition broke.
 */

import { describe, expect, it } from "bun:test";
import { act, createElement, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";

const enc = new TextEncoder();
const sse = (chunk: unknown) => enc.encode(`data: ${JSON.stringify(chunk)}\n\n`);

/** The recorded tail, trimmed as described in the file header. */
const REPLAY: readonly unknown[] = [
  { type: "start", messageId: "p0-asst" },
  { type: "start-step" },
  { type: "text-start", id: "txt-p0" },
  { type: "text-delta", id: "txt-p0", delta: "Let me write a compact version:\n\n" },
  { type: "text-end", id: "txt-p0" },
  { type: "tool-input-start", toolCallId: "call_p0", toolName: "write_file", dynamic: false },
  {
    type: "tool-input-delta",
    toolCallId: "call_p0",
    inputTextDelta: '{"path":"D:\\\\Test\\\\chat-suggest\\\\src\\\\App.tsx"',
  },
  { type: "tool-input-delta", toolCallId: "call_p0", inputTextDelta: ',"content":"export {};"}' },
  {
    type: "tool-input-available",
    toolCallId: "call_p0",
    toolName: "write_file",
    // The route-`toolApproval` carrier: the server gates `write_file` by map,
    // not by `needsApproval` on the tool. The wire chunk is the same either way.
    input: { path: "D:\\Test\\chat-suggest\\src\\App.tsx", content: "export {};" },
    dynamic: false,
  },
  {
    type: "tool-approval-request",
    approvalId: "aitxt-P0Approval",
    toolCallId: "call_p0",
    signature: "p0-signature",
  },
  { type: "finish-step" },
  { type: "finish", finishReason: "tool-calls" },
];

/* ── Storage format round trip ────────────────────────────────────────────── */

/**
 * `aiSDKV6FormatAdapter`, restated: the stored form of an AI SDK message is the
 * message without its id. The runtime hands `append` the thread message and
 * `load` back the same shape, so this pair is the whole transform production's
 * `withFormat` adds.
 */
const encodeStored = (message: { id: string } & Record<string, unknown>) => {
  const { id: _id, ...rest } = message;
  return rest;
};
const decodeStored = (row: StoredRow) => ({
  parentId: row.parent_id,
  message: { id: row.id, ...(row.content as Record<string, unknown>) },
});

interface StoredRow {
  id: string;
  parent_id: string | null;
  format: "ai-sdk/v6";
  content: unknown;
}

/* ── The recording history adapter (production shape) ─────────────────────── */

interface HistoryCall {
  op: "append" | "update";
  id: string;
  parentId: string | null;
}

const historyCalls: HistoryCall[] = [];
const storedRows: StoredRow[] = [];
/**
 * How many times the history load ran. `useExternalHistory` loads only once the
 * runtime has a `remoteId`, so this doubles as the "the remote thread has
 * switched in" signal — appending before it targets a different thread core.
 */
let recordingLoadCalls = 0;

/**
 * Mirrors `web/src/adapters/threadHistoryAdapter.ts`: `load` + `withFormat`,
 * where every durable write goes through the format adapter's `append`/`update`.
 */
const RECORDING_HISTORY = {
  load: async () => ({ messages: [], headId: null }),
  append: async () => {},
  update: async () => {},
  delete: async () => {},
  withFormat: () => ({
    pin: () => {},
    load: async () => {
      recordingLoadCalls += 1;
      return { messages: [], headId: null };
    },
    append: async (item: { message: { id: string }; parentId: string | null }) => {
      historyCalls.push({ op: "append", id: item.message.id, parentId: item.parentId ?? null });
      storedRows.push({
        id: item.message.id,
        parent_id: item.parentId ?? null,
        format: "ai-sdk/v6",
        content: encodeStored(item.message as { id: string } & Record<string, unknown>),
      });
    },
    update: async (item: { message: { id: string }; parentId: string | null }, id?: string) => {
      historyCalls.push({
        op: "update",
        id: id ?? item.message.id,
        parentId: item.parentId ?? null,
      });
      storedRows.push({
        id: item.message.id,
        parent_id: item.parentId ?? null,
        format: "ai-sdk/v6",
        content: encodeStored(item.message as { id: string } & Record<string, unknown>),
      });
    },
    delete: async () => {},
  }),
};

/** The same adapter, loading the rows case 1 wrote — a real reload. */
let reloadLoadCalls = 0;
const RELOAD_HISTORY = {
  ...RECORDING_HISTORY,
  withFormat: () => ({
    pin: () => {},
    load: async () => {
      reloadLoadCalls += 1;
      return {
        headId: storedRows.at(-1)?.id ?? null,
        messages: storedRows.map(decodeStored),
      };
    },
    append: RECORDING_HISTORY.withFormat().append,
    update: RECORDING_HISTORY.withFormat().update,
    delete: async () => {},
  }),
};

/* ── Live state captured from the real runtime ────────────────────────────── */

interface TimelineSample {
  isRunning: boolean;
  statusType: string | null;
  statusReason: string | null;
  approval: unknown;
  hasResult: boolean;
}

type LivePart = { type: string; toolName?: string; result?: unknown; approval?: unknown };
type LiveMessage = {
  id: string;
  role: string;
  status?: { type: string; reason?: string };
  content: LivePart[];
};

let liveMessages: readonly LiveMessage[] = [];
let liveRunning = false;
let auiRef: ReturnType<typeof useAui> | null = null;
const timeline: TimelineSample[] = [];

function sampleOf(): TimelineSample | null {
  const assistant = [...liveMessages].reverse().find((m) => m.role === "assistant");
  const tool = assistant?.content?.find((p) => p.type === "tool-call");
  if (!assistant || !tool) return null;
  return {
    isRunning: liveRunning,
    statusType: assistant.status?.type ?? null,
    statusReason: assistant.status?.reason ?? null,
    approval: tool.approval ?? null,
    hasResult: tool.result !== undefined,
  };
}

function Probe() {
  auiRef = useAui();
  liveMessages = useAuiState((s) => s.thread.messages) as unknown as readonly LiveMessage[];
  liveRunning = useAuiState((s) => s.thread.isRunning);

  const sample = sampleOf();
  if (sample && JSON.stringify(timeline.at(-1)) !== JSON.stringify(sample)) timeline.push(sample);
  return null;
}

const replayFetch = (async () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of REPLAY) controller.enqueue(sse(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  )) as unknown as typeof fetch;

/**
 * The remote-thread shell production mounts. It is what gives the runtime a
 * `remoteId`: `useExternalHistory` skips `withFormat().load()` entirely when
 * there is none, so a bare `useChatRuntime` can never exercise the restore path.
 */
const THREAD_LIST_ADAPTER = {
  list: async () => ({ threads: [{ remoteId: "p0-thread", title: "p0", status: "regular" }] }),
  fetch: async (id: string) => ({ remoteId: id, title: "p0", status: "regular" }),
  initialize: async (id: string) => ({ remoteId: id }),
  rename: async () => {},
  delete: async () => {},
  archive: async () => {},
  unarchive: async () => {},
  generateTitle: async () => new ReadableStream({ start: (c) => c.close() }),
};

function DirectThread({ history }: { history: unknown }) {
  const transport = useMemo(
    () => new AssistantChatTransport({ api: "/api/chat", fetch: replayFetch }),
    [],
  );
  return useChatRuntime({ transport, isSendDisabled: false, adapters: { history } } as never);
}

function App({ history }: { history: unknown }) {
  const runtimeHook = useMemo(
    () =>
      function ThreadRuntime() {
        return DirectThread({ history });
      },
    [history],
  );
  const runtime = useRemoteThreadListRuntime({
    runtimeHook,
    adapter: THREAD_LIST_ADAPTER as never,
    threadId: "p0-thread",
  });
  return createElement(AssistantRuntimeProvider, { runtime }, createElement(Probe));
}

const flush = async (ms = 20) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await flush(10);
  }
  console.warn(`P0 wait timed out: ${label}`);
  return false;
}

function mount(history: unknown): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(App, { history }));
  });
  return { root, container };
}

function resetProbe() {
  timeline.length = 0;
  liveMessages = [];
  liveRunning = false;
  auiRef = null;
}

describe("P0 — live StatusKind for a route-toolApproval pause", () => {
  it("case 1: records the live status, the approval carrier and the history writes", async () => {
    historyCalls.length = 0;
    storedRows.length = 0;
    recordingLoadCalls = 0;
    reloadLoadCalls = 0;
    resetProbe();

    const { root } = mount(RECORDING_HISTORY);
    await waitFor(() => auiRef !== null, "runtime mounts");
    // The remote thread list resolves asynchronously; appending before its thread
    // is in place drives a different thread core than the one the probe reads.
    await waitFor(() => recordingLoadCalls > 0, "history ready (remote thread switched in)");
    await flush(50);

    await act(async () => {
      void auiRef!.thread.append({
        role: "user",
        content: [{ type: "text", text: "rewrite App.tsx" }],
      } as never);
    });

    await waitFor(
      () => liveMessages.some((m) => m.content.some((p) => p.type === "tool-call")),
      "tool-call part appears",
    );
    const settled = await waitFor(() => !liveRunning, "run settles after finish(tool-calls)");
    // Persistence is scheduled on a `setTimeout(…, 0)` after settle.
    await flush(150);

    const assistant = [...liveMessages].reverse().find((m) => m.role === "assistant");
    const tool = assistant?.content.find((p) => p.type === "tool-call");

    const measurement = {
      runSettled: settled,
      isRunning: liveRunning,
      messageId: assistant?.id ?? null,
      status: assistant?.status
        ? { type: assistant.status.type, reason: assistant.status.reason ?? null }
        : null,
      toolCall: tool
        ? {
            toolName: tool.toolName ?? null,
            hasResult: tool.result !== undefined,
            hasApproval: tool.approval != null,
            approval: tool.approval ?? null,
          }
        : null,
      historyCalls: [...historyCalls],
      storedRowIds: storedRows.map((r) => r.id),
      timeline: [...timeline],
    };
    console.log(`P0_MEASUREMENT_CASE1 ${JSON.stringify(measurement, null, 2)}`);

    await act(async () => root.unmount());

    // Preconditions, asserted one at a time so a failure names the broken one.
    expect(assistant, "an assistant message exists after the pause").toBeDefined();
    expect(tool, "the assistant message carries a tool-call part").toBeDefined();
    expect(liveRunning, "the run settled (isRunning === false) at the pause").toBe(false);
    expect(assistant!.status?.type, "live status.type at the pause").toBe("requires-action");
    expect(tool!.result, "the paused tool call has no result yet").toBeUndefined();
    expect(tool!.approval, "the tool-call part carries `approval`").not.toBeNull();
    expect(
      historyCalls.some((c) => c.id === assistant!.id),
      "the pause was written to history (append/update for the assistant row)",
    ).toBe(true);
  }, 20_000);

  it("case 2: reloading those exact rows restores the pause", async () => {
    expect(storedRows.length, "case 1 wrote rows to reload").toBeGreaterThan(0);

    resetProbe();
    const { root } = mount(RELOAD_HISTORY);

    await waitFor(() => liveMessages.length >= storedRows.length, "history load restores rows");
    await flush(100);

    const assistant = [...liveMessages].reverse().find((m) => m.role === "assistant");
    const tool = assistant?.content.find((p) => p.type === "tool-call");

    const measurement = {
      reloadLoadCalls,
      restored: liveMessages.map((m) => ({ id: m.id, role: m.role })),
      isRunning: liveRunning,
      status: assistant?.status
        ? { type: assistant.status.type, reason: assistant.status.reason ?? null }
        : null,
      toolCall: tool
        ? {
            toolName: tool.toolName ?? null,
            hasResult: tool.result !== undefined,
            hasApproval: tool.approval != null,
            approval: tool.approval ?? null,
          }
        : null,
      timeline: [...timeline],
    };
    console.log(`P0_MEASUREMENT_CASE2 ${JSON.stringify(measurement, null, 2)}`);

    await act(async () => root.unmount());

    expect(assistant, "reload restores the assistant row").toBeDefined();
    expect(tool, "the restored row keeps its tool-call part").toBeDefined();
    expect(assistant!.status?.type, "restored status.type").toBe("requires-action");
    expect(tool!.approval, "the restored tool-call part carries `approval`").not.toBeNull();
  }, 20_000);
});
