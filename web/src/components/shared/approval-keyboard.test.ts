import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The keyboard contract on decision cards.
 *
 * ## Why source-text assertions
 *
 * These surfaces need focus, effects and bubbling. `renderToStaticMarkup` runs no
 * effects, and there is no DOM here, so the wiring itself cannot be executed --
 * only the decisions in `focus.test.ts` and `ime.test.ts` are covered by
 * behaviour. What this file protects is the *wiring*, which is exactly the part
 * that can be quietly deleted while every other test stays green.
 *
 * OpenChamber guards its own shortcut wiring the same way (`ime.commentInputs.test.ts`).
 *
 * ## The assertion that matters most
 *
 * `Enter fires once, not twice`. Focus starts on the row, not on a button, so
 * Enter needs an explicit handler -- and once the reader tabs onto a button, that
 * button activates natively. Without the `target === currentTarget` check, one
 * Enter press on a focused button would approve twice. It reads like boilerplate
 * and it is the single easiest thing here to "tidy away".
 */

const approvalCard = readFileSync(
  new URL("./approval-card.tsx", import.meta.url),
  "utf8",
);
const formCard = readFileSync(
  new URL("../../features/opencode/V2FormCard.tsx", import.meta.url),
  "utf8",
);

// The repo checks out with `core.autocrlf=true`, so the same file arrives CRLF
// on Windows and LF elsewhere. Normalised once here so a line-based assertion
// below cannot pass or fail purely because of whose editor wrote the file.
const lines = (source: string) => source.replace(/\r\n/g, "\n");

describe("ApprovalActions registers rather than grabbing focus", () => {
  it("hands its row to the registry instead of focusing itself", () => {
    // Focusing on mount is what left focus on the BOTTOM of a stacked list:
    // React runs sibling effects top-down, so "each card focuses itself" hands
    // the keyboard to the last one. The registry picks the topmost instead.
    // A direct `.focus(` call in this component would reintroduce that.
    expect(approvalCard).toContain("registerDecisionSurface(");
    expect(approvalCard).not.toMatch(/surfaceRef\.current\?\.focus\(/);
  });

  it("asks the registry whether focus was its to give back, and restores it", () => {
    // Without the hand-back, dismissing a card drops focus on <body> and the next
    // keystroke reaches nothing.
    //
    // It must be ASKED, not remembered. An earlier version kept a `tookFocus` ref
    // that was never actually set, so the restore silently never ran -- and the
    // unit tests were green, because nothing exercised a real unmount.
    expect(approvalCard).toMatch(/const wasOwner = isDecisionSurfaceOwner\(/);
    expect(approvalCard).toContain("if (wasOwner) focusComposerInput();");
    expect(approvalCard).not.toContain("tookFocus");
  });

  it("releases BEFORE restoring, so the next card can take the keyboard cleanly", () => {
    // The drain: approving the top card must hand the keyboard to the one below
    // it, not race the composer for it.
    const release = approvalCard.indexOf("release();");
    const restore = approvalCard.indexOf("focusComposerInput();");
    expect(release).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(release);
  });

  it("is focusable without entering the tab order", () => {
    // -1 keeps Tab walking into the buttons exactly as before; a bare
    // tabIndex={0} would insert a phantom stop ahead of Approve.
    expect(approvalCard).toMatch(/tabIndex=\{-1\}/);
    expect(approvalCard).not.toMatch(/tabIndex=\{0\}/);
  });

  it("names the focused row, because Enter and Escape act on it", () => {
    // An unlabelled focusable div is announced as nothing useful, so a keyboard
    // reader would land here with no idea what pressing Enter would do. This is
    // what carries the focus for a screen reader now that there is no ring.
    expect(approvalCard).toMatch(/role="group"/);
    expect(approvalCard).toMatch(/aria-label=\{actionsAria \?\? approveAria \?\? approveLabel\}/);
  });
});

describe("the focus indicator", () => {
  it("has no ring around the button row", () => {
    // A ring drawn around a row of buttons reads as an error box, not as "the
    // keyboard is here". `outline-none` must stay, so the browser's own ring
    // does not appear either -- there is deliberately nothing in its place for a
    // lone card.
    expect(approvalCard).not.toMatch(/focus:ring-/);
    expect(approvalCard).toMatch(/focus:outline-none/);
  });

  it("marks the focused card only when several decisions are on screen", () => {
    // The attribute carries BOTH facts, because `ApprovalCard` matches it with a
    // `:has()` rule and cannot otherwise know the count. A lone card must stay
    // unmarked -- its arriving is the signal, and marking it would be noise.
    expect(approvalCard).toMatch(/data-decision-owner=\{isOwner && count > 1 \? "" : undefined\}/);
  });

  it("paints the mark on the CARD, as an inset shadow rather than a border", () => {
    // On the card, not the buttons: that is what makes it read as "this card is
    // current". Inset rather than a border, because a border would shove the
    // content sideways the moment focus moved.
    expect(approvalCard).toMatch(/has-\[\[data-decision-owner\]\]:shadow-\[inset_2px_0_0_0_var\(--primary\)\]/);
  });
});

describe("ApprovalActions keys", () => {
  it("approves on Enter, IME-guarded", () => {
    expect(approvalCard).toMatch(/if \(isPlainEnter\(e\)\) \{[\s\S]*?onApprove\(\);/);
  });

  it("denies on Escape, IME-guarded", () => {
    expect(approvalCard).toMatch(/if \(isPlainEscape\(e\)\) \{[\s\S]*?onDeny\(\);/);
  });

  it("fires Enter once, not twice, when focus is on a button", () => {
    // See the file header. If this guard is removed, tabbing to Approve and
    // pressing Enter approves twice.
    expect(approvalCard).toMatch(/if \(e\.target !== e\.currentTarget\) return;/);
  });

  it("keeps Escape working from the buttons too", () => {
    // The target guard must apply to Enter ONLY. Escape needs no native
    // equivalent, so it has to keep working wherever focus sits in the row --
    // including after a reader tabs onto Deny.
    const handler = lines(approvalCard);
    const escapeBranch = handler.slice(
      handler.indexOf("onKeyDown={(e) => {"),
      handler.indexOf("if (e.target !== e.currentTarget) return;"),
    );
    expect(escapeBranch).toContain("isPlainEscape");
    expect(escapeBranch).toContain("onDeny()");
    expect(escapeBranch).not.toContain("currentTarget");
  });
});

describe("ApprovalActions hands focus back on unmount", () => {
  it("restores the composer, and only if it took the focus", () => {
    // Without the restore, dismissing a card drops focus on <body> and the next
    // keystroke reaches nothing. Without the flag, a reader who tabbed
    // somewhere else on purpose would be yanked back.
    expect(approvalCard).toMatch(/if \(wasOwner\) focusComposerInput\(\);/);
  });
});

describe("the question dock", () => {
  it("focuses its first control, so the existing Enter handler is reachable", () => {
    // Enter already advanced a step, but it was attached to the dock body and
    // nothing ever put focus there, so it could not fire.
    expect(formCard).toContain("querySelector<HTMLElement>(FOCUSABLE_IN_DOCK)");
  });

  it("can receive focus itself when the field renders no control", () => {
    expect(formCard).toMatch(/tabIndex=\{-1\}/);
  });

  it("re-runs on the field's KEY, never on the field object", () => {
    // `field` is rebuilt every render. Depending on it would re-run the focus
    // effect on every keystroke in the custom-answer box and reset the caret.
    expect(formCard).toMatch(/\}, \[field\?\.key\]\);/);
    expect(formCard).not.toMatch(/\}, \[field\]\);/);
  });

  it("registers with the same registry, so a card and a dock cannot both answer Enter", () => {
    // Both surfaces can be on screen at once: the permission list lives in the
    // OpenCode view and the dock above the composer. Two owners would mean two
    // Enter handlers, and only one of them has the keyboard.
    expect(formCard).toContain("registerDecisionSurface(");
    expect(formCard).toMatch(/const wasOwner = isDecisionSurfaceOwner\(/);
  });

  it("registers only while expanded, because a collapsed body has nothing to focus", () => {
    // The body is not rendered at all when collapsed, so registering then would
    // put a null-element surface at the top of the list owning nothing.
    expect(formCard).toMatch(
      /if \(collapsed\) return;\s*\n\s*const element = bodyRef\.current;\s*\n\s*const release = registerDecisionSurface\(element\);/,
    );
  });

  it("refocuses on a step change, but not on the arrival it already gave the registry", () => {
    // Arrival belongs to the registry (it yields to a reader mid-sentence and
    // defers to any other owner). A step change is the reader's own doing and
    // must move focus even with text on screen, so it stays here.
    expect(formCard).toMatch(/if \(!dockSeen\.current\) return;/);
    expect(formCard).toMatch(/dockSeen\.current = false;/);
  });

  it("drops the question on Escape, IME-guarded, matching the Cancel button", () => {
    expect(formCard).toMatch(/if \(isPlainEscape\(event\)\) \{[\s\S]*?void cancel\(\);/);
  });

  it("restores the composer focus on unmount", () => {
    expect(formCard).toContain("if (wasOwner) focusComposerInput();");
  });
});

describe("both surfaces share one focus policy", () => {
  it("import the same helpers rather than re-deciding locally", () => {
    // Two copies of "is it safe to take focus" would drift, and the drifting
    // copy is the one nobody re-tests.
    for (const [name, source] of [
      ["approval-card.tsx", approvalCard],
      ["V2FormCard.tsx", formCard],
    ] as const) {
      expect(source, `${name} should use the shared focus helpers`).toContain(
        'from "@/lib/focus"',
      );
    }
  });
});

describe("the composer stands down while a card owns the keyboard", () => {
  // The failure this prevents is silent. The card focuses correctly once, then
  // the composer re-takes focus on the next scroll-to-bottom or new run, and
  // Enter sends an empty message instead of approving. A mount effect cannot
  // catch that, because nothing tells it focus was lost.
  const composer = readFileSync(
    new URL("../../components/Composer.tsx", import.meta.url),
    "utf8",
  );

  it("disables both library focus behaviours while a card holds the claim", () => {
    // Both default to TRUE in assistant-ui, and TBAi overrode neither, so
    // without this the composer reclaims focus on scroll and on run start.
    expect(composer).toMatch(/unstable_focusOnScrollToBottom=\{!keyboardClaimed\}/);
    expect(composer).toMatch(/unstable_focusOnRunStart=\{!keyboardClaimed\}/);
  });

  it("keeps the behaviour when nothing is being decided", () => {
    // The `!` matters: this must be a conditional stand-down, not a removal.
    // Disabling it outright would quietly delete a convenience for everyone.
    expect(composer).toMatch(/const keyboardClaimed = useKeyboardClaimed\(\);/);
  });

  it("derives the stand-down from focus ownership, not a separate flag", () => {
    // Two sources of truth would eventually disagree: a card owning the keyboard
    // while the composer thought it was free is exactly the silent failure above.
    // A claim nobody makes is also a claim that never stands the composer down.
    expect(approvalCard).toContain("registerDecisionSurface(");
    expect(formCard).toContain("registerDecisionSurface(");
    const focus = readFileSync(new URL("../../lib/focus.ts", import.meta.url), "utf8");
    expect(focus).toContain("ownerId !== null");
  });
});
