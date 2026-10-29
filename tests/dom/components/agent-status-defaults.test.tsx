/**
 * The vendored `AgentStatus` element, asserted at its accessibility boundary.
 *
 * ## What this file proves
 *
 * The element has one caller-supplied slot — `trailing` — and two very different
 * meanings for its contents:
 *
 * - with no `trailing`, the default pause/replay icon is decoration, and it must
 *   stay out of the accessibility tree;
 * - with a `trailing` node, the caller owns that slot and may put a control
 *   there (the recovery notice's dismiss button). Hiding that subtree would
 *   leave a focusable control that assistive technology cannot name.
 *
 * That second case is the S5 guard: the wrapper's `aria-hidden` must be absent
 * when a node is supplied, otherwise the dismiss button is reachable by keyboard
 * but invisible to a screen reader. The default rendering must not change.
 *
 * ## Why the focus/activation cases are shaped this way
 *
 * happy-dom does not synthesize a `click` from Enter/Space key events, so a
 * keyboard-event case would pass or fail on the emulator rather than on the
 * component. What is asserted instead is the platform contract that makes a
 * control keyboard-operable: a native `<button type="button">`, not inside any
 * `aria-hidden="true"` subtree, focusable by `focus()` (i.e. no `tabindex="-1"`),
 * and wired to its handler. The visible focus ring is pinned by its declared
 * utility classes, because happy-dom loads no stylesheet and cannot compute it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  AgentStatus,
  type AgentState,
} from "@web/components/assistant-ui/elements/agent-status.tsx";

const STATES: readonly AgentState[] = ["working", "waiting", "done", "failed"];

interface Mounted {
  readonly root: Root;
  readonly container: HTMLElement;
}

const mounted: Mounted[] = [];

/** Renders children into a fresh container attached to the document. */
function render(children: ReactNode): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(children);
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

/** The trailing slot, asserted to exist. */
function trailingOf(container: HTMLElement): Element {
  const trailing = container.querySelector('[data-slot="agent-status-trailing"]');
  expect(trailing).not.toBeNull();
  return trailing!;
}

/** True when any ancestor of `node` is hidden from assistive technology. */
function hasHiddenAncestor(node: Element): boolean {
  for (let current = node.parentElement; current !== null; current = current.parentElement) {
    if (current.getAttribute("aria-hidden") === "true") return true;
  }
  return false;
}

describe("the default trailing icon is decoration", () => {
  for (const state of STATES) {
    it(`stays hidden from assistive technology in the ${state} state`, () => {
      const { container } = render(<AgentStatus state={state} label="Working…" />);

      const trailing = trailingOf(container);
      expect(trailing.getAttribute("aria-hidden")).toBe("true");
      // The slot still holds its icon: hiding is the only change, not removal.
      expect(trailing.querySelector("svg")).not.toBeNull();
      // And nothing in it can be reached by keyboard or a screen reader.
      expect(trailing.querySelector("button, a, input, [tabindex]")).toBeNull();
    });
  }

  it("keeps the pill itself exposed", () => {
    const { container } = render(<AgentStatus state="working" label="Thinking…" />);

    const pill = container.querySelector('[data-slot="agent-status"]');
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute("aria-hidden")).toBeNull();
    expect(hasHiddenAncestor(pill!)).toBe(false);
  });
});

describe("a caller-supplied trailing node is exposed", () => {
  it("removes aria-hidden from the trailing wrapper", () => {
    const { container } = render(
      <AgentStatus
        state="done"
        label="Session restored"
        trailing={<button type="button" aria-label="Dismiss session notice" />}
      />,
    );

    const trailing = trailingOf(container);
    expect(trailing.hasAttribute("aria-hidden")).toBe(false);
    expect(trailing.getAttribute("aria-hidden")).toBeNull();
  });

  it("keeps the supplied control named, focusable and activatable", () => {
    let clicks = 0;
    const { container } = render(
      <AgentStatus
        state="done"
        label="Session restored"
        trailing={
          <button
            type="button"
            aria-label="Dismiss session notice"
            className="focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              clicks += 1;
            }}
          />
        }
      />,
    );

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-label")).toBe("Dismiss session notice");
    // A native button with an explicit type is keyboard-operable by the
    // platform; the failure this guards is the hidden subtree, not the markup.
    expect(button!.getAttribute("type")).toBe("button");
    expect(hasHiddenAncestor(button!)).toBe(false);

    act(() => {
      button!.focus();
    });
    expect(document.activeElement).toBe(button);
    expect(button!.getAttribute("tabindex")).not.toBe("-1");
    // The visible focus indicator is declared, not left to the browser default.
    expect(button!.className).toContain("focus-visible:ring-2");
    expect(button!.className).toContain("focus-visible:ring-ring");

    act(() => {
      button!.click();
    });
    expect(clicks).toBe(1);
  });
});

describe("the default rendering is unchanged", () => {
  it("renders the state word, label and root slot", () => {
    const { container } = render(<AgentStatus state="waiting" label="Waiting for approval…" />);

    const pill = container.querySelector('[data-slot="agent-status"]')!;
    expect(pill.querySelector(".sr-only")?.textContent).toBe("waiting");
    expect(pill.textContent).toContain("Waiting for approval…");
  });

  it("shows elapsed only while the state is in flight", () => {
    const working = render(<AgentStatus state="working" label="Thinking…" elapsed="4s" />);
    const done = render(<AgentStatus state="done" label="Finished" elapsed="4s" />);

    expect(working.container.textContent).toContain("4s");
    expect(done.container.textContent).not.toContain("4s");
  });

  it("accepts caller classes alongside its own", () => {
    const { container } = render(
      <AgentStatus state="working" label="Thinking…" className="shadow-xs" />,
    );

    const pill = container.querySelector('[data-slot="agent-status"]')!;
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).toContain("shadow-xs");
  });
});
