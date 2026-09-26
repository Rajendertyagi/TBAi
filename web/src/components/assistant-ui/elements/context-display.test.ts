import { describe, it, expect, beforeAll } from "bun:test";
import {
  commentedBodyOf,
  commentedConstBodyOf,
  stripComments,
} from "@/testing/source-scope";
import {
  nextPinState,
  pinnedOpenProp,
  type PinEvent,
} from "./context-display";

/**
 * Source-level guards for the vendored context-display element and its
 * composer wiring — the ADDITIONAL wiring proof.
 *
 * `web/` has no component-test runner (no DOM under `bun test`), so — like
 * `tool-fallback.test.ts` — these assert scoped structure, not rendered
 * pixels: comments are stripped first so prose can never satisfy a test, and
 * matches must sit inside the named component's own body. The PRIMARY proof
 * for behavior is runtime execution: the pure pin transitions below run for
 * real, as do the behavioural-math suites (`modelContext.test.ts`,
 * `contextTokens.test.ts`, `chat-message-metadata.test.ts`); end-to-end
 * appearance is confirmed live in the browser.
 */
let root = "";
let trigger = "";
let percent = "";
let severity = "";
let segments = "";
let aui = "";
let composer = "";
let openCodeRing = "";

beforeAll(async () => {
  const base = import.meta.url;
  root = await commentedBodyOf("ContextDisplayRoot", "./context-display.tsx", base);
  trigger = await commentedBodyOf("ContextDisplayTrigger", "./context-display.tsx", base);
  percent = await commentedConstBodyOf("getUsagePercent", "./context-display.tsx", base);
  severity = await commentedConstBodyOf("getUsageSeverity", "./context-display.tsx", base);
  segments = await commentedConstBodyOf("getContextSegments", "./context-display.tsx", base);
  aui = stripComments(
    await Bun.file(new URL("./context-display.aui.tsx", base)).text(),
  );
  composer = stripComments(
    await Bun.file(new URL("../../Composer.tsx", base)).text(),
  );
  openCodeRing = stripComments(
    await Bun.file(
      new URL("../../../features/opencode/OpenCodeContextRing.tsx", base),
    ).text(),
  );
});

describe("vendored context-display (radix flavor)", () => {
  it("uses the repo tooltip, not the upstream radix path", async () => {
    const source = stripComments(
      await Bun.file(
        new URL("./context-display.tsx", import.meta.url),
      ).text(),
    );
    expect(source).toContain("@/components/ui/tooltip");
    expect(source).not.toContain("ui/radix/tooltip");
  });

  it("hides the popover arrow our tooltip variant renders", async () => {
    const source = stripComments(
      await Bun.file(
        new URL("./context-display.tsx", import.meta.url),
      ).text(),
    );
    expect(source).toContain("[&_svg]:hidden");
  });

  it("renders nothing until usage exists", () => {
    expect(root).toContain("if (!hasUsage) return null;");
  });

  it("clamps the ring percentage at 100", () => {
    expect(percent).toContain("Math.min");
    expect(percent).toContain("100");
  });

  it("shifts severity at 65/85", () => {
    expect(severity).toContain("> 85");
    expect(severity).toContain(">= 65");
  });

  it("lists real provider rows and drops zero rows", () => {
    for (const label of ["Input", "Cached input", "Output", "Reasoning"]) {
      expect(segments).toContain(label);
    }
    expect(segments).toContain("tokens > 0");
  });

  it("keeps hover/focus native via the Radix asChild trigger", () => {
    // Trigger itself: Radix asChild passthrough that forwards all props.
    // Hover/focus open natively (no forced `open`); click pins separately.
    expect(trigger).toContain("asChild");
    expect(trigger).toContain("{...props}");
  });

  it("labels the ring trigger for assistive tech", async () => {
    // The presets are expression-bodied arrows (no brace body to scope), so
    // assert on the comment-free file: the label must be real JSX, and
    // stripping comments keeps prose from satisfying it.
    const source = stripComments(
      await Bun.file(
        new URL("./context-display.tsx", import.meta.url),
      ).text(),
    );
    expect(source).toContain('aria-label="Context usage"');
  });
});

describe("runtime wiring (.aui)", () => {
  it("reads the official thread usage hook", () => {
    expect(aui).toContain("useThreadTokenUsage");
  });

  it("resets the running total on thread change", () => {
    expect(aui).toContain("s.threadListItem.id");
    expect(aui).toContain("resetKey");
  });
});

describe("composer rail mount", () => {
  it("mounts the Direct ring on chat surfaces", () => {
    expect(composer).toContain("DirectContextRing");
  });

  it("mounts the OpenCode ring on Code surfaces", () => {
    expect(composer).toContain("OpenCodeContextRing");
    expect(composer).toContain("isCodeSurface || showOpenCodeDraft");
  });
});

describe("pin transitions (PRIMARY runtime proof for click-to-open)", () => {
  it("toggles the pin on click", () => {
    const events: PinEvent[] = ["toggle", "toggle"];
    expect(events.map((e) => nextPinState(false, e))).toEqual([true, true]);
    expect(nextPinState(false, "toggle")).toBe(true);
    expect(nextPinState(true, "toggle")).toBe(false);
  });

  it("releases the pin on native dismiss (outside click / Escape)", () => {
    expect(nextPinState(true, "release")).toBe(false);
    expect(nextPinState(false, "release")).toBe(false);
  });

  it("holds Radix open only while pinned, else stays uncontrolled", () => {
    // `true` pins the popover open; `undefined` (not `false`) keeps Radix
    // fully uncontrolled so hover/focus open and outside-click/Escape close
    // natively. This strict-undefined assertion IS the no-fighting contract.
    expect(pinnedOpenProp(true)).toBe(true);
    expect(pinnedOpenProp(false)).toBeUndefined();
  });
});

describe("pin wiring (additional source-guard proof)", () => {
  it("drives the tooltip from pin state and releases on dismiss", () => {
    expect(root).toContain("pinnedOpenProp(pinned)");
    expect(root).toContain("onOpenChange");
    expect(root).toContain('nextPinState(p, "release")');
  });

  it("toggles the pin from the trigger click without swallowing handlers", () => {
    expect(trigger).toContain("togglePin()");
    expect(trigger).toContain("props.onClick?.(e)");
    expect(trigger).toContain("defaultPrevented");
  });
});

describe("OpenCode ring source", () => {
  it("reads native V2 extras usage and memoizes the token mapping", () => {
    expect(openCodeRing).toContain("extras?.state.usage?.tokens");
    expect(openCodeRing).toContain("toTokenUsage(extras?.state.usage?.tokens)");
    expect(openCodeRing).not.toContain("state.thread.messages");
    expect(openCodeRing).not.toContain("metadata.custom.tokens");
  });

  it("resets on session change and prefers the live model limit", () => {
    expect(openCodeRing).toContain("resetKey={extras.sessionId}");
    expect(openCodeRing).toContain("limit?.context");
  });
});
