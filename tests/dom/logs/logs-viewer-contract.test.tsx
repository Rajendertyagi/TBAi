import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type FetchCall = { input: string; init?: RequestInit };

const fetchCalls: FetchCall[] = [];
let settingsResponse: unknown = {
  level: "info",
  targets: [{ scope: "mcp", level: "debug" }],
  env_locked: false,
  file: {
    enabled: true,
    path: "tbai.log",
    maxMb: 5,
    keepFiles: 20,
    maxTotalMb: 100,
    retentionHours: 24,
  },
  file_locked: false,
  throttle: { throttled: [] },
};
let recentResponse: unknown = { entries: [], bootId: "boot-1" };
let filesResponse: unknown = { files: [], retention: null };

const platformMock = {
  apiFetch: async (input: string, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({ input, init });
    if (input.startsWith("/api/logs/settings") && init?.method === "PUT") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (input.startsWith("/api/logs/settings")) {
      return new Response(JSON.stringify(settingsResponse), { status: 200 });
    }
    if (input.startsWith("/api/logs/recent")) {
      return new Response(JSON.stringify(recentResponse), { status: 200 });
    }
    if (input.startsWith("/api/logs/files/")) {
      return new Response("file-content", { status: 200 });
    }
    if (input.startsWith("/api/logs/files")) {
      return new Response(JSON.stringify(filesResponse), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  },
  resolveApiUrl: (path: string) => `http://localhost${path}`,
};

mock.module("@/lib/platform", () => platformMock);
mock.module("@web/lib/platform", () => platformMock);

mock.module("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 29,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({
        index,
        key: index,
        start: index * 29,
        size: 29,
      })),
    scrollToIndex: () => {},
    measureElement: () => {},
  }),
}));

mock.module("sonner", () => ({
  toast: { success: () => {}, error: () => {}, info: () => {} },
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, listener: (ev: MessageEvent) => void) {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      arr.filter((l) => l !== listener),
    );
  }

  emit(type: string, data: unknown) {
    const ev = { data: JSON.stringify(data) } as MessageEvent;
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }

  close() {
    this.closed = true;
  }
}

const originalEventSource = globalThis.EventSource;

const { LogsViewer } = await import("@web/features/logs/components/LogsViewer");

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("LogsViewer contract regressions (DOM)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    fetchCalls.length = 0;
    FakeEventSource.instances = [];
    (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    settingsResponse = {
      level: "info",
      targets: [{ scope: "mcp", level: "debug" }],
      env_locked: false,
      file: {
        enabled: true,
        path: "tbai.log",
        maxMb: 5,
        keepFiles: 20,
        maxTotalMb: 100,
        retentionHours: 24,
      },
      file_locked: false,
      throttle: { throttled: [] },
    };
    recentResponse = { entries: [], bootId: "boot-1" };
    filesResponse = { files: [], retention: null };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
      originalEventSource;
  });

  it("subscribes to SSE named 'entries' event (not onmessage)", async () => {
    await act(async () => {
      root.render(<LogsViewer />);
    });
    await flush();
    await flush();

    expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    const es = FakeEventSource.instances[0];
    // If implementation used onmessage only, emitting 'entries' would do nothing.
    await act(async () => {
      es.emit("entries", {
        bootId: "boot-1",
        entries: [
          {
            seq: 1,
            time: "2026-01-01T00:00:00.000Z",
            level: "info",
            scope: "http",
            event: "req",
            message: "hello",
          },
        ],
      });
    });
    await flush();

    expect(container.textContent).toContain("hello");
  });

  it("loads settings using backend 'targets' and preserves env/file lock state", async () => {
    settingsResponse = {
      level: "warn",
      targets: [{ scope: "ai.provider", level: "debug" }],
      env_locked: true,
      file: {
        enabled: false,
        path: "tbai.log",
        maxMb: 5,
        keepFiles: 20,
        maxTotalMb: 100,
        retentionHours: 24,
      },
      file_locked: true,
      throttle: { throttled: [{ scope: "chat", dropped: 3 }] },
    };

    await act(async () => {
      root.render(<LogsViewer />);
    });
    await flush();
    await flush();

    // Open settings dialog
    const settingsBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Settings"),
    );
    expect(settingsBtn).toBeTruthy();
    await act(async () => {
      settingsBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const dialogText = document.body.textContent ?? "";
    expect(dialogText).toContain("Controlled by TBAI_LOG_LEVEL");
    expect(dialogText).toContain("Controlled by TBAI_LOG_FILE");
    const scopeInput = Array.from(document.body.querySelectorAll('input[placeholder="mcp"]')).find(
      (el) => (el as HTMLInputElement).value === "ai.provider",
    );
    expect(scopeInput).toBeTruthy();
    expect(container.textContent).toContain("Throttling chat (3 shed)");
  });

  it("sends PUT settings with 'targets' (validated) and preserves file settings", async () => {
    await act(async () => {
      root.render(<LogsViewer />);
    });
    await flush();
    await flush();

    // Open settings and add an invalid + valid target via UI is complex; trigger
    // a capture level change which uses the serialized save path and should send
    // the loaded targets/file from authoritative state.
    const settingsBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Settings"),
    );
    await act(async () => {
      settingsBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // The dialog has a capture-level select (includes OFF/ERROR/WARN/INFO/DEBUG).
    // Pick the first select in the dialog that contains "DEBUG" as an option and
    // is not the per-scope level select (scope rows also have level selects).
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    const selects = Array.from(dialog!.querySelectorAll("select"));
    const levelSelect = selects.find((s) =>
      Array.from(s.querySelectorAll("option")).some(
        (o) => o.value === "off" || o.textContent === "OFF",
      ),
    );
    expect(levelSelect).toBeTruthy();
    await act(async () => {
      levelSelect!.value = "debug";
      levelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await flush();
    await flush();

    const put = [...fetchCalls]
      .reverse()
      .find((c) => c.input.startsWith("/api/logs/settings") && c.init?.method === "PUT");
    expect(put).toBeTruthy();
    const body = JSON.parse(String(put!.init?.body));
    expect(body.level).toBe("debug");
    expect(body.targets).toEqual([{ scope: "mcp", level: "debug" }]);
    expect(body.file?.enabled).toBe(true);
    expect(body).not.toHaveProperty("scopes");
  });
});
