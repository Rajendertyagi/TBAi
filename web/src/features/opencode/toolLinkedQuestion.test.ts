import {
  describe,
  it,
  expect,
  mock,
  afterEach,
  type Mock,
} from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getQuestionToolCallId,
  isLinkedQuestion,
  useToolLinkedQuestion,
  type ToolLinkedQuestion,
} from "./toolLinkedQuestion";
import { OpenCodeQuestionToolUI } from "@/tools/opencode/ui";
import type { OpenCodeQuestionRequest } from "@assistant-ui/react-opencode";

/**
 * Tool-linked OpenCode question bridge (Phase B).
 *
 * The frozen adapter owns question state (`useOpenCodeQuestions`) and the
 * answer/skip capability (`useOpenCodeRuntimeExtras`); this module is the only
 * place that maps a rendered tool call onto its pending question, keyed by
 * `request.tool.callID === toolCallId`. These tests fake the two adapter hooks
 * so the matching + forwarding contract is proven without a live runtime.
 */

// ── Fakes for the two adapter hooks the module consumes ──────────────────────

let fakeQuestions: OpenCodeQuestionRequest[] = [];
let fakeReplies: Array<{ requestID: string; answers: string[][] }> = [];
let fakeRejects: string[] = [];

const questionHooksMock: Mock<() => OpenCodeQuestionRequest[]> = mock(
  () => fakeQuestions,
);
const runtimeExtrasMock: Mock<() => {
  replyToQuestion: (requestID: string, answers: string[][]) => Promise<void>;
  rejectQuestion: (requestID: string) => Promise<void>;
}> = mock(() => ({
  replyToQuestion: async (requestID: string, answers: string[][]) => {
    fakeReplies.push({ requestID, answers });
  },
  rejectQuestion: async (requestID: string) => {
    fakeRejects.push(requestID);
  },
}));

function installHookFakes() {
  fakeQuestions = [];
  fakeReplies = [];
  fakeRejects = [];
  mock.module("@assistant-ui/react-opencode", () => ({
    useOpenCodeQuestions: questionHooksMock,
    useOpenCodeRuntimeExtras: runtimeExtrasMock,
  }));
}

function question(overrides: Partial<OpenCodeQuestionRequest> = {}): OpenCodeQuestionRequest {
  return {
    id: "que_1",
    sessionID: "ses_1",
    questions: [
      {
        header: "Which approach?",
        question: "Pick one",
        options: [
          { label: "A", description: "option A" },
          { label: "B", description: "option B" },
        ],
      },
    ],
    ...overrides,
  } as unknown as OpenCodeQuestionRequest;
}

afterEach(() => {
  fakeQuestions = [];
  fakeReplies = [];
  fakeRejects = [];
});

// ── Pure matching helpers ────────────────────────────────────────────────────

describe("getQuestionToolCallId — strict callID match", () => {
  it("returns the tool callID when the request carries one", () => {
    const req = question({
      tool: { callID: "call_abc", messageID: "msg_1" } as OpenCodeQuestionRequest["tool"],
    });
    expect(getQuestionToolCallId(req)).toBe("call_abc");
  });

  it("returns undefined when the request has no tool.callID", () => {
    expect(getQuestionToolCallId(question())).toBeUndefined();
  });

  it("returns undefined for a malformed callID (non-string)", () => {
    const req = question({
      tool: { callID: 12345 } as unknown as OpenCodeQuestionRequest["tool"],
    });
    expect(getQuestionToolCallId(req)).toBeUndefined();
  });
});

describe("isLinkedQuestion", () => {
  it("is true only when the tool callID is a string", () => {
    expect(isLinkedQuestion(question())).toBe(false);
    expect(
      isLinkedQuestion(
        question({
          tool: { callID: "call_x" } as OpenCodeQuestionRequest["tool"],
        }),
      ),
    ).toBe(true);
  });
});

// ── useToolLinkedQuestion — match + forwarding ───────────────────────────────

describe("useToolLinkedQuestion — matching", () => {
  it("returns the question whose tool.callID exactly matches", () => {
    installHookFakes();
    fakeQuestions = [
      question({ id: "que_a", tool: { callID: "call_target" } as OpenCodeQuestionRequest["tool"] }),
      question({ id: "que_b", tool: { callID: "call_other" } as OpenCodeQuestionRequest["tool"] }),
    ];
    const linked = useToolLinkedQuestion("call_target");
    expect(linked).not.toBeNull();
    expect(linked?.request.id).toBe("que_a");
  });

  it("returns null for a mismatched tool call id", () => {
    installHookFakes();
    fakeQuestions = [
      question({ id: "que_a", tool: { callID: "call_target" } as OpenCodeQuestionRequest["tool"] }),
    ];
    expect(useToolLinkedQuestion("call_mismatch")).toBeNull();
  });

  it("returns null for a question that has no tool.callID (not linked)", () => {
    installHookFakes();
    fakeQuestions = [question({ id: "que_unlinked" })];
    // An unlinked question can never match a tool call id.
    expect(useToolLinkedQuestion("call_x")).toBeNull();
  });

  it("returns null when there is no toolCallId argument", () => {
    installHookFakes();
    fakeQuestions = [
      question({ id: "que_a", tool: { callID: "call_a" } as OpenCodeQuestionRequest["tool"] }),
    ];
    expect(useToolLinkedQuestion(undefined)).toBeNull();
  });

  it("with multiple pending questions returns only the exact match", () => {
    installHookFakes();
    fakeQuestions = [
      question({ id: "que_1", tool: { callID: "call_1" } as OpenCodeQuestionRequest["tool"] }),
      question({ id: "que_2", tool: { callID: "call_2" } as OpenCodeQuestionRequest["tool"] }),
      question({ id: "que_3", tool: { callID: "call_3" } as OpenCodeQuestionRequest["tool"] }),
    ];
    expect(useToolLinkedQuestion("call_2")?.request.id).toBe("que_2");
    expect(useToolLinkedQuestion("call_nope")).toBeNull();
  });
});

describe("useToolLinkedQuestion — answer() forwards the exact answers[]", () => {
  it("answer(answers) calls replyToQuestion with this request id and the full answers array", async () => {
    installHookFakes();
    fakeQuestions = [
      question({ id: "que_m", tool: { callID: "call_m" } as OpenCodeQuestionRequest["tool"] }),
    ];
    const linked = useToolLinkedQuestion("call_m") as ToolLinkedQuestion;
    await linked.answer([
      ["A", "B"],
      ["custom text"],
    ]);
    expect(fakeReplies).toEqual([{ requestID: "que_m", answers: [["A", "B"], ["custom text"]] }]);
    expect(fakeRejects).toEqual([]);
  });

  it("never touches another question's request id", async () => {
    installHookFakes();
    fakeQuestions = [
      question({ id: "que_1", tool: { callID: "call_1" } as OpenCodeQuestionRequest["tool"] }),
      question({ id: "que_2", tool: { callID: "call_2" } as OpenCodeQuestionRequest["tool"] }),
    ];
    const linked = useToolLinkedQuestion("call_1") as ToolLinkedQuestion;
    await linked.answer([["A"]]);
    // Only que_1 is answered; que_2 is untouched.
    expect(fakeReplies).toEqual([{ requestID: "que_1", answers: [["A"]] }]);
    expect(fakeReplies.some((r) => r.requestID === "que_2")).toBe(false);
  });
});

describe("useToolLinkedQuestion — skip() rejects the correct request id", () => {
  it("skip() calls rejectQuestion with this request's id only", async () => {
    installHookFakes();
    fakeQuestions = [
      question({ id: "que_a", tool: { callID: "call_a" } as OpenCodeQuestionRequest["tool"] }),
      question({ id: "que_b", tool: { callID: "call_b" } as OpenCodeQuestionRequest["tool"] }),
    ];
    const linked = useToolLinkedQuestion("call_b") as ToolLinkedQuestion;
    await linked.skip();
    expect(fakeRejects).toEqual(["que_b"]);
    expect(fakeReplies).toEqual([]);
  });

  it("skip() on one question never rejects another pending question", async () => {
    installHookFakes();
    fakeQuestions = [
      question({ id: "que_a", tool: { callID: "call_a" } as OpenCodeQuestionRequest["tool"] }),
      question({ id: "que_b", tool: { callID: "call_b" } as OpenCodeQuestionRequest["tool"] }),
    ];
    const linkedA = useToolLinkedQuestion("call_a") as ToolLinkedQuestion;
    await linkedA.skip();
    expect(fakeRejects).toEqual(["que_a"]);
    // que_b remains pending and rejectable.
    expect(fakeRejects.some((id) => id === "que_b")).toBe(false);
  });
});

// ── Runtime safety: unbound thread, no OpenCode runtime ─────────────────────

/**
 * Regression for the runtime-safety hardening of `useToolLinkedQuestion`.
 *
 * The frozen adapter's `useOpenCodeQuestions()` is null-safe (returns `[]`
 * when unbound), but `useOpenCodeRuntimeExtras()` THROWS outside an OpenCode
 * runtime. A historical question tool part can render while the runtime is
 * unavailable (loading history, first paint, switching conversations,
 * detach/reattach, session loss) — the hook must fall back to `null` (and the
 * tool UI to its read-only view) instead of crashing the message list.
 *
 * The fake below reproduces the adapter faithfully: questions read returns
 * `[]`, the extras read throws exactly like `openCodeExtras.use()` does with
 * no runtime bound. Bound + match / bound + no-match are proven by the
 * "matching" describes above; only the unbound path is added here.
 */

const throwingExtrasMock: Mock<() => unknown> = mock(() => {
  throw new Error("Throws outside an OpenCode runtime");
});

function installUnboundFakes() {
  mock.module("@assistant-ui/react-opencode", () => ({
    useOpenCodeQuestions: () => [] as OpenCodeQuestionRequest[],
    useOpenCodeRuntimeExtras: throwingExtrasMock,
  }));
}

const historicalQuestionPart = {
  type: "tool-call",
  toolCallId: "call_hist",
  toolName: "question",
  args: { questions: [{ question: "Which file?", options: [{ label: "a.ts" }] }] },
  argsText: JSON.stringify({ questions: [] }),
  result: "answered: a.ts",
  status: { type: "complete" },
};

describe("useToolLinkedQuestion — runtime safety (no OpenCode runtime bound)", () => {
  it("returns null — and does not throw — for a matching tool call id", () => {
    installUnboundFakes();
    // A real linkable toolCallId, but the extras read is unavailable. The
    // hardening must swallow the extras throw and resolve to `null` rather
    // than crash.
    expect(() => useToolLinkedQuestion("call_hist")).not.toThrow();
    expect(useToolLinkedQuestion("call_hist")).toBeNull();
  });

  it("returns null — and does not throw — when the tool call id is absent", () => {
    installUnboundFakes();
    expect(() => useToolLinkedQuestion(undefined)).not.toThrow();
    expect(useToolLinkedQuestion(undefined)).toBeNull();
  });

  it("the linked OpenCodeQuestionToolUI renders its read-only fallback, no throw", () => {
    installUnboundFakes();
    // The real tool renderer with a historical question part and no runtime:
    // `useToolLinkedQuestion` resolves to `null`, so the component takes the
    // hook-free read-only branch — never the interactive card, never a crash.
    const Any = OpenCodeQuestionToolUI as unknown as (
      p: Record<string, unknown>,
    ) => ReturnType<typeof createElement>;
    const html = renderToStaticMarkup(
      createElement(Any, historicalQuestionPart),
    );
    // The read-only preview of the question text/options renders…
    expect(html).toContain("Which file?");
    expect(html).toContain("a.ts");
    // …and nothing that only the interactive (linked) card would show.
    expect(html).not.toContain("Answer");
    expect(html).not.toContain("undefined");
  });
});

// ── Panel exclusion (pure: mirrors QuestionsBound's filter) ─────────────────

describe("panel linked-exclusion (isLinkedQuestion filter)", () => {
  it("hides linked questions and keeps unlinked ones answerable", () => {
    const linked = question({
      id: "que_linked",
      tool: { callID: "call_l" } as OpenCodeQuestionRequest["tool"],
    });
    const unlinked = question({ id: "que_unlinked" });
    const panel = [linked, unlinked].filter((req) => !isLinkedQuestion(req));
    expect(panel.map((r) => r.id)).toEqual(["que_unlinked"]);
  });

  it("when every question is linked the panel is empty", () => {
    const a = question({ id: "a", tool: { callID: "ca" } as OpenCodeQuestionRequest["tool"] });
    const b = question({ id: "b", tool: { callID: "cb" } as OpenCodeQuestionRequest["tool"] });
    expect([a, b].filter((req) => !isLinkedQuestion(req))).toEqual([]);
  });
});
