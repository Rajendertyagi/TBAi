import { describe, it, expect, beforeAll } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenCodeShieldButton, runShieldToggle } from "./OpenCodeShieldChip";
import { persistAutoApprove } from "./autoApproveWrite";
import { ApprovalGate, Json } from "@/tools/filesystem/ui";
import {
  stripComments,
  functionBody,
  commentedBodyOf,
} from "@/testing/source-scope";

/**
 * The Auto Approval Shield UI.
 *
 * `web/` has no DOM runner (bun test, no jsdom / testing-library), so the
 * contracts are pinned through three seams, following the established pattern
 * (`QuestionFormCard.test.tsx`):
 *
 *   1. **Static render** (`renderToStaticMarkup`) of the REAL presentational
 *      `OpenCodeShieldButton` — the OFF/ON structure, `aria-pressed`, the
 *      accessible label and the title.
 *   2. **Pure toggle logic** (`runShieldToggle`) — the OFF→ON / ON→OFF write
 *      calls, reconcile pass-through, draft behavior, missing-session fail
 *      closed, and failure propagation.
 *   3. **Source guards** — the chip renders from conversation config (never the
 *      runtime policy cache), never issues permission calls itself, and the
 *      questions surface is untouched.
 */

// ── Static render: the presentational button ────────────────────────────────

function renderButton(props: {
  enabled: boolean;
  busy?: boolean;
  disabled?: boolean;
}): string {
  const Any = OpenCodeShieldButton as unknown as (
    p: Record<string, unknown>,
  ) => ReactElement;
  return renderToStaticMarkup(
    createElement(Any, { ...props, onToggle: () => {} }),
  );
}

describe("OpenCodeShieldButton — static render", () => {
  it("renders the OFF state with aria-pressed=false, label and title", () => {
    const html = renderButton({ enabled: false });
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Auto off");
    expect(html).toContain("Auto-approval off");
    expect(html).toContain("Auto-approve permissions: off");
  });

  it("renders the ON state with aria-pressed=true, label and title", () => {
    const html = renderButton({ enabled: true });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Auto on");
    expect(html).toContain("Auto-approval on");
    expect(html).toContain("Auto-approve permissions: on");
  });

  it("is keyboard accessible (a real button) and disabled when told", () => {
    const html = renderButton({ enabled: false, disabled: true });
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain("disabled");
  });
});

// ── Pure toggle logic ───────────────────────────────────────────────────────

function fakePersist() {
  const calls: Array<{
    conversationId: string;
    sessionId: string;
    enabled: boolean;
    reconcile: (() => Promise<number>) | undefined;
  }> = [];
  const persist = async (
    conversationId: string,
    sessionId: string,
    enabled: boolean,
    reconcile?: () => Promise<number>,
  ) => {
    calls.push({ conversationId, sessionId, enabled, reconcile });
  };
  return { calls, persist };
}

describe("runShieldToggle — bound conversation", () => {
  it("OFF → ON calls persistAutoApprove with enabled=true", async () => {
    const { calls, persist } = fakePersist();
    const next = await runShieldToggle(false, {
      draft: false,
      conversationId: "conv_1",
      sessionId: "ses_1",
      persist,
      setDraftAutoApprove: () => {},
    });
    expect(next).toBe(true);
    expect(calls).toEqual([
      {
        conversationId: "conv_1",
        sessionId: "ses_1",
        enabled: true,
        reconcile: undefined,
      },
    ]);
  });

  it("ON → OFF calls persistAutoApprove with enabled=false", async () => {
    const { calls, persist } = fakePersist();
    const next = await runShieldToggle(true, {
      draft: false,
      conversationId: "conv_1",
      sessionId: "ses_1",
      persist,
      setDraftAutoApprove: () => {},
    });
    expect(next).toBe(false);
    expect(calls[0]?.enabled).toBe(false);
  });

  it("passes the reconcile seam through to the write operation", async () => {
    const { calls, persist } = fakePersist();
    const reconcile = async () => 1;
    await runShieldToggle(false, {
      draft: false,
      conversationId: "conv_1",
      sessionId: "ses_1",
      reconcile,
      persist,
      setDraftAutoApprove: () => {},
    });
    expect(calls[0]?.reconcile).toBe(reconcile);
  });

  it("without a session id it throws and never calls the write", async () => {
    const { calls, persist } = fakePersist();
    let thrown: unknown;
    try {
      await runShieldToggle(false, {
        draft: false,
        conversationId: "conv_1",
        sessionId: undefined,
        persist,
        setDraftAutoApprove: () => {},
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(calls).toEqual([]);
  });

  it("a failed write propagates so the UI keeps the current state", async () => {
    const failing = async () => {
      throw new Error("PATCH failed");
    };
    let thrown: unknown;
    try {
      await runShieldToggle(false, {
        draft: false,
        conversationId: "conv_1",
        sessionId: "ses_1",
        persist: failing as typeof persistAutoApprove,
        setDraftAutoApprove: () => {},
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("PATCH failed");
  });
});

describe("runShieldToggle — draft", () => {
  it("flips the draft store and never calls the write operation", async () => {
    const { calls, persist } = fakePersist();
    const drafts: boolean[] = [];
    const next = await runShieldToggle(false, {
      draft: true,
      conversationId: "",
      sessionId: undefined,
      persist,
      setDraftAutoApprove: (v) => drafts.push(v),
    });
    expect(next).toBe(true);
    expect(drafts).toEqual([true]);
    expect(calls).toEqual([]);
  });

  it("turning the draft OFF flips the store to false", async () => {
    const drafts: boolean[] = [];
    await runShieldToggle(true, {
      draft: true,
      conversationId: "",
      sessionId: undefined,
      persist: fakePersist().persist,
      setDraftAutoApprove: (v) => drafts.push(v),
    });
    expect(drafts).toEqual([false]);
  });
});

// ── The approval card the Code engine renders ──────────────────────────────

/**
 * `ApprovalGate` is the card every permission-gated tool ends up on, including
 * the OpenCode/Code engine. It renders a `prompt` (the engine's question text)
 * and the tool arguments.
 *
 * The regression this pins: the two used to be mutually exclusive — the prompt
 * was the if-branch and the argument preview the else-branch. Because the V2
 * bridge always set a prompt (falling back to the action name, `"shell"`, which
 * is truthy), the arguments were discarded and the card read `shell` instead of
 * `{"command":"echo CARD-TEST-1"}`. The arguments ARE the substance of a
 * permission, so a prompt may sit above them but must never stand in for them.
 *
 * This IS a genuine render, not a source-text assertion: `web/` has no DOM, but
 * `react-dom/server` needs none, and the open-gate branch of `ApprovalGate` is
 * renderable without an `AuiProvider` (its only runtime hook, `useAui`, is
 * consumed inside a `useEffect`, which static rendering does not run).
 */
const GATE_TITLE = "shell · echo CARD-TEST-1";
const GATE_ARGS = { command: "echo CARD-TEST-1" };
/** The exact argument JSON the live card showed after the fix. */
const RENDERED_ARGS = '"command": "echo CARD-TEST-1"';

function renderGate(prompt?: string): string {
  const Gate = ApprovalGate as unknown as (p: Record<string, unknown>) => ReactElement;
  return renderToStaticMarkup(
    createElement(Gate, {
      title: GATE_TITLE,
      // The real argument preview, exactly as `BackendToolView` supplies it.
      details: createElement(Json, { value: GATE_ARGS }),
      approval: {
        id: "per_gate_1",
        // `approved: undefined` is what "awaiting a decision" looks like.
        approved: undefined,
        options: [],
        // Spread, not assigned: "no prompt" means the key is ABSENT, which is
        // what the V2 bridge now produces and what the card must handle.
        ...(prompt === undefined ? {} : { prompt }),
      },
      respondToApproval: async () => {},
    }),
  );
}

/** React escapes text nodes, so decode the entities it emits for readability. */
function decodeEntities(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The text of every paragraph the gate emitted, trimmed.
 *
 * Tag-scoped, so it does not care how the prompt line is styled. It is exact
 * for this fixture because the minimal gate renders no other paragraph: the
 * card title is a `div`, and with no declared options there is no confirm block,
 * no freeform answer row, no outside-workspace note and no error line.
 */
function paragraphTexts(html: string): string[] {
  return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((match) =>
    decodeEntities(match[1] ?? "").trim(),
  );
}

describe("ApprovalGate — the prompt never replaces the argument preview", () => {
  it("shows the prompt AND the arguments when the engine attaches a prompt", () => {
    // The exact regression input: prompt `"shell"`, real arguments attached.
    const html = renderGate("shell");

    expect(paragraphTexts(html)).toEqual(["shell"]);
    // The arguments survive alongside it — this is what was being thrown away.
    expect(decodeEntities(html)).toContain(RENDERED_ARGS);
  });

  it("shows the arguments with no prompt at all, and emits no prompt line", () => {
    const html = renderGate();

    expect(decodeEntities(html)).toContain(RENDERED_ARGS);
    // No empty paragraph standing in for the absent prompt.
    expect(paragraphTexts(html)).toEqual([]);
  });

  it("treats a whitespace-only prompt as absent and still shows the arguments", () => {
    // A blank prompt is not a question; rendering it would put a blank line
    // where the arguments should start.
    const html = renderGate("   ");

    expect(paragraphTexts(html)).toEqual([]);
    expect(decodeEntities(html)).toContain(RENDERED_ARGS);
  });

  it("places the prompt above the arguments, not after or instead of them", () => {
    const html = renderGate("Which database?");

    expect(paragraphTexts(html)).toEqual(["Which database?"]);
    const promptAt = html.indexOf("Which database?");
    const argsAt = html.indexOf("&quot;command&quot;");
    expect(promptAt).toBeGreaterThan(-1);
    expect(argsAt).toBeGreaterThan(-1);
    expect(promptAt).toBeLessThan(argsAt);
  });

  it("still offers the decision on every one of those paths", () => {
    // The gate is a decision surface: a fix to what it shows must not cost the
    // user the ability to answer.
    for (const prompt of ["shell", undefined, "   "]) {
      const html = renderGate(prompt);
      expect(html, String(prompt)).toContain("Approve");
      expect(html, String(prompt)).toContain("Deny");
    }
  });
});

// ── Source guards: the chip's wiring ───────────────────────────────────────

let chipSource = "";
let chipBody = "";
let composerSource = "";
let questionsSource = "";

beforeAll(async () => {
  chipSource = await Bun.file(
    new URL("./OpenCodeShieldChip.tsx", import.meta.url),
  ).text();
  chipBody = functionBody(stripComments(chipSource), "OpenCodeShieldChip");
  composerSource = await Bun.file(
    new URL("../../components/Composer.tsx", import.meta.url),
  ).text();
  questionsSource = await Bun.file(
    new URL("./OpenCodeQuestions.tsx", import.meta.url),
  ).text();
});

describe("OpenCodeShieldChip — source guards", () => {
  it("renders from the conversation config, never the runtime policy cache", () => {
    // The chip reads `config?.opencodeAutoApprove` (the authoritative value).
    expect(chipBody).toContain("config?.opencodeAutoApprove");
    // It must not read the runtime policy Map.
    expect(stripComments(chipSource)).not.toContain("getAutoPolicy");
    expect(stripComments(chipSource)).not.toContain("sessionAutoPolicy");
  });

  it("never issues permission calls itself", () => {
    expect(stripComments(chipSource)).not.toContain("permission.reply");
    expect(stripComments(chipSource)).not.toContain("permission.list");
    expect(stripComments(chipSource)).not.toContain("autoAcceptPendingPermissions");
  });

  it("writes only through the single existing operation", () => {
    expect(chipBody).toContain("persistAutoApprove");
    expect(chipBody).toContain("runShieldToggle");
  });

  it("a failed write leaves the UI on the current state (no false ON)", () => {
    // `setEnabled(next)` only runs after a successful `runShieldToggle`; the
    // catch path logs and does not flip the mirror.
    expect(chipBody).toContain("setEnabled(next)");
    expect(chipBody).toContain("logger.debug");
  });

  it("the composer mounts the Shield in the OpenCode chip row", () => {
    expect(composerSource).toContain("OpenCodeShieldChip");
    expect(composerSource).toContain("<OpenCodeShieldChip />");
  });

  it("the questions surface is untouched by the Shield", () => {
    expect(questionsSource).not.toContain("OpenCodeShieldChip");
    expect(questionsSource).not.toContain("persistAutoApprove");
    expect(questionsSource).not.toContain("sessionAutoPolicy");
  });
});

/**
 * The structural half of the same contract, scoped to `ApprovalGate`'s own body
 * with comments stripped — so prose describing the rule can never satisfy it.
 *
 * The render cases above prove the behaviour; these prove the shape that made
 * the behaviour possible, and would catch a re-introduction of the either/or
 * even if some future gate happened to render the same markup by accident.
 */
describe("ApprovalGate — source guards", () => {
  let gateBody = "";

  beforeAll(async () => {
    gateBody = await commentedBodyOf(
      "ApprovalGate",
      "../../tools/filesystem/ui.tsx",
      import.meta.url,
    );
  });

  it("renders the argument preview unconditionally, never as the prompt's alternative", () => {
    // The old shape was `{prompt ? <p>{prompt}</p> : details}` — the preview was
    // the else-branch, so any truthy prompt discarded it entirely.
    expect(gateBody).not.toMatch(/: details\b/);
    expect(gateBody).not.toMatch(
      /\?\s*<p[^>]*>\s*\{prompt\}\s*<\/p>\s*:\s*details/,
    );
    // And the preview is still a plain child on every branch that renders it
    // (the auto-decision row and the open gate).
    expect(gateBody).toContain("{details}");
  });

  it("normalises a blank prompt away instead of rendering an empty line", () => {
    // The source half of "a whitespace-only prompt is treated as absent".
    expect(gateBody).toContain("approval.prompt.trim().length > 0");
  });
});