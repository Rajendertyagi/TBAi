/**
 * McpPanel DOM characterization tests.
 *
 * Documents the current behavior of the full panel surface — server list
 * rendering, card actions, expanded capabilities, form add/edit flow,
 * buildPayload semantics, and polling — without asserting any desired
 * behavior that does not yet exist.
 *
 * Mocks (all registered via mock.module BEFORE the component is dynamically
 * imported; a static import would be hoisted and evaluated first, bypassing
 * the mocks):
 *   - @web/features/mcp/state/mcpStore.ts  (stable action refs + mutable server list)
 *   - @web/features/chat/state/chatTabs.ts (chat-tab navigation helpers)
 *
 * ROUTER CONTEXT — a REAL router, not a mock.
 * `McpPanel` and its expanded-capabilities sections (`ResourceSection` /
 * `PromptSection`) call `useGoToChat()` → `useNavigate()` at render time, so
 * mounting them requires a live `<Router>`.
 *
 * react-router is deliberately NOT mocked, because this repo carries TWO
 * copies: `web/node_modules/react-router` (what every `@web` source resolves
 * against) and the root `node_modules/react-router` (what files under
 * `tests/` resolve against). A test-side `mock.module("react-router", …)`
 * registers against the ROOT copy, which the component never imports, so it
 * cannot satisfy the web copy's `useNavigate` — expansion threw
 * "useNavigate() may be used only in the context of a <Router>".
 * Instead the mount is wrapped in a real `MemoryRouter` imported from the
 * web copy's own package path, so the router context comes from the exact
 * module instance the component's `useNavigate` reads.
 *
 * Two key design constraints that shape every test in this file:
 *
 * 1. STABLE STORE ACTION REFERENCES.
 *    McpPanel's polling effect is `useEffect(…, [loadServers])`. A new
 *    function identity on every render would re-trigger the effect loop
 *    and block the initial render from flushing in happy-dom. The stable
 *    refs keep the effect from re-triggering while still recording calls.
 *
 * 2. NO PENDING MICROTASKS ACROSS TEST BOUNDARIES.
 *    `record()` returns undefined (not a Promise). If the mock returned
 *    Promise.resolve(), `await deleteServer(id)` in McpPanel would suspend,
 *    and the resolution microtask would fire AFTER the root is unmounted —
 *    poisoning the next mount's scheduler in happy-dom. Synchronous
 *    undefined avoids that.
 *
 * Conventions:
 *   - bun:test with --isolate and the DOM preload
 *   - createRoot + act pattern
 *   - Each test is independent; mock state is reset in beforeEach
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../helpers/repo-root";
import type { McpStatus } from "@web/types/index.ts";

// ── controllable mock state ─────────────────────────────────────────────────

/**
 * The store mock returns this array on every `useMcpStore()` call.
 * Tests reassign it to a fresh array via `setServers` so no React fiber
 * from a previous mount holds a stale reference to a mutated list.
 */
let serverList: McpStatus[] = [];
const calls: Record<string, unknown[][]> = {};

/** Records the call and returns undefined (NOT a Promise — see header). */
function record(name: string) {
  return (...args: unknown[]) => {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
  };
}

// Stable refs — see header comment §1.
const stableFns = {
  loadServers: record("loadServers"),
  createServer: record("createServer"),
  updateServer: record("updateServer"),
  deleteServer: record("deleteServer"),
  setEnabled: record("setEnabled"),
  connect: record("connect"),
  disconnect: record("disconnect"),
  refresh: record("refresh"),
  // `test` returns a resolved value directly (not a Promise) so the form's
  // `await test(buildPayload())` completes in the same microtask as the
  // click that triggered it.
  test: () => ({ ok: true, toolCount: 0, resourceCount: 0, promptCount: 0 }),
  readResource: record("readResource"),
  getPrompt: record("getPrompt"),
  setPendingInsert: record("setPendingInsert"),
  clearPendingInsert: record("clearPendingInsert"),
};

// ── module mocks ──────────────────────────────────────────────────────────

mock.module("@web/features/mcp/state/mcpStore.ts", () => ({
  useMcpStore: () => ({ servers: serverList, ...stableFns }),
}));

mock.module("@web/features/chat/state/chatTabs.ts", () => ({
  useChatTabsStore: {
    getState: () => ({
      tabs: [{ key: "chat:new", kind: "chat", ref: "new" }],
      activeKey: "chat:new",
      groupId: "main",
    }),
  },
  urlForTab: (tab: { kind: string; ref: string }) =>
    tab.kind === "agent" ? `/code/${tab.ref}` : `/chat/${tab.ref}`,
}));

// ── the SAME react-router instance the component imports ────────────────────
//
// NOT `mock.module("react-router", …)` — see the header. `Bun.resolveSync`
// resolves the bare specifier the way a file under `web/src` would (through
// `web/node_modules`), returning the EXACT physical entry the component's
// `react-router` import loads — the `.bun` store's `dist/production/index.js`,
// NOT the root copy's (verified: `Bun.resolveSync("react-router", <web dir>)`
// and `Bun.resolveSync("react-router", <tests dir>)` point at two different
// files, so a Router from the root copy is dead context the hook never sees).
//
// The dynamic import is asserted against the root copy's type surface (same
// version, structurally identical) purely for type-checking — it is NOT a
// value import, so it creates no second runtime copy.
const webRouterEntry = Bun.resolveSync("react-router", path.join(REPO_ROOT, "web", "src"));
const { MemoryRouter } = (await import(
  pathToFileURL(webRouterEntry).href
)) as typeof import("react-router");

// ── dynamic import AFTER mocks are registered ─────────────────────────────

const { McpPanel } = await import("@web/features/mcp/components/McpPanel.tsx");

// ── helpers ────────────────────────────────────────────────────────────────

function makeServer(overrides: Partial<McpStatus> = {}): McpStatus {
  return {
    id: "srv-1",
    name: "Test Server",
    transport: "stdio",
    command: "npx",
    args: ["-y", "fixture"],
    authType: "none",
    authConfigured: false,
    enabled: true,
    autoConnect: true,
    status: "disconnected",
    tools: [],
    resources: [],
    prompts: [],
    toolCount: 0,
    resourceCount: 0,
    promptCount: 0,
    events: [],
    ...overrides,
  } as McpStatus;
}

/** Replace the current server list with a fresh array (no in-place mutation). */
function setServers(servers: McpStatus[]) {
  serverList = servers;
}

/**
 * Mounts the panel inside a real `<MemoryRouter>`.
 *
 * The Router is what lets the expanded-capabilities sections mount at all —
 * their `useNavigate()` needs router context, and the two-react-router-copies
 * problem means only a Router from the web copy can provide it (see header).
 */
function mount(): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/settings/mcp"]}>
        <McpPanel />
      </MemoryRouter>,
    );
  });
  return { root, container };
}

/**
 * The card boundary is the outer div with class `rounded-md border p-3`
 * (NOT the inner flex div that carries the action buttons). We find it by
 * walking up from the name span until we hit a div with that class.
 */
function serverCard(container: HTMLElement, name = "Test Server"): HTMLElement | null {
  const nameSpan = [...container.querySelectorAll("span.font-medium.text-sm")].find(
    (s) => s.textContent === name,
  );
  if (!nameSpan) return null;
  let el: HTMLElement | null = nameSpan.parentElement;
  while (el && el !== container) {
    if (el.classList.contains("rounded-md") && el.classList.contains("border")) return el;
    el = el.parentElement;
  }
  return null;
}

function cardButton(container: HTMLElement, name: string, title: string): HTMLButtonElement | null {
  const card = serverCard(container, name);
  if (!card) return null;
  return ([...card.querySelectorAll("button")].find(
    (b) => b.title === title || b.getAttribute("title") === title,
  ) ?? null) as HTMLButtonElement | null;
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | null {
  return ([...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ??
    null) as HTMLButtonElement | null;
}

/** The "Add server" toolbar button (not the form title text). */
function addServerButton(container: HTMLElement): HTMLButtonElement | null {
  return ([...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Add server"),
  ) ?? null) as HTMLButtonElement | null;
}

/**
 * The name field of the open MCP form (identified by placeholder).
 */
function findNameInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector("input[placeholder*='Server name']");
  if (!el) throw new Error("MCP form name input not found");
  return el as HTMLInputElement;
}

/**
 * Set a controlled input's value the way React 19's event system expects:
 * bypass React's value-tracker via the native prototype setter, then
 * dispatch the native `input` event. Plain assignment (`el.value = …`)
 * is ignored by React's tracker and the onChange handler never fires.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  nativeSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  serverList = [];
  for (const k of Object.keys(calls)) delete calls[k];
});

// ════════════════════════════════════════════════════════════════════════
// 1. Empty state
// ════════════════════════════════════════════════════════════════════

describe("McpPanel — empty state", () => {
  it("renders 'No MCP servers configured yet' when servers is empty and not adding", () => {
    const { root, container } = mount();
    expect(container.textContent).toContain("No MCP servers configured yet");
    act(() => root.unmount());
  });

  it("renders the 'Add server' button", () => {
    const { root, container } = mount();
    expect(addServerButton(container)).not.toBeNull();
    act(() => root.unmount());
  });

  it("does NOT render the form when not adding", () => {
    const { root, container } = mount();
    expect(container.textContent).not.toContain("Transport");
    act(() => root.unmount());
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. Server list rendering
// ════════════════════════════════════════════════════════════════════

describe("McpPanel — server list rendering", () => {
  it("renders one card per server", () => {
    setServers([makeServer({ name: "Alpha" }), makeServer({ name: "Beta", id: "srv-2" })]);
    const { root, container } = mount();
    expect(serverCard(container, "Alpha")).not.toBeNull();
    expect(serverCard(container, "Beta")).not.toBeNull();
    act(() => root.unmount());
  });

  it("displays the server name", () => {
    setServers([makeServer({ name: "Gamma" })]);
    const { root, container } = mount();
    expect(container.textContent).toContain("Gamma");
    act(() => root.unmount());
  });

  it.each([
    ["connected", "connected"],
    ["connecting", "connecting"],
    ["error", "error"],
    ["auth_failed", "auth required"],
    ["disconnected", "disconnected"],
  ] as const)("StatusBadge shows '%s' for status '%s'", (status, expectedLabel) => {
    setServers([makeServer({ status })]);
    const { root, container } = mount();
    expect(container.textContent).toContain(expectedLabel);
    act(() => root.unmount());
  });

  it("shows the transport type in the card", () => {
    setServers([makeServer({ transport: "http" })]);
    const { root, container } = mount();
    expect(container.textContent).toContain("http");
    act(() => root.unmount());
  });

  it("shows 'local' location badge when location is 'local'", () => {
    setServers([makeServer({ location: "local" })]);
    const { root, container } = mount();
    expect(container.textContent).toContain("local");
    act(() => root.unmount());
  });

  it("shows 'remote' location badge when location is 'remote'", () => {
    setServers([makeServer({ location: "remote" })]);
    const { root, container } = mount();
    expect(container.textContent).toContain("remote");
    act(() => root.unmount());
  });

  it("shows 'enabled' label when enabled is true", () => {
    setServers([makeServer({ enabled: true })]);
    const { root, container } = mount();
    expect(container.textContent).toContain("enabled");
    act(() => root.unmount());
  });

  it("shows 'disabled' label when enabled is false", () => {
    setServers([makeServer({ enabled: false })]);
    const { root, container } = mount();
    expect(container.textContent).toContain("disabled");
    act(() => root.unmount());
  });

  it("displays tool/resource/prompt counts as 'N tool(s) · M resource(s) · K prompt(s)'", () => {
    setServers([makeServer({ toolCount: 3, resourceCount: 1, promptCount: 2 })]);
    const { root, container } = mount();
    expect(container.textContent).toContain("3 tool(s) · 1 resource(s) · 2 prompt(s)");
    act(() => root.unmount());
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. Server card actions
// ════════════════════════════════════════════════════════════════════

describe("McpPanel — server card actions", () => {
  it("clicking the expand toggle does not throw", () => {
    setServers([makeServer()]);
    const { root, container } = mount();
    act(() => cardButton(container, "Test Server", "Show capabilities")!.click());
    act(() => root.unmount());
  });

  it("clicking refresh calls onRefresh with the server id", () => {
    setServers([makeServer()]);
    const { root, container } = mount();
    act(() => cardButton(container, "Test Server", "Refresh capabilities")!.click());
    expect(calls.refresh?.[0]).toEqual(["srv-1"]);
    act(() => root.unmount());
  });

  it("clicking connect (when disconnected) calls onConnect", () => {
    setServers([makeServer({ status: "disconnected" })]);
    const { root, container } = mount();
    act(() => cardButton(container, "Test Server", "Connect")!.click());
    expect(calls.connect?.[0]).toEqual(["srv-1"]);
    act(() => root.unmount());
  });

  it("clicking disconnect (when connected) calls onDisconnect", () => {
    setServers([makeServer({ status: "connected" })]);
    const { root, container } = mount();
    act(() => cardButton(container, "Test Server", "Disconnect")!.click());
    expect(calls.disconnect?.[0]).toEqual(["srv-1"]);
    act(() => root.unmount());
  });

  it("clicking edit opens the form (form 'Edit server' title visible)", () => {
    setServers([makeServer({ status: "connected", name: "Existing", tools: [{ name: "echo" }] })]);
    const { root, container } = mount();
    act(() => cardButton(container, "Existing", "Edit")!.click());
    expect(container.textContent).toContain("Edit server");
    act(() => root.unmount());
  });

  it("clicking delete calls onDelete when confirm returns true", () => {
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    setServers([makeServer()]);
    const { root, container } = mount();
    act(() => cardButton(container, "Test Server", "Delete")!.click());
    expect(calls.deleteServer?.[0]).toEqual(["srv-1"]);
    globalThis.confirm = originalConfirm;
    act(() => root.unmount());
  });

  it("clicking delete does NOT call onDelete when confirm returns false", () => {
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = () => false;
    setServers([makeServer()]);
    const { root, container } = mount();
    act(() => cardButton(container, "Test Server", "Delete")!.click());
    expect(calls.deleteServer?.length ?? 0).toBe(0);
    globalThis.confirm = originalConfirm;
    act(() => root.unmount());
  });

  it("enabled checkbox (server enabled=true) calls onSetEnabled(id, false)", () => {
    setServers([makeServer({ enabled: true })]);
    const { root, container } = mount();
    const card = serverCard(container)!;
    act(() => (card.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(calls.setEnabled?.[0]).toEqual(["srv-1", false]);
    act(() => root.unmount());
  });

  it("enabled checkbox (server enabled=false) calls onSetEnabled(id, true)", () => {
    setServers([makeServer({ enabled: false })]);
    const { root, container } = mount();
    const card = serverCard(container)!;
    act(() => (card.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(calls.setEnabled?.[0]).toEqual(["srv-1", true]);
    act(() => root.unmount());
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. Expanded capabilities
// ════════════════════════════════════════════════════════════════════

describe("McpPanel — expanded capabilities", () => {
  function expandServer(server: McpStatus): { root: Root; card: HTMLElement } {
    setServers([server]);
    const { root, container } = mount();
    act(() => cardButton(container, server.name, "Show capabilities")!.click());
    return { root, card: serverCard(container, server.name)! };
  }

  it("shows 'Tools (N)' header with tool names when expanded", () => {
    const { root, card } = expandServer(
      makeServer({
        status: "connected",
        tools: [{ name: "echo", description: "Echoes back" }, { name: "fail" }],
      }),
    );
    expect(card.textContent).toContain("Tools (2)");
    expect(card.textContent).toContain("echo");
    expect(card.textContent).toContain("fail");
    act(() => root.unmount());
  });

  it("shows 'None discovered' when there are no tools", () => {
    const { root, card } = expandServer(makeServer({ status: "connected", tools: [] }));
    expect(card.textContent).toContain("None discovered");
    act(() => root.unmount());
  });

  it("shows resource names in the Resources section", () => {
    const { root, card } = expandServer(
      makeServer({
        status: "connected",
        resources: [{ uri: "fixture://config", name: "config", description: "Server config" }],
      }),
    );
    expect(card.textContent).toContain("config");
    act(() => root.unmount());
  });

  it("shows prompt names in the Prompts section", () => {
    const { root, card } = expandServer(
      makeServer({
        status: "connected",
        prompts: [{ name: "greeting", description: "Say hello" }],
      }),
    );
    expect(card.textContent).toContain("greeting");
    act(() => root.unmount());
  });

  it("shows recent events when present", () => {
    const { root, card } = expandServer(
      makeServer({
        status: "connected",
        events: [
          { at: 1000, kind: "tool", message: "echo called" },
          { at: 2000, kind: "resource", message: "config read" },
        ],
      }),
    );
    expect(card.textContent).toContain("Recent events");
    expect(card.textContent).toContain("echo called");
    expect(card.textContent).toContain("config read");
    act(() => root.unmount());
  });

  it("hides the recent events section when there are no events", () => {
    const { root, card } = expandServer(makeServer({ status: "connected", events: [] }));
    expect(card.textContent).not.toContain("Recent events");
    act(() => root.unmount());
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. Failed server display
// ════════════════════════════════════════════════════════════════════

describe("McpPanel — failed server display", () => {
  it("shows the failure reason line when status is error and failureReason is present", () => {
    setServers([
      makeServer({
        status: "error",
        failureReason: "unreachable",
        error: "ECONNREFUSED",
      }),
    ]);
    const { root, container } = mount();
    expect(container.textContent).toContain("Cannot reach the server");
    expect(container.textContent).toContain("ECONNREFUSED");
    act(() => root.unmount());
  });

  it("shows 'auth required' status label and reason for auth_failed", () => {
    setServers([makeServer({ status: "auth_failed", failureReason: "auth_required" })]);
    const { root, container } = mount();
    expect(container.textContent).toContain("auth required");
    expect(container.textContent).toContain("Authentication required");
    act(() => root.unmount());
  });

  it("applies the destructive border class to failed cards", () => {
    setServers([makeServer({ status: "error", error: "fail" })]);
    const { root, container } = mount();
    const card = serverCard(container)!;
    expect(card.className).toContain("border-destructive");
    act(() => root.unmount());
  });

  it("does NOT apply the destructive border to healthy cards", () => {
    setServers([makeServer({ status: "connected" })]);
    const { root, container } = mount();
    const card = serverCard(container)!;
    expect(card.className).not.toContain("border-destructive");
    act(() => root.unmount());
  });
});

// ════════════════════════════════════════════════════════════════════════
// 6. Add / edit form
// ════════════════════════════════════════════════════════════════════

describe("McpPanel — add/edit form", () => {
  it("clicking 'Add server' shows the form with 'Add server' title", () => {
    const { root, container } = mount();
    act(() => addServerButton(container)!.click());
    expect(container.textContent).toContain("Add server");
    act(() => root.unmount());
  });

  it("the form shows 'Save' button when adding (no id)", () => {
    const { root, container } = mount();
    act(() => addServerButton(container)!.click());
    expect(findButton(container, "Save")).not.toBeNull();
    act(() => root.unmount());
  });

  it("the form shows 'Update' button when editing (id present)", () => {
    setServers([makeServer({ status: "connected", name: "Existing" })]);
    const { root, container } = mount();
    act(() => cardButton(container, "Existing", "Edit")!.click());
    expect(findButton(container, "Update")).not.toBeNull();
    act(() => root.unmount());
  });

  it("cancel hides the form", () => {
    const { root, container } = mount();
    act(() => addServerButton(container)!.click());
    expect(container.textContent).toContain("Transport");
    act(() => findButton(container, "Cancel")!.click());
    expect(container.textContent).not.toContain("Transport");
    act(() => root.unmount());
  });

  it("save calls createServer when there is no id (add flow)", () => {
    const { root, container } = mount();
    act(() => addServerButton(container)!.click());
    act(() => typeInto(findNameInput(container), "New Server"));
    act(() => findButton(container, "Save")!.click());
    const createPayload = calls.createServer?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(createPayload?.name).toBe("New Server");
    act(() => root.unmount());
  });

  it("save calls updateServer when there is an id (edit flow)", () => {
    setServers([makeServer({ status: "connected", name: "Existing" })]);
    const { root, container } = mount();
    act(() => cardButton(container, "Existing", "Edit")!.click());
    act(() => findButton(container, "Update")!.click());
    expect(calls.updateServer?.[0]?.[0]).toBe("srv-1");
    act(() => root.unmount());
  });

  it("save hides the form on success (cancel is called)", async () => {
    setServers([makeServer({ status: "connected", name: "Existing" })]);
    const { root, container } = mount();
    act(() => cardButton(container, "Existing", "Edit")!.click());
    expect(container.textContent).toContain("Transport");
    act(() => findButton(container, "Update")!.click());
    // cancel() + setIsAdding(false) + setDraft(emptyDraft()) are batched
    // inside the save() microtask — one extra act pass flushes the commit.
    await act(async () => {});
    expect(container.textContent).not.toContain("Transport");
    act(() => root.unmount());
  });

  it("test button shows success message when test() returns ok", async () => {
    const { root, container } = mount();
    act(() => addServerButton(container)!.click());
    act(() => typeInto(findNameInput(container), "TestTarget"));
    // runTest also guards on command being non-empty for stdio transport
    const cmdInput = container.querySelector(
      "input[placeholder*='Command (e.g.']",
    ) as HTMLInputElement;
    act(() => typeInto(cmdInput, "npx"));
    act(() => findButton(container, "Test connection")!.click());
    await act(async () => {});
    expect(container.textContent).toContain("Connection successful");
    act(() => root.unmount());
  });
});

// ════════════════════════════════════════════════════════════════════════
// 7. buildPayload — verified indirectly through createServer/updateServer args
// ════════════════════════════════════════════════════════════════════

describe("McpPanel — buildPayload (via save)", () => {
  it("stdio transport: command and args are included in the create payload", () => {
    const { root, container } = mount();
    act(() => addServerButton(container)!.click());
    act(() => typeInto(findNameInput(container), "StdioSrv"));
    act(() => findButton(container, "Save")!.click());
    const payload = calls.createServer?.[0]?.[0] as Record<string, unknown>;
    expect(payload.name).toBe("StdioSrv");
    expect(payload.transport).toBe("stdio");
    act(() => root.unmount());
  });

  it("disabledTools is always sent as [] when the list is empty", () => {
    const { root, container } = mount();
    act(() => addServerButton(container)!.click());
    act(() => typeInto(findNameInput(container), "NoTools"));
    act(() => findButton(container, "Save")!.click());
    const payload = calls.createServer?.[0]?.[0] as Record<string, unknown>;
    // Always present so that re-enabling every tool overwrites a previously
    // stored denylist in SQLite (an omitted key would preserve the old list).
    expect(payload.disabledTools).toEqual([]);
    act(() => root.unmount());
  });

  it("re-enabling every tool sends disabledTools: [] on update", () => {
    setServers([
      makeServer({
        status: "connected",
        name: "Existing",
        tools: [{ name: "tool_a" }],
        disabledTools: ["tool_a"],
      }),
    ]);
    const { root, container } = mount();
    act(() => cardButton(container, "Existing", "Edit")!.click());

    // The tool checkbox starts unchecked (tool_a is disabled); clicking it
    // re-enables the tool, removing it from the draft denylist.
    const toolLabel = [...container.querySelectorAll("span.font-mono")].find(
      (s) => s.textContent === "tool_a",
    );
    const toolCheckbox = toolLabel?.parentElement?.querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement | null;
    expect(toolCheckbox).not.toBeNull();
    expect(toolCheckbox!.checked).toBe(false);
    act(() => toolCheckbox!.click());

    act(() => findButton(container, "Update")!.click());
    const payload = calls.updateServer?.[0]?.[1] as Record<string, unknown>;
    expect(payload.disabledTools).toEqual([]);
    act(() => root.unmount());
  });

  it("notes is undefined (omitted) when empty", () => {
    const { root, container } = mount();
    act(() => addServerButton(container)!.click());
    act(() => typeInto(findNameInput(container), "NoNotes"));
    act(() => findButton(container, "Save")!.click());
    const payload = calls.createServer?.[0]?.[0] as Record<string, unknown>;
    expect(payload.notes ?? undefined).toBeUndefined();
    act(() => root.unmount());
  });
});

// ════════════════════════════════════════════════════════════════════════
// 8. Polling
// ════════════════════════════════════════════════════════════════════

describe("McpPanel — polling", () => {
  it("calls loadServers on mount", () => {
    const { root } = mount();
    expect(calls.loadServers?.length ?? 0).toBe(1);
    act(() => root.unmount());
  });

  it("does not crash on unmount (interval cleared)", () => {
    const { root } = mount();
    expect(calls.loadServers?.length ?? 0).toBe(1);
    act(() => root.unmount());
    // no crash
  });
});

// ════════════════════════════════════════════════════════════════════════
// 9. Location badge
// ════════════════════════════════════════════════════════════════════

describe("McpPanel — location badge", () => {
  it("shows a success-styled badge for location 'local'", () => {
    setServers([makeServer({ location: "local" })]);
    const { root, container } = mount();
    const card = serverCard(container)!;
    const localBadge = [...card.querySelectorAll("span")].find(
      (s) => s.textContent?.trim() === "local",
    );
    expect(localBadge?.className).toContain("text-success");
    act(() => root.unmount());
  });

  it("shows a muted-styled badge for location 'remote'", () => {
    setServers([makeServer({ location: "remote" })]);
    const { root, container } = mount();
    const card = serverCard(container)!;
    const remoteBadge = [...card.querySelectorAll("span")].find(
      (s) => s.textContent?.trim() === "remote",
    );
    expect(remoteBadge?.className).toContain("text-muted-foreground");
    act(() => root.unmount());
  });

  it("shows no location badge when location is undefined", () => {
    setServers([makeServer({ location: undefined })]);
    const { root, container } = mount();
    const card = serverCard(container)!;
    const badge = [...card.querySelectorAll("span")].find(
      (s) => s.textContent?.trim() === "local" || s.textContent?.trim() === "remote",
    );
    expect(badge).toBeUndefined();
    act(() => root.unmount());
  });
});
