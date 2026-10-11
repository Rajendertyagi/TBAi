/**
 * P2 Direct History Window — the LIVE paging path.
 *
 * Proves the durable architecture end to end at the boundary that matters:
 *
 *   GET /messages/window -> WindowController -> useAISDKChat().setMessages()
 *
 * `useAISDKChat` is mocked so the AI SDK chat's message array is observable, but
 * the controller, the frozen core and the hook are the production ones. Nothing
 * here reimplements window policy.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

/** The AI SDK chat stand-in: the public helper the hook pages through. */
type FakeMessage = { id: string; role: "user" | "assistant"; parts: unknown[] };
const chat = {
  messages: [] as FakeMessage[],
  status: "ready" as "ready" | "streaming",
  setMessages: (next: FakeMessage[] | ((cur: FakeMessage[]) => FakeMessage[])) => {
    chat.messages = typeof next === "function" ? next(chat.messages) : next;
  },
};

const realFetch = globalThis.fetch;

mock.module("@assistant-ui/ai-sdk", () => ({
  useAISDKChat: () => chat,
}));

/** Rows the backend serves, oldest first, with persisted parentage. */
type Row = { id: string; parent_id: string | null; text: string };

let served: Row[] = [];
let windowCalls: string[] = [];

/** A window-route response: the tail page, plus `hasMoreBefore` for older pages. */
const respond = (url: string): Response => {
  windowCalls.push(url);
  const query = new URL(url, "http://local").searchParams;
  const direction = query.get("direction");
  const anchor = query.get("anchorId");
  const limit = Number(query.get("limit"));

  let slice: Row[] = [];
  let hasMoreBefore = false;
  let hasMoreAfter = false;

  if (direction === "newer") {
    const at = served.findIndex((r) => r.id === anchor);
    slice = at < 0 ? [] : served.slice(at, at + limit);
    hasMoreAfter = slice.length > 0 && at + slice.length < served.length;
    hasMoreBefore = at > 0;
  } else if (anchor) {
    // The backend's older walk starts AT the anchor and includes it, so the page
    // overlaps the current window. The frozen core merges on that shared anchor
    // and refuses a slice that does not overlap, so the mock must match.
    const at = served.findIndex((r) => r.id === anchor);
    const start = at < 0 ? Math.max(0, served.length - limit) : Math.max(0, at - limit);
    slice = served.slice(start, at < 0 ? served.length : at + 1);
    hasMoreBefore = start > 0;
  } else {
    slice = served.slice(Math.max(0, served.length - limit));
    hasMoreBefore = served.length > limit;
  }

  return {
    ok: true,
    status: 200,
    json: async () => ({
      messages: slice.map((r) => ({
        id: r.id,
        parent_id: r.parent_id,
        format: "ai-sdk/v6",
        content: { id: r.id, role: r.id.startsWith("u") ? "user" : "assistant", parts: [{ type: "text", text: r.text }] },
      })),
      hasMoreBefore,
      hasMoreAfter,
      contiguous: true, complete: true,
    }),
  } as Response;
};

const windowModule = await import("@web/features/chat/history/useDirectHistoryWindow.ts");

/** Mount the real hook and expose what it returns. */
function mount(conversationId: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let api: ReturnType<typeof windowModule.useDirectHistoryWindow> | null = null;
  const Harness = () => {
    api = windowModule.useDirectHistoryWindow(conversationId);
    return null;
  };
  act(() => {
    root.render(<Harness />);
  });
  return {
    get: () => {
      if (!api) throw new Error("hook did not render");
      return api;
    },
    unmount: () => act(() => root.unmount()),
  };
}

/** Seed a conversation's bounded tip window, exactly as the adapter's load() does. */
async function seedWindow(conversationId: string) {
  const controller = windowModule.ensureWindowController(conversationId, (stored) => ({
    parentId: stored.parent_id,
    message: stored.content,
  }));
  await controller.loadTip();
  windowModule.publishWindowUi(conversationId, controller);
  // The adapter installs the loaded window into the live chat.
  chat.setMessages(controller.rows().map((r) => r.message as FakeMessage));
  return controller;
}

const conversation = (n: string) => `conv-${n}-${Math.random().toString(36).slice(2, 8)}`;

/** The window's own head — what the authoritative tip must stay equal to. */
const tipOf = (controller: { rows(): readonly { id: string }[] }) =>
  controller.rows().at(-1)?.id ?? null;

beforeEach(() => {
  served = [];
  windowCalls = [];
  chat.messages = [];
  chat.status = "ready";
  globalThis.fetch = (async (url: unknown) => respond(String(url))) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("P2 live paging through the public AI SDK chat helper", () => {
  it("[D] the initial window is bounded and reaches the chat through the adapter", async () => {
    served = Array.from({ length: 250 }, (_, i) => ({
      id: `m${i + 1}`,
      parent_id: i === 0 ? null : `m${i}`,
      text: `body-${i + 1}`,
    }));
    const id = conversation("init");

    const controller = await seedWindow(id);

    // Bounded: the tail only, never the whole conversation.
    expect(controller.rows().length).toBeLessThan(250);
    expect(controller.hasMoreBefore).toBe(true);
    expect(chat.messages.at(-1)?.id).toBe(controller.rows().at(-1)?.id);
    // And the full-history endpoint was never consulted.
    expect(windowCalls.every((c) => c.includes("/messages/window"))).toBe(true);
  });

  it("[E/F] load earlier prepends the next page with stable ids, and is duplicate-free", async () => {
    // More rows than the window limit, so an older page genuinely exists.
    served = Array.from({ length: 150 }, (_, i) => ({
      id: `m${i + 1}`,
      parent_id: i === 0 ? null : `m${i}`,
      text: `body-${i + 1}`,
    }));
    const id = conversation("older");
    const controller = await seedWindow(id);
    expect(controller.hasMoreBefore).toBe(true);
    const before = controller.rows().length;
    const beforeFirst = chat.messages[0]?.id;

    const ui = mount(id);
    await act(async () => {
      await ui.get().loadEarlier();
    });

    const afterFirst = chat.messages[0]?.id;
    expect(afterFirst).not.toBe(beforeFirst);
    expect(chat.messages.filter((m) => m.id === beforeFirst)).toHaveLength(1);
    expect(controller.rows().length).toBeGreaterThan(before);

    // Paging back IS the historical transition: the window is no longer the
    // active tip run, so the composer must be gated until the tip is restored.
    expect(ui.get().isHistorical).toBe(true);
    expect(controller.authoritativeTip).toBe(tipOf(controller));

    // Repeated paging never duplicates an id that is already in the chat.
    await act(async () => {
      await ui.get().loadEarlier();
    });
    expect(chat.messages.length).toBe(new Set(chat.messages.map((m) => m.id)).size);

    ui.unmount();
  });

  it("[G] parentage across the page boundary stays persisted", async () => {
    served = Array.from({ length: 150 }, (_, i) => ({
      id: `m${i + 1}`,
      parent_id: i === 0 ? null : `m${i}`,
      text: `body-${i + 1}`,
    }));
    const id = conversation("parents");
    const controller = await seedWindow(id);
    const ui = mount(id);
    await act(async () => {
      await ui.get().loadEarlier();
    });

    // Interior rows keep their persisted link across the page boundary; the
    // controller never re-parents a row onto its neighbour.
    const rows = controller.rows();
    expect(rows.length).toBeGreaterThan(100);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].parentId).toBe(rows[i - 1].id);
    }
    ui.unmount();
  });

  it("[I/J] restore is idempotent and returns to the authoritative tip", async () => {
    served = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i + 1}`,
      parent_id: i === 0 ? null : `m${i}`,
      text: `body-${i + 1}`,
    }));
    const id = conversation("restore");
    const controller = await seedWindow(id);
    const tip = controller.authoritativeTip;
    const ui = mount(id);

    // Historical navigation is refused while a run holds the thread.
    chat.status = "streaming";
    await act(async () => {
      await ui.get().goHistorical("m2");
    });
    expect(ui.get().isHistorical).toBe(false);

    chat.status = "ready";
    await act(async () => {
      await ui.get().goHistorical("m2");
    });
    expect(ui.get().isHistorical).toBe(true);
    expect(ui.get().authoritativeTip).toBe(tip);

    await act(async () => {
      await ui.get().restoreTip();
    });
    expect(ui.get().isHistorical).toBe(false);
    expect(controller.authoritativeTip).toBe(tip);
    const afterRestore = controller.windowIds().join(",");

    // Idempotent: restoring again is a no-op, not a failure or a rebase.
    await act(async () => {
      await ui.get().restoreTip();
    });
    expect(ui.get().isHistorical).toBe(false);
    expect(controller.windowIds().join(",")).toBe(afterRestore);
    ui.unmount();
  });

  it("[W] a failed page leaves the window exactly as it was", async () => {
    served = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i + 1}`,
      parent_id: i === 0 ? null : `m${i}`,
      text: `body-${i + 1}`,
    }));
    const id = conversation("failure");
    const controller = await seedWindow(id);
    const before = controller.windowIds().join(",");
    const ui = mount(id);

    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await act(async () => {
      await ui.get().loadEarlier().catch(() => undefined);
    });

    expect(controller.windowIds().join(",")).toBe(before);
    ui.unmount();
  });
});
