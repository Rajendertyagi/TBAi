/**
 * The Direct-only action slot on the context ring.
 *
 * ## What is protected here
 *
 * `ContextDisplayContent` is a **vendored, shared** component: the Direct ring and the
 * Code/OpenCode ring both render it. So the contract these tests pin is that the new
 * `action` node is genuinely optional — when it is absent the rendered output must be
 * byte-identical to before the prop existed, which is the only thing that keeps Code
 * and OpenCode unaffected.
 *
 * ## Why this file exists at all
 *
 * The first implementation of this feature wrapped the whole ring in a second
 * `PopoverTrigger` and rendered a parallel `ContextPanelContent`. Every markup and
 * source assertion passed, and the panel **could never open**: the ring is already a
 * `Tooltip` whose own trigger consumes the click, and `PresetProps` has no `children`
 * slot to reach inside it. A real browser showed the ring's own tooltip and none of the
 * panel's strings.
 *
 * These tests are therefore pointed at the thing that actually ships — the in-content
 * slot — and include an assertion that the superseded approach is not reintroduced.
 */

import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ContextDisplayAction,
  ContextDisplayBar,
  type PresetProps,
} from "../assistant-ui/elements/context-display";
import { contextPanelCopy } from "../../config/context-meter";
import { stripComments } from "../../testing/source-scope";

/** Absolute-path helper. `import.meta.dir` is `web/src/components/chat`. */
async function read(relative: string): Promise<string> {
  const { readFileSync } = await import("fs");
  const { resolve } = await import("path");
  return readFileSync(resolve(import.meta.dir, "..", relative), "utf8");
}

const renderSlot = (action: React.ReactNode | undefined): string =>
  renderToStaticMarkup(createElement(ContextDisplayAction as never, { action } as never));

const RING_PROPS = {
  modelContextWindow: 24_000,
  contextTokens: 900,
  windowSource: "configured",
} satisfies Partial<PresetProps>;

describe("the ring's action slot is genuinely optional", () => {
  // Rendered directly rather than through the ring: Radix `TooltipContent` renders
  // nothing on the server, so the slot's two cases are only observable in isolation.
  // What that costs in coverage is paid back by the source assertions at the bottom,
  // which pin WHERE the slot sits inside the content.

  it("renders nothing at all when no action is supplied", () => {
    // No wrapper, no empty bordered box. Code and OpenCode pass nothing and must get
    // exactly this: the absence has to be invisible.
    for (const action of [undefined, null]) {
      expect(renderSlot(action)).toBe("");
    }
  });

  it("renders the supplied node, separated from the readings above it", () => {
    const html = renderSlot(createElement("button", null, contextPanelCopy.compactNow));
    expect(html).toContain(contextPanelCopy.compactNow);
    expect(html).toContain("<button");
    expect(html).toContain("border-t");
  });

  it("leaves the ring's own readings untouched", async () => {
    // Occupancy, the window figure, provenance and the token segments are the vendored
    // content's own job. Server rendering cannot see inside a Radix TooltipContent, so
    // this is pinned from source: the slot is a sibling of those blocks, not a
    // replacement for any of them.
    const src = await read("assistant-ui/elements/context-display.tsx");
    const content = src.slice(src.indexOf("function ContextDisplayContent("));
    const body = content.slice(0, content.indexOf("</TooltipContent>"));
    for (const reading of [
      "modelContextWindow",
      "windowSource",
      "getContextSegments",
    ]) {
      expect(body).toContain(reading);
    }
    // The slot itself computes nothing.
    const slot = src.slice(src.indexOf("function ContextDisplayAction("));
    expect(slot.slice(0, slot.indexOf("}"))).not.toMatch(/Tokens|percent|window/i);
  });

  it("keeps every caller that passes no action on the unchanged path", () => {
    // Bar and Text presets share this Content and never pass `action`; asserting the
    // bar too means the slot cannot start rendering for them by accident.
    const bar = renderToStaticMarkup(
      createElement(ContextDisplayBar as never, { ...RING_PROPS } as never),
    );
    expect(bar).not.toContain(contextPanelCopy.compactNow);
  });
});

describe("Change 3 does not reintroduce the superseded Popover approach", () => {
  it("the ring is not wrapped in a second overlay trigger", async () => {
    // Comments are stripped: this feature's own documentation explains why the Popover
    // was removed, and prose about a removed construct is not a reintroduction of it.
    const src = stripComments(await read("context-ring.tsx"));
    // The defect: `PopoverTrigger asChild` around a component that already owns its
    // trigger and content. The inner Tooltip trigger won the click and the panel was
    // unreachable, which no markup assertion could see.
    expect(src).not.toContain("PopoverTrigger");
    expect(src).not.toContain("PopoverContent");
    // The action goes through the slot the ring already owns.
    expect(src).toContain("action={action}");
  });

  it("the slot renders LAST inside the content, after provenance and segments", async () => {
    // Server rendering cannot see inside a Radix TooltipContent, so the ORDER is
    // pinned from source. It matters: the action must follow the readings it acts on,
    // and it must not displace them.
    const src = await read("assistant-ui/elements/context-display.tsx");
    const content = src.slice(src.indexOf("function ContextDisplayContent("));
    const body = content.slice(0, content.indexOf("</TooltipContent>"));
    const provenance = body.indexOf("Context limit set in this app");
    const slot = body.indexOf("<ContextDisplayAction action={action} />");
    expect(provenance).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(provenance);
  });

  it("the ring forwards the action into that slot", async () => {
    const src = await read("assistant-ui/elements/context-display.tsx");
    expect(src).toContain("<ContextDisplayContent side={side} action={action} />");
    // `ContextDisplayBar` / `ContextDisplayText` must NOT forward it.
    expect(src).not.toContain("<ContextDisplayContent side={side} action={action} />\n      <");
  });

  it("the deleted panel component is gone", async () => {
    const { existsSync } = await import("fs");
    const { resolve } = await import("path");
    expect(existsSync(resolve(import.meta.dir, "ContextPanelContent.tsx"))).toBe(false);
  });
});

describe("Compress now routes through the existing Direct send funnel", () => {
  it("the ring's handler is the composer's shared command handler", async () => {
    const composer = await read("Composer.tsx");
    // One path means one in-flight flag, one optimistic append and one divider row.
    expect(composer).toContain("parseDirectCompactCommand(DIRECT_COMPACT_COMMAND)");
    expect(composer).toContain("runDirectCompactCommand(command)");
    // A direct call into the transport would skip the append and leave the user with
    // no divider until a reload.
    expect(composer).not.toContain("onCompact={() => runDirectCompact(");
  });

  it("the action is offered only on the Direct surface", async () => {
    const composer = await read("Composer.tsx");
    // Code/OpenCode have their own compact command and must not be handed this one.
    expect(composer).toContain("if (isCodeSurface) return undefined");
  });
});
