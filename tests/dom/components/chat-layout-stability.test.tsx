/**
 * Composer layout stability — the STRUCTURAL half (S7a).
 *
 * ## What this file proves, and what it deliberately does not
 *
 * The defect: a transient status pill mounted in the composer folder's normal
 * flow, so showing or hiding it resized the folder and moved the `flex-1`
 * transcript and the composer. The fix reserves a CONSTANT-height row for status
 * presentations only, keeps interactive content at natural height above it, and
 * keeps the connection heart in its own row.
 *
 * This harness runs in happy-dom, which has NO layout engine: `getBoundingClientRect`
 * returns zeros and `scrollTop` is only a stored number. So this file asserts the
 * STRUCTURE that makes stability possible — the row is always mounted, every
 * status presentation is a direct child of it, interactive/below content is
 * outside it, the transcript and composer nodes are never remounted, the pinned
 * height token exists exactly once — and the real pixel geometry (46px one line,
 * 92px wrapped, no overlap/overflow, idle→active→idle rect equality) is asserted
 * in `tests/e2e/virtualizer/status-layout-stability.spec.ts`, where a browser
 * actually lays the page out. The repository already documents this boundary in
 * `tests/dom/virtualizer/virtual-transcript-harness.test.ts`.
 *
 * ## Why the heavy children are mocked
 *
 * The subject is the composer folder's composition. `VirtualizedTranscript`
 * would render every message row and `Composer` pulls the provider/MCP stores;
 * neither can change where the status row sits. They are replaced with markers
 * that preserve the DOM order this file measures.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { REPO_ROOT, repoPath } from "../../helpers/repo-root";

// ── heavy, unrelated children (markers keep the DOM order measurable) ────────

mock.module("@web/components/VirtualizedTranscript.tsx", () => ({
  VirtualizedTranscript: () => <div data-testid="transcript" />,
  useTranscriptOwnsScrollCompensation: () => false,
}));
mock.module("@web/components/ScrollPill.tsx", () => ({ ScrollPill: () => null }));
mock.module("@web/features/chat/history/DirectViewportBridge.tsx", () => ({
  DirectViewportBridge: () => null,
}));
mock.module("@web/components/assistant-ui/elements/thread-boot-skeleton.tsx", () => ({
  ThreadBootSkeleton: () => null,
}));
mock.module("@web/components/Composer.tsx", () => ({
  Composer: () => <div data-testid="composer" />,
}));
mock.module("@web/features/chat/components/WelcomeScreen.tsx", () => ({
  WelcomeScreen: () => null,
}));
mock.module("@web/features/chat/components/WelcomeScopePicker.tsx", () => ({
  WelcomeScopePicker: () => <div data-testid="scope-chip" />,
}));
// The notice reads optional runtime extras; no Code runtime is mounted here, so
// it renders its plain "Session restored" state — which is the pill this file
// needs for the both-present structure.
mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () => null,
}));

// ── the components, imported AFTER the mocks are registered ──────────────────

const { ChatWindow } = await import("@web/components/ChatWindow.tsx");
const { OpenCodeRecoveryNotice } = await import(
  "@web/features/opencode/OpenCodeRecoveryNotice.tsx"
);

/** A running turn: the Direct pill's simplest active state. */
const THINKING: ThreadMessageLike[] = [
  {
    id: "assistant_thinking",
    role: "assistant",
    status: { type: "running" },
    content: [{ type: "reasoning", text: "planning the change", status: { type: "running" } }],
  },
];

/** The same turn one part later: a running tool call. */
const RUNNING_TOOL: ThreadMessageLike[] = [
  {
    id: "assistant_tool",
    role: "assistant",
    status: { type: "running" },
    content: [{ type: "tool-call", toolCallId: "call_1", toolName: "read_file" }],
  },
];

interface SceneProps {
  readonly mode: "chat" | "agent";
  readonly messages: ThreadMessageLike[];
  readonly isRunning: boolean;
  readonly status?: ReactNode;
  readonly interactive?: ReactNode;
  readonly below?: ReactNode;
}

function Scene({ mode, messages, isRunning, status, interactive, below }: SceneProps) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning,
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatWindow
        mode={mode}
        composerExtras={{
          ...(status === undefined ? {} : { status }),
          ...(interactive === undefined ? {} : { interactive }),
          ...(below === undefined ? {} : { below }),
        }}
      />
    </AssistantRuntimeProvider>
  );
}

interface Mounted {
  readonly container: HTMLElement;
  render(next?: Partial<SceneProps>): Promise<void>;
  unmount(): void;
}

const mounted: Mounted[] = [];

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mount(props: Partial<SceneProps> = {}): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  let current: SceneProps = {
    mode: props.mode ?? "chat",
    messages: props.messages ?? [],
    isRunning: props.isRunning ?? false,
    status: props.status,
    interactive: props.interactive,
    below: props.below,
  };
  const render = async (next: Partial<SceneProps> = {}): Promise<void> => {
    current = { ...current, ...next };
    await act(async () => {
      root.render(<Scene {...current} />);
    });
    await settle();
  };
  await act(async () => {
    root.render(<Scene {...current} />);
  });
  await settle();
  const entry: Mounted = {
    container,
    render,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(entry);
  return entry;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) entry.unmount();
});

// ── selectors ────────────────────────────────────────────────────────────────

const ROW = "[data-status-row]";
const PRIMARY = "[data-primary-status]";
const NOTICE = "[data-restoration-notice]";
const INTERACTIVE = "[data-composer-interactive]";
const BELOW = "[data-composer-below]";

function one(container: HTMLElement, selector: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(selector)];
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** True when `a` precedes `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** Every source file under `web/src`, as repo-relative paths. */
function webSourceFiles(): string[] {
  const root = repoPath("web", "src");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

// ── the reserved row exists in every state ───────────────────────────────────

describe("the reserved status row is structural, not conditional", () => {
  for (const mode of ["chat", "agent"] as const) {
    it(`is mounted exactly once and empty while idle in ${mode} mode`, async () => {
      const { container } = await mount({ mode });

      const row = one(container, ROW);
      expect(row.querySelector(PRIMARY)).toBeNull();
      expect(row.querySelector(NOTICE)).toBeNull();
      // The row is a normal-flow flex row: nothing here can overlap the
      // transcript, the forms or the composer.
      expect(row.className).toContain("flex");
      expect(row.className).not.toContain("absolute");
      expect(row.className).not.toContain("fixed");
    });
  }

  it("does not render the Direct pill in agent mode", async () => {
    const { container } = await mount({ mode: "agent", messages: THINKING, isRunning: true });

    expect(container.querySelector(PRIMARY)).toBeNull();
  });
});

describe("the Direct pill is a child of the reserved row", () => {
  it("mounts inside the row, so the row owns its height", async () => {
    const { container } = await mount({ mode: "chat", messages: THINKING, isRunning: true });

    const row = one(container, ROW);
    const pill = one(container, PRIMARY);
    expect(pill.parentElement).toBe(row);
    // The marker rides on the vendored pill itself; a wrapper would be a second
    // flow box inside the row.
    expect(pill.getAttribute("data-slot")).toBe("agent-status");
  });

  it("keeps the same row node across idle → active → idle", async () => {
    const scene = await mount({ mode: "chat" });
    const rowBefore = one(scene.container, ROW);

    await scene.render({ messages: THINKING, isRunning: true });
    const rowActive = one(scene.container, ROW);
    expect(one(scene.container, PRIMARY).parentElement).toBe(rowActive);

    await scene.render({ messages: [], isRunning: false });
    const rowAfter = one(scene.container, ROW);

    expect(rowActive.isSameNode(rowBefore)).toBe(true);
    expect(rowAfter.isSameNode(rowBefore)).toBe(true);
    expect(scene.container.querySelector(PRIMARY)).toBeNull();
  });

  it("keeps the same row and pill across a label change", async () => {
    const scene = await mount({ mode: "chat", messages: THINKING, isRunning: true });
    const rowBefore = one(scene.container, ROW);
    const pillBefore = one(scene.container, PRIMARY);
    expect(pillBefore.textContent).toContain("Thinking…");

    await scene.render({ messages: RUNNING_TOOL, isRunning: true });
    const rowAfter = one(scene.container, ROW);
    const pillAfter = one(scene.container, PRIMARY);

    expect(rowAfter.isSameNode(rowBefore)).toBe(true);
    expect(pillAfter.isSameNode(pillBefore)).toBe(true);
    // One pill, one line: a relabel never adds a second item to the row.
    expect(scene.container.querySelectorAll(PRIMARY)).toHaveLength(1);
  });
});

// ── status presentations are siblings, never overlapping ─────────────────────

describe("the primary and the restoration notice coexist as siblings", () => {
  it("renders both as direct children of the row, primary first", async () => {
    const notice = <OpenCodeRecoveryNotice reusedExistingSession sessionId="ses_layout_test" />;
    const { container } = await mount({
      mode: "chat",
      messages: THINKING,
      isRunning: true,
      status: notice,
    });

    const row = one(container, ROW);
    const pill = one(container, PRIMARY);
    const noticeEl = one(container, NOTICE);

    expect(pill.parentElement).toBe(row);
    expect(noticeEl.parentElement).toBe(row);
    // Sibling flex items: the primary takes the first line, the notice wraps
    // only when there is no room beside it.
    expect(precedes(pill, noticeEl)).toBe(true);
    expect(row.querySelectorAll(PRIMARY)).toHaveLength(1);
    expect(row.querySelectorAll(NOTICE)).toHaveLength(1);
  });

  it("keeps the notice's dismiss button reachable, not hidden", async () => {
    const notice = <OpenCodeRecoveryNotice reusedExistingSession sessionId="ses_layout_test" />;
    const { container } = await mount({ mode: "agent", status: notice });

    const noticeEl = one(container, NOTICE);
    const dismiss = noticeEl.querySelector<HTMLElement>(
      'button[aria-label="Dismiss session notice"]',
    );
    expect(dismiss).not.toBeNull();
    expect(dismiss!.tagName).toBe("BUTTON");
    // The vendored trailing wrapper is only aria-hidden for its DEFAULT
    // decorative icon; a caller-supplied control must stay exposed.
    for (let node: Element | null = dismiss; node !== null; node = node.parentElement) {
      expect(node.getAttribute("aria-hidden")).not.toBe("true");
    }
    // The full sentence is announced even though the pill's label is short.
    expect(noticeEl.querySelector('[role="status"]')?.textContent).toContain(
      "Previous session restored",
    );
  });

  it("keeps the full label in the DOM when the visible label truncates", async () => {
    const { container } = await mount({ mode: "chat", messages: THINKING, isRunning: true });

    const pill = one(container, PRIMARY);
    // `truncate` is visual only: the text content — and therefore the
    // accessible name — stays complete.
    const label = [...pill.querySelectorAll("span")].find((span) =>
      span.className.includes("truncate"),
    );
    expect(label).not.toBeUndefined();
    expect(label!.textContent).toBe("Thinking…");
  });
});

// ── interactive and below content live OUTSIDE the row ──────────────────────

describe("interactive and below content stay outside the reserved row", () => {
  it("renders the interactive form above the row, unconstrained", async () => {
    const interactive = (
      <form data-testid="form">
        <button type="submit" data-testid="form-submit">
          Answer
        </button>
      </form>
    );
    const { container } = await mount({ mode: "agent", interactive });

    const interactiveRow = one(container, INTERACTIVE);
    const row = one(container, ROW);
    const submit = container.querySelector<HTMLElement>('[data-testid="form-submit"]');

    expect(submit).not.toBeNull();
    // Outside the reserved row: a multi-line form is never clipped to the pill's
    // height, and its own height is intentional content height.
    expect(row.contains(submit)).toBe(false);
    expect(interactiveRow.contains(submit)).toBe(true);
    expect(precedes(interactiveRow, row)).toBe(true);
  });

  it("renders the connection heart in its own row after the composer", async () => {
    const below = (
      <button type="button" data-testid="heart">
        Connected
      </button>
    );
    const { container } = await mount({ mode: "agent", below });

    const belowRow = one(container, BELOW);
    const row = one(container, ROW);
    const composer = container.querySelector('[data-testid="composer"]');

    expect(belowRow.contains(container.querySelector('[data-testid="heart"]'))).toBe(true);
    expect(row.querySelector('[data-testid="heart"]')).toBeNull();
    expect(composer).not.toBeNull();
    // Transcript → row → composer → below row.
    expect(precedes(row, composer!)).toBe(true);
    expect(precedes(composer!, belowRow)).toBe(true);
  });
});

// ── the transcript/composer nodes are never remounted by status ─────────────

describe("status changes never remount the surrounding surface", () => {
  it("reuses the transcript, composer and row nodes across the whole cycle", async () => {
    const scene = await mount({ mode: "agent", messages: [], isRunning: false });
    const transcript = scene.container.querySelector<HTMLElement>('[data-testid="transcript"]');
    const composer = scene.container.querySelector<HTMLElement>('[data-testid="composer"]');
    expect(transcript).not.toBeNull();
    expect(composer).not.toBeNull();
    // A scroll container's offset is a property of that node; a remount would
    // reset it. (happy-dom stores the value, so this asserts identity, not real
    // scroll geometry — the E2E spec measures that.)
    transcript!.scrollTop = 120;

    await scene.render({
      messages: THINKING,
      isRunning: true,
      status: <span data-primary-status>Working…</span>,
    });
    await scene.render({ messages: [], isRunning: false });

    expect(
      scene.container.querySelector('[data-testid="transcript"]')!.isSameNode(transcript!),
    ).toBe(true);
    expect(scene.container.querySelector('[data-testid="composer"]')!.isSameNode(composer!)).toBe(
      true,
    );
    expect(
      scene.container.querySelector<HTMLElement>('[data-testid="transcript"]')!.scrollTop,
    ).toBe(120);
  });
});

// ── the composer is an overlay above the transcript, not a sibling below it ──

/**
 * The floating composer's structure.
 *
 * The pixels are measured in `composer-overlay-follow.spec.ts` (the scrollport
 * reaches the dock's bottom edge; the transcript's end sits at the dock's top
 * edge; an append while pinned stays pinned). What can be asserted WITHOUT a
 * layout engine is the arrangement that makes those pixels possible:
 *
 * - the measured footer is OUT OF FLOW and bottom-pinned, so it cannot take
 *   height away from the `flex-1` transcript the way the old in-flow column did;
 * - the row's folder is still one node, so the geometry spec's
 *   `row.parentElement` measurement still names the column that owns the row;
 * - the band does not intercept pointers, because it spans the full width over
 *   the transcript.
 */
describe("the composer dock is an out-of-flow overlay around the column", () => {
  const FOOTER = "[data-composer-footer]";
  const FADE = "[data-composer-fade]";
  const DOCK = "[data-composer-dock]";

  it("mounts one measured footer, out of flow and pinned to the bottom", async () => {
    const { container } = await mount({ mode: "chat" });

    const footer = one(container, FOOTER);
    expect(footer.className).toContain("absolute");
    expect(footer.className).toContain("bottom-0");
    // `sticky` would stay in flow and `fixed` would escape the chat column;
    // either would change what the measurement means.
    expect(footer.className).not.toContain("sticky");
    expect(footer.className).not.toContain("fixed");
  });

  it("keeps the dock as the row's folder and the composer's container", async () => {
    const { container } = await mount({ mode: "chat" });

    const dock = one(container, DOCK);
    expect(one(container, ROW).parentElement).toBe(dock);
    expect(dock.querySelector('[data-testid="composer"]')).not.toBeNull();
  });

  it("layers the fade band above the dock without swallowing its clicks", async () => {
    const { container } = await mount({ mode: "chat" });

    const footer = one(container, FOOTER);
    const fade = one(container, FADE);
    const dock = one(container, DOCK);
    // The band covers the transcript's last line while it scrolls under the
    // dock; transparent to pointers so a click reaches the transcript.
    expect(fade.parentElement).toBe(footer);
    expect(fade.className).toContain("pointer-events-none");
    expect(footer.className).toContain("pointer-events-none");
    expect(dock.className).toContain("pointer-events-auto");
    expect(precedes(fade, dock)).toBe(true);
  });
});

// ── the pinned height is one value, in one place ────────────────────────────

describe("the reserved-row height has a single source", () => {
  it("declares the token exactly once and never hardcodes the pixel value in components", () => {
    const declarations: string[] = [];
    for (const file of webSourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/--status-reserved-height\s*:\s*([^;]+);/g)) {
        declarations.push(`${path.relative(REPO_ROOT, file).replaceAll("\\", "/")}: ${match[1]}`);
      }
    }

    expect(declarations).toEqual([`web/src/styles/globals.css: 46px`]);
  });

  it("consumes the token in the row and nowhere else", async () => {
    const chatWindow = readFileSync(repoPath("web", "src", "components", "ChatWindow.tsx"), "utf8");
    expect(chatWindow.match(/var\(--status-reserved-height\)/g)?.length).toBe(1);
    // The row carries its own 8px spacing INSIDE the reservation, and wraps so
    // the one line is 38+8=46px and two lines are 38+8+38+8=92px — every pill
    // is 38px because `AgentStatus` always renders a size-6 trailing wrapper.
    for (const cls of ["flex-wrap", "gap-2", "pb-2", "min-w-0", "overflow-x-clip"]) {
      expect(chatWindow).toContain(cls);
    }

    const { container } = await mount({ mode: "chat" });
    const row = one(container, ROW);
    expect(row.className).toContain("min-h-[var(--status-reserved-height)]");
  });

  it("keeps ChatWindow engine-neutral: no OpenCode import", async () => {
    const chatWindow = readFileSync(repoPath("web", "src", "components", "ChatWindow.tsx"), "utf8");
    // The invariant is the DEPENDENCY, not the word: ChatWindow's comments
    // explain the boundary by naming `features/opencode/`, and matching that
    // text would fail a correct file. Both import forms are checked.
    expect(chatWindow).not.toMatch(/from\s+["'][^"']*features\/opencode/);
    expect(chatWindow).not.toMatch(/import\(\s*["'][^"']*features\/opencode/);
  });
});
