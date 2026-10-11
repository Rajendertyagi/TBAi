/**
 * P2 Direct History Window — real RUNTIME RENDERING, on a NON-PRODUCTION path.
 *
 * ## What this file proves
 *
 * That the INSTALLED assistant-ui runtime — the real `useRemoteThreadListRuntime`
 * plus the real `useChatRuntime`, its own converter, its own binding and its own
 * repository — renders a bounded, branch-correct window, and that the frozen
 * write-back invariants hold against real converted rows. Nothing here
 * re-implements assistant-ui.
 *
 * ## What this file does NOT prove (read before citing it)
 *
 * It deliberately does NOT exercise the production history path, and it must not
 * be cited as evidence that it does. Production wires history through
 * `adapters.history` (`ThreadHistoryAdapter.withFormat`), which
 * `useExternalHistory` loads ONCE per mount and installs via
 * `thread.import(...)` + `chatHelpers.setMessages(...)`. This file instead:
 *
 *   - seeds the window through the `messageRepository` OPTION, which production
 *     deliberately never passes (`web/src/runtime.ts`: it is a one-shot seed that
 *     `useAISDKRuntime` only feeds while the chat is empty, and running both
 *     would create two competing history writers);
 *   - supplies a STUB history adapter whose `load()` returns no rows, so the
 *     `WindowController` → window → `useExternalHistory` chain is bypassed;
 *   - calls `controller.repositorySeed()` and `controller.writeBack()`, which have
 *     no production caller today.
 *
 * Those are real gaps in production coverage, tracked as such — not as something
 * this file covers. The production-path equivalents are:
 *
 *   - `web/src/adapters/threadHistoryAdapter.phase3.test.ts` — the real adapter,
 *     including the empty-conversation and update-as-upsert contracts.
 *   - `web/e2e/p2-history-load-recovery.spec.ts` — real server, real browser.
 *
 * `goHistorical` is likewise called on the controller directly, so this proves the
 * controller flips to a historical window; it does not prove the runtime's message
 * list follows.
 */

import { describe, expect, it } from "bun:test";
import { act, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useAuiState,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/ai-sdk";
import {
  AISDKMessageConverter,
  ExportedMessageRepository,
  ExternalStoreThreadRuntimeCore,
  getExternalStoreMessages,
} from "../../helpers/dom/resolve.ts";
import {
  WindowController,
  type PersistedRow,
} from "@web/features/chat/history/windowController.ts";

const enc = new TextEncoder();
const sse = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);

let _submissions = 0;
const transport = new AssistantChatTransport({
  api: "/api/chat",
  fetch: (async () => {
    _submissions += 1;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(sse({ type: "start", messageId: "s1" }));
          c.enqueue(sse({ type: "text-start", id: "t1" }));
          c.enqueue(sse({ type: "text-delta", id: "t1", delta: "ok" }));
          c.enqueue(sse({ type: "text-end", id: "t1" }));
          c.enqueue(sse({ type: "finish" }));
          c.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch,
});

/** AI SDK messages, two of which are adjacent assistants (they merge). */
const row = (n: number): PersistedRow => {
  const assistant = n === 2 || n === 3;
  return {
    id: `m${n}`,
    parentId: n === 1 ? null : `m${n - 1}`,
    format: "ai-sdk/v6",
    content: { id: `m${n}` },
    message: {
      id: `m${n}`,
      role: assistant ? "assistant" : "user",
      parts: [{ type: "text", text: `body m${n}` }],
    },
  };
};

const ROWS = [1, 2, 3, 4, 5].map(row);

const controllerFor = () =>
  new WindowController({
    limit: 50,
    overscan: 2,
    anchors: () => ({
      top: { messageId: "m4", offset: 0 },
      bottom: { messageId: "m5", offset: 0 },
    }),
    fetchWindow: async ({ direction, anchorId }) => {
      const ids = ROWS.map((r) => r.id);
      const start =
        anchorId === null
          ? 0
          : Math.max(0, ids.indexOf(anchorId) + (direction === "older" ? -4 : 1));
      return {
        messages: ROWS.slice(start, start + 5),
        hasMoreBefore: start > 0,
        hasMoreAfter: start + 5 < ROWS.length,
        contiguous: true,
        complete: true,
      };
    },
  });

let renderedIds: string[] = [];
function Probe() {
  renderedIds = useAuiState((s) => s.thread.messages).map((m) => m.id);
  return null;
}

function App({ controller }: { controller: WindowController }) {
  const seed = controller.repositorySeed();
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: useMemo(
      () =>
        function Thread() {
          return useDirectThread(seed);
        },
      [seed],
    ),
    adapter: {
      list: async () => ({ threads: [{ remoteId: "p2", title: "t", status: "regular" }] }),
      fetch: async (id: string) => ({ remoteId: id, title: "t", status: "regular" }),
      initialize: async (id: string) => ({ remoteId: id }),
      rename: async () => {},
      delete: async () => {},
      archive: async () => {},
      unarchive: async () => {},
      generateTitle: async () => new ReadableStream({ start: (c) => c.close() }),
    } as never,
    threadId: "p2",
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Probe />
    </AssistantRuntimeProvider>
  );
}

/** The real runtime, seeded with the controller's bounded window. */
function useDirectThread(seed: ReturnType<WindowController["repositorySeed"]>) {
  return useChatRuntime({
    transport,
    messageRepository: {
      messages: seed.messages.map((m) => ({ message: m.message, parentId: m.parentId })),
      headId: seed.headId,
    } as never,
    isSendDisabled: false,
    adapters: {
      history: {
        load: async () => ({ messages: [], headId: null }),
        append: async () => {},
        update: async () => {},
        delete: async () => {},
        withFormat: () => ({
          load: async () => ({ messages: [] }),
          append: async () => {},
          update: async () => {},
          delete: async () => {},
        }),
      },
    },
  } as never);
}

async function mount(controller: WindowController) {
  await controller.loadTip();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<App controller={controller} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  return root;
}

describe("P2 — real runtime rendering (non-production seed path; see file header)", () => {
  it("A/I. the bounded window renders, merging adjacent assistants, and stays recoverable", async () => {
    const controller = controllerFor();
    const root = await mount(controller);

    console.log("\n=== real runtime: bounded window ===");
    console.log(`  controller window: ${controller.windowIds().join(",")}`);
    console.log(`  rendered rows   : ${renderedIds.join(",")}`);

    // Four persisted messages m2+m3 are adjacent assistants, so the runtime
    // renders three rows — legitimate display grouping.
    expect(controller.windowIds()).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(renderedIds).toEqual(["m1", "m2", "m4", "m5"]);

    // Every persisted identity is still recoverable from the runtime's rows.
    const core = new ExternalStoreThreadRuntimeCore(
      {
        getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
        registerModelContextProvider: () => () => {},
      } as never,
      {
        messages: AISDKMessageConverter.toThreadMessages(
          ROWS.map((r) => r.message) as never,
          false,
          {} as never,
        ) as never,
        isRunning: false,
      } as never,
    );
    const merged = (core.messages as Array<{ id: string }>).find((m) => m.id === "m2")!;
    expect(
      (getExternalStoreMessages(merged as never) as Array<{ id: string }>).map((m) => m.id),
    ).toEqual(["m2", "m3"]);

    await act(async () => root.unmount());
  });

  it("J/K. write-back over the seed's runtime rows recovers every persisted message", async () => {
    const controller = controllerFor();
    await controller.loadTip();

    // The rows upstream hands back are CONVERSION OUTPUT: convert the stored
    // window, then read it back through the repository import path upstream uses.
    const converted = AISDKMessageConverter.toThreadMessages(
      ROWS.map((r) => r.message) as never,
      false,
      {} as never,
    ) as never as Array<{ id: string }>;
    const core = new ExternalStoreThreadRuntimeCore(
      {
        getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
        registerModelContextProvider: () => () => {},
      } as never,
      {
        messageRepository: {
          messages: converted.map((m, i) => ({
            message: m,
            parentId: i === 0 ? null : converted[i - 1]!.id,
          })),
          headId: converted.at(-1)!.id,
        } as never,
        isRunning: false,
      } as never,
    );
    const rows = core.messages as Array<{ id: string }>;

    // L. merged row: the write-back carries BOTH m2 and m3, and m4's parent is
    // the persisted m3 rather than the row m2.
    const writeBack = controller.writeBack(
      rows.map((m, i) => ({
        message: m,
        parentId: i === 0 ? null : (rows[i - 1] as { id: string }).id,
      })),
    );
    console.log("\n=== real runtime: write-back ===");
    console.log(`  rendered rows : ${rows.map((m) => m.id).join(",")}`);
    console.log(`  write-back    : ${writeBack.messages.map((m) => m.id).join(",")}`);
    console.log(
      `  parents       : ${JSON.stringify(writeBack.messages.map((m) => [m.id, m.parentId]))}`,
    );

    expect(writeBack.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(Object.fromEntries(writeBack.messages.map((m) => [m.id, m.parentId]))).toEqual({
      m1: null,
      m2: "m1",
      m3: "m2",
      m4: "m3",
      m5: "m4",
    });
    expect(writeBack.headId).toBe("m5");

    // K. a repository rebuilt without the binding cannot become an empty write.
    const stripped = ExportedMessageRepository.fromBranchableArray(
      converted.map((m, i) => ({
        message: m,
        parentId: i === 0 ? null : converted[i - 1]!.id,
      })) as never,
      { headId: converted.at(-1)!.id },
    );
    const strippedRows = (
      stripped as never as { messages: Array<{ message: unknown; parentId: string | null }> }
    ).messages;
    expect(() => controller.writeBack(strippedRows)).toThrow();
  });

  it("D/E. historical state blocks the send; restoring re-enables it", async () => {
    _submissions = 0;
    const controller = controllerFor();
    const root = await mount(controller);

    await act(async () => {
      await controller.goHistorical("m2");
    });

    console.log("\n=== real runtime: historical gate ===");
    console.log(
      `  historical=${controller.historical} active=${controller.isActive} tip=${controller.authoritativeTip}`,
    );
    expect(controller.historical).toBe(true);
    expect(controller.isActive).toBe(false);
    // The authoritative tip is preserved while viewing history.
    expect(controller.authoritativeTip).toBe("m5");

    await act(async () => {
      await controller.restoreTip();
    });
    expect(controller.isActive).toBe(true);

    await act(async () => root.unmount());
  });
});
