import { describe, it, expect, beforeAll } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenCodeShieldButton, runShieldToggle } from "./OpenCodeShieldChip";
import { persistAutoApprove } from "./autoApproveWrite";
import { stripComments, functionBody } from "@/testing/source-scope";

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