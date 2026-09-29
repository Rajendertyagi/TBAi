import { describe, it, expect } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  OpenCodeBashToolUI,
  OpenCodeEditView,
  OpenCodeGlobToolUI,
  OpenCodeGrepToolUI,
  OpenCodeReadToolUI,
  OpenCodeSkillToolUI,
  OpenCodeTaskToolUI,
  OpenCodeWebFetchToolUI,
  OpenCodeWriteToolUI,
  QuestionReadonlyView,
} from "./ui";
import { openCodeQuestionAnswersFromParts } from "./adapt";
import { openCodeToolkit } from "@/tools/toolkit";
import { toolsConfig } from "@/config/tools";
import {
  CAPTURED_QUESTION_PART_ID,
  capturedPendingQuestionPart,
  capturedQuestionContent,
  capturedQuestionPart,
  capturedQuestionRawParts,
} from "@/testing/question-payloads";

/**
 * Renders the REAL component tree (OpenCode view → BackendToolView → ToolCard)
 * against REAL OpenCode-shaped input, and asserts the three things a rich UI
 * must show: the tool title, the requested path, and the result body.
 *
 * This is a genuine render, not a source-text assertion. `web/` has no DOM, but
 * `react-dom/server` needs none, and the completed-tool branch of
 * `BackendToolView` is hook-free, so the whole path is exercised.
 *
 * The props below use the native V2 contract's actual field names and result
 * type:
 *   - `read` args are `{ filePath }` (from the server tool schema)
 *   - a completed tool result carries a native V2 content array
 */

function render(
  UI: ToolCallMessagePartComponent,
  props: Record<string, unknown>,
): string {
  const Any = UI as unknown as (p: Record<string, unknown>) => ReactElement;
  return renderToStaticMarkup(createElement(Any, props));
}

/** A completed part, shaped exactly as OpenCode sends it. */
const completedRead = (args: Record<string, unknown>, result: unknown) => ({
  type: "tool-call",
  toolCallId: "call_1",
  toolName: "read",
  args,
  argsText: JSON.stringify(args),
  result,
  status: { type: "complete" },
});

const PATH = "D:\\ws\\notes.txt";
/**
 * The REAL native V2 completed-tool result: the `content` array itself.
 *
 * A completed tool state carries `content` as `[ToolContent, ...]`, and that
 * array is what a renderer receives — `v2History`/`v2Events` set the part's
 * `output` to it and the message projection passes `output` through as
 * `result`. A `{ content: [...] }` wrapper is NOT the runtime shape; building
 * one here is what let a broken body path stay green.
 */
const nativeContent = (text: string) => [{ type: "text", text }];
const BODY = "alpha\nbeta\ngamma\n";

describe("OpenCode read — title, path and body all populate", () => {
  it("titles the card with the tool and the requested file path", () => {
    const html = render(OpenCodeReadToolUI, completedRead({ filePath: PATH }, nativeContent(BODY)));
    expect(html).toContain(`read · ${PATH}`);
  });

  it("renders the file text as the body", () => {
    const html = render(OpenCodeReadToolUI, completedRead({ filePath: PATH }, nativeContent(BODY)));
    for (const line of ["alpha", "beta", "gamma"]) {
      expect(html, line).toContain(line);
    }
  });

  it("renders an incomplete native V2 tool state as failed", () => {
    const html = render(
      OpenCodeReadToolUI,
      {
        ...completedRead({ filePath: PATH }, undefined),
        status: { type: "incomplete", reason: "File not found" },
      },
    );
    expect(html).toContain("Failed");
    expect(html).not.toContain("No output");
  });

  it("renders no `undefined` anywhere", () => {
    // The exact symptom of an unmapped field: a title reading "read · undefined".
    const html = render(OpenCodeReadToolUI, completedRead({ filePath: PATH }, nativeContent(BODY)));
    expect(html).not.toContain("undefined");
  });

  it("takes the path from filePath, not from an absent `path`", () => {
    // Non-vacuity control: with no args there is no path to show, which proves
    // the path above came from OpenCode's `filePath` via normalization.
    const html = render(OpenCodeReadToolUI, completedRead({}, nativeContent(BODY)));
    // The title falls back to the bare tool name, with no dangling separator:
    // the formatter lives in toolsConfig and omits it when there is no subject.
    // What this case proves is the assertion below it — the path really is
    // absent, which is what makes the sibling case non-vacuous.
    expect(html).toContain("read");
    expect(html).not.toContain("read ·");
    expect(html).not.toContain(PATH);
  });

  it("still works when the args already use our own field name", () => {
    // Normalization must add an alias, not require one.
    const html = render(OpenCodeReadToolUI, completedRead({ path: PATH }, nativeContent(BODY)));
    expect(html).toContain(`read · ${PATH}`);
  });

  it("shows a placeholder rather than nothing for an empty body", () => {
    const html = render(OpenCodeReadToolUI, completedRead({ filePath: PATH }, []));
    expect(html).toContain("No output.");
  });
});

describe("OpenCode glob / grep — title comes from `pattern`", () => {
  it("titles glob with the pattern", () => {
    const html = render(
      OpenCodeGlobToolUI,
      completedRead({ pattern: "**/*.tsx", path: "web/src" }, nativeContent("a.tsx\nb.tsx")),
    );
    expect(html).toContain("glob · **/*.tsx");
    expect(html).not.toContain("undefined");
  });

  it("titles grep with the pattern and renders the matches", () => {
    const html = render(
      OpenCodeGrepToolUI,
      completedRead({ pattern: "useStaleApprovalGuard", include: "*.tsx" }, nativeContent("a.tsx:12")),
    );
    expect(html).toContain("grep · useStaleApprovalGuard");
    expect(html).toContain("a.tsx:12");
  });
});

/* -------------------------------------------------------------------------
 * Permission-gated tools (Phase 3C).
 *
 * These are the tools the approval gate actually fires on. They must show the
 * correct title/path/body AND keep the one guarded approval lifecycle — so
 * these tests assert both: the content, and that a pending gate takes the card
 * over rather than being rendered alongside output.
 * ---------------------------------------------------------------------- */

/** A part for an arbitrary OpenCode tool, shaped as OpenCode sends it. */
const toolPart = (
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  extra: Record<string, unknown> = {},
) => ({
  type: "tool-call",
  toolCallId: `call_${toolName}`,
  toolName,
  args,
  argsText: JSON.stringify(args),
  result,
  status: { type: "complete" },
  ...extra,
});

describe("OpenCode edit / write — title, path and body", () => {
  it("titles an edit with the file path and shows native completion text", () => {
    // Rendered WITHOUT a patch: the card must still say something useful rather
    // than render empty. `OpenCodeEditView` is the pure half — the registered
    // `OpenCodeEditToolUI` adds a hook that needs an AuiProvider, which this
    // test environment does not have.
    const html = render(
      OpenCodeEditView,
      toolPart(
        "edit",
        { filePath: "src/a.ts", oldString: "BEFORE_TOKEN", newString: "AFTER_TOKEN" },
        nativeContent("Edit applied successfully."),
      ),
    );
    expect(html).toContain("edit · src/a.ts");
    expect(html).toContain("Edit applied successfully.");
    expect(html).not.toContain("undefined");
  });

  it("titles a write with the file path and renders the result", () => {
    const html = render(
      OpenCodeWriteToolUI,
      toolPart(
        "write",
        { filePath: "src/b.ts", content: "export const WRITTEN_MARKER = 1;" },
        nativeContent("Wrote file successfully."),
      ),
    );
    expect(html).toContain("write · src/b.ts");
    expect(html).toContain("Wrote file successfully.");
    expect(html).not.toContain("undefined");
  });

  it("shows the actual change in the approval card, not the model's find/replace pair", () => {
    // The preview belongs to the decision: it is what the user approves, and a
    // change that has NOT happened is precisely what a gate exists to ask about.
    //
    // This test previously asserted the opposite - that the gate must show the
    // find/replace pair and must NOT show a diff - on the reasoning that
    // "the user would be approving a change that has not happened yet". That had
    // it backwards. The find/replace pair omits the surrounding context, so it
    // cannot show whether the replacement lands where the author meant, which is
    // the thing a reviewer is actually judging.
    //
    // `pendingPatch` is what OpenCode computed BEFORE running the edit and sent
    // with the permission request. The payload below is the real shape, captured
    // from the live server.
    const html = render(
      OpenCodeEditView,
      {
        ...toolPart(
          "edit",
          { filePath: "src/a.ts", oldString: "BEFORE_TOKEN", newString: "AFTER_TOKEN" },
          undefined,
          {
            status: { type: "requires-action", reason: "interrupt" },
            approval: { id: "per_edit_1", options: [] },
          },
        ),
        pendingPatch:
          "Index: src/a.ts\n" +
          "===================================================================\n" +
          "--- src/a.ts\n" +
          "+++ src/a.ts\n" +
          "@@ -1,3 +1,3 @@\n" +
          " const before = 1;\n" +
          "-const target = BEFORE_TOKEN;\n" +
          "+const target = AFTER_TOKEN;\n" +
          " export { before };\n",
      },
    );
    // The resulting change, as a diff: the file, and both sides of it.
    expect(html).toContain("src/a.ts");
    expect(html).toContain("BEFORE_TOKEN");
    expect(html).toContain("AFTER_TOKEN");
    // The find/replace labels are what the diff replaces. If they survive here,
    // the reader is being shown the model's description alongside - rather than
    // instead of - the change.
    expect(html).not.toContain("Replace with:");
  });

  it("falls back to the find/replace pair when the server sends no patch", () => {
    // The fallback is load-bearing, not decoration: `metadata.files` is optional
    // on the wire, and a gate with no preview at all would be worse than one
    // showing what the model proposed. Also the path a `write` takes, which has
    // no patch by data.
    const html = render(
      OpenCodeEditView,
      {
        ...toolPart(
          "edit",
          { filePath: "src/a.ts", oldString: "BEFORE_TOKEN", newString: "AFTER_TOKEN" },
          undefined,
          {
            status: { type: "requires-action", reason: "interrupt" },
            approval: { id: "per_edit_1", options: [] },
          },
        ),
        pendingPatch: null,
      },
    );
    expect(html).toContain("edit · src/a.ts");
    expect(html).toContain("BEFORE_TOKEN");
    expect(html).toContain("AFTER_TOKEN");
    expect(html).toContain("Replace with:");
  });

  it("falls back when a patch arrives but is not parseable as a diff", () => {
    // A patch the diff parser cannot read must not leave the gate empty. This is
    // the same guard the completed card has: unparseable means "show what we
    // have", never "show nothing".
    const html = render(
      OpenCodeEditView,
      {
        ...toolPart(
          "edit",
          { filePath: "src/a.ts", oldString: "BEFORE_TOKEN", newString: "AFTER_TOKEN" },
          undefined,
          {
            status: { type: "requires-action", reason: "interrupt" },
            approval: { id: "per_edit_1", options: [] },
          },
        ),
        pendingPatch: "not a diff at all",
      },
    );
    expect(html).toContain("BEFORE_TOKEN");
    expect(html).toContain("Replace with:");
  });

  it("still shows the find/replace pair on a DECIDED edit, where the diff is the past", () => {
    // Two patches, two jobs. The one the server recorded after the edit ran
    // belongs to the completed card; the gate's own patch must not leak into it
    // as a second, competing preview.
    const html = render(
      OpenCodeEditView,
      {
        ...toolPart(
          "edit",
          { filePath: "src/a.ts", oldString: "BEFORE_TOKEN", newString: "AFTER_TOKEN" },
          "Edit applied successfully.",
          { status: { type: "complete" } },
        ),
        diffPatch:
          "--- src/a.ts\n+++ src/a.ts\n@@ -1,1 +1,1 @@\n-BEFORE_TOKEN\n+AFTER_TOKEN\n",
        pendingPatch:
          "--- src/a.ts\n+++ src/a.ts\n@@ -1,1 +1,1 @@\n-OLD_PREVIEW\n+NEW_PREVIEW\n",
      },
    );
    expect(html).toContain("BEFORE_TOKEN");
    expect(html).not.toContain("OLD_PREVIEW");
  });

  it("shows the file content in the write approval card", () => {
    const html = render(
      OpenCodeWriteToolUI,
      toolPart(
        "write",
        { filePath: "src/b.ts", content: "export const WRITTEN_MARKER = 1;" },
        undefined,
        {
          status: { type: "requires-action", reason: "interrupt" },
          approval: { id: "per_write_1", options: [] },
        },
      ),
    );
    expect(html).toContain("write · src/b.ts");
    expect(html).toContain("WRITTEN_MARKER");
  });
});

describe("OpenCode bash — terminal output and the gate", () => {
  it("renders completed output in the terminal block", () => {
    const html = render(
      OpenCodeBashToolUI,
      toolPart("bash", { command: "echo TERMINAL_CMD" }, nativeContent("TERMINAL_OUTPUT\n")),
    );
    // The official terminal block shows the command and its output lines.
    expect(html).toContain("TERMINAL_CMD");
    expect(html).toContain("TERMINAL_OUTPUT");
    expect(html).not.toContain("undefined");
  });

  it("titles the card with the command when there is no output yet", () => {
    const html = render(
      OpenCodeBashToolUI,
      toolPart("bash", { command: "sleep 5", workdir: "D:\\ws" }, undefined, {
        status: { type: "running" },
      }),
    );
    expect(html).toContain("bash · sleep 5");
    expect(html).toContain("Running…");
  });

  it("shows no output when the command produced none", () => {
    const html = render(
      OpenCodeBashToolUI,
      toolPart("bash", { command: "true" }, []),
    );
    expect(html).toContain("bash · true");
    expect(html).toContain(toolsConfig.copy.status.noOutput);
  });

  it("does not let the terminal fast-path swallow a FAILED call", () => {
    // This branch never goes through `BackendToolView`, so it never sees the
    // failure row. A part the runtime marked failed must reach the shared shell
    // instead, whatever its result happens to carry — the guard states the rule
    // rather than relying on the captured envelope having no `stdout`.
    const html = render(
      OpenCodeBashToolUI,
      toolPart("bash", { command: "bun --version" }, { stdout: "PARTIAL_OUTPUT" }, {
        isError: true,
      }),
    );
    expect(html).toContain("Failed");
    expect(html).not.toContain(toolsConfig.copy.status.noOutput);
  });

  it("renders an incomplete native V2 shell state as failed", () => {
    const html = render(
      OpenCodeBashToolUI,
      toolPart("shell", { command: "bun --version" }, undefined, {
        status: { type: "incomplete", reason: "Command failed" },
      }),
    );
    expect(html).toContain("Failed");
    expect(html).not.toContain("No output");
  });

  it("does not let the terminal fast-path replace a gate awaiting an answer", () => {
    // The hazard this guards: `bash` renders the terminal directly when output
    // exists, which would skip `BackendToolView` — and with it the approval
    // gate — on the one tool where the gate matters most. A part can legitimately
    // hold both an outstanding permission and output (e.g. a re-run), so the
    // gate must win.
    const html = render(
      OpenCodeBashToolUI,
      toolPart("bash", { command: "rm -rf build" }, nativeContent("GATED_OUTPUT"), {
        approval: { id: "per_bash_1", options: [] },
      }),
    );
    expect(html).toContain("Approve");
    expect(html).not.toContain("GATED_OUTPUT");
  });

  it("renders the linked approval gate for the observed V2 shell name", () => {
    const html = render(
      OpenCodeBashToolUI,
      toolPart("shell", { command: "bun --version" }, undefined, {
        approval: { id: "per_shell_1", options: [] },
      }),
    );
    expect(html).toContain("shell · bun --version");
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
  });

  it("does not let the terminal fast-path replace a closed-gate message", () => {
    // `resolution` set means the request is gone. The gate renders a closed-gate
    // card for it — the "Closed" badge is the at-rest signal (the explanatory
    // text sits inside a collapsed region) — so the fast-path must yield here
    // too, not just in the awaiting case.
    const html = render(
      OpenCodeBashToolUI,
      toolPart("bash", { command: "rm -rf build" }, nativeContent("STALE_OUTPUT"), {
        approval: { id: "per_bash_2", options: [], resolution: "expired" },
      }),
    );
    expect(html).toContain("Closed");
    expect(html).toContain("bash · rm -rf build");
    expect(html).not.toContain("STALE_OUTPUT");
  });
});

/**
 * Phase 4 — an `edit` renders as a DIFF.
 *
 * The patch does not come from the result: native V2 keeps the completed text
 * in a content array, while the patch lives in `state.metadata.files[].patch`.
 * These tests cover the render half — given a patch, the card shows a diff
 * instead of the completion text.
 *
 * The patch below is a REAL one recorded by OpenCode, including its git-style
 * `Index:` / `===` header, because that header is exactly what a naive parser
 * would choke on.
 */
const REAL_EDIT_PATCH =
  "Index: D:\\ws\\notes.txt\n" +
  "===================================================================\n" +
  "--- D:\\ws\\notes.txt\n" +
  "+++ D:\\ws\\notes.txt\n" +
  "@@ -10,4 +10,6 @@\n" +
  ' - "obj/**"\n' +
  ' - "bin/**"\n' +
  '+- "ADDED_BY_EDIT/**"\n' +
  '+- "ALSO_ADDED/**"\n';

describe("OpenCode question — read-only history rendering", () => {
  it("registers the observed V2 shell name with the same terminal renderer", () => {
    expect(openCodeToolkit.shell).toEqual(openCodeToolkit.bash);
  });

  it("the question tool renders its read-only fallback preview", () => {
    // With no linked question, `OpenCodeQuestionToolUI` falls back to the
    // read-only view, which is the hook-free branch and static-renderable.
    // The argPreview (question text + option list) shows once the part is no
    // longer running, so assert against a completed part.
    const html = render(
      QuestionReadonlyView,
      toolPart(
        "question",
        { questions: [{ question: "Which file should we edit?", options: [{ label: "a.ts" }] }] },
        nativeContent("answered: a.ts"),
      ),
    );
    expect(html).toContain("Which file should we edit?");
    expect(html).toContain("a.ts");
    expect(html).not.toContain("undefined");
  });
});

/* -------------------------------------------------------------------------
 * THE ANSWER, on a REAL answered `question` part.
 *
 * The card used to end at the question: once the reader answered, the questions
 * panel vanished and the in-message card showed only the result text, so what
 * was chosen was never readable. The answer is on the COMPLETED part's own
 * `state.metadata.answers` — `[["Postgres"]]` in the capture below — which is
 * what a reloaded history returns, so it does not depend on a live event.
 *
 * Every payload here is verbatim from the session named in
 * `@/testing/question-payloads`; nothing is invented.
 * ---------------------------------------------------------------------- */

/** A completed part shaped from the captured one, with the given answers. */
const answeredQuestion = (answers: readonly (readonly string[])[] | null) =>
  toolPart(
    "question",
    capturedQuestionPart.state.input,
    capturedQuestionContent,
    { answers },
  );

/**
 * A question still waiting on an answer.
 *
 * `toolPart` gives every part `status: { type: "complete" }`, which is right for
 * a settled tool and wrong for an open question. An open one is still `running`,
 * and telling the two apart is the entire subject of the card's three states —
 * so the open case gets its own shape rather than relying on the default.
 */
const openQuestion = {
  ...answeredQuestion(null),
  status: { type: "running", isArgsComplete: true },
} as const;

describe("OpenCode question — the answer is on the card once it is given", () => {
  it("shows the answer the reader gave, from the completed part's own metadata", () => {
    const html = render(QuestionReadonlyView, answeredQuestion(capturedQuestionPart.state.metadata.answers));
    expect(html).toContain(toolsConfig.copy.status.yourAnswer);
    expect(html).toContain("Postgres");
  });

  it("shows the question and the reason the answer was chosen, not a menu of alternatives", () => {
    // The settled card is a RECEIPT, not a re-drawn picker. It answers "what
    // did I pick and why" — so the chosen option's description follows the
    // answer. Re-listing all three options with one highlighted turned the
    // receipt back into a menu, which is what the open card must never be.
    const html = render(QuestionReadonlyView, answeredQuestion(capturedQuestionPart.state.metadata.answers));
    expect(html).toContain("Which database should you use?");
    expect(html).toContain("Database choice");
    expect(html).toContain("Postgres");
    // The captured Postgres option's own description, verbatim from the payload.
    expect(html).toContain("a full relational database server");
    // No option list survives on the settled card.
    expect(html).not.toContain("· SQLite");
    expect(html).not.toContain("<ul");
  });

  it("prints NO options while the question is open, so nothing looks clickable", () => {
    // THE dead end this card used to have: it listed three options as `· label`
    // bullets and had no controls, then told the reader to answer elsewhere. A
    // reader whose eye is on the card must not be invited to click it. The live
    // capture is the widest shape this can take — a header, a question, three
    // described options — and none of it may render as an option list.
    const html = render(QuestionReadonlyView, openQuestion);
    expect(html).toContain("Which database should you use?");
    expect(html).not.toContain("· SQLite");
    expect(html).not.toContain("· Postgres");
    expect(html).not.toContain("<ul");
    // Not even the descriptions the options carried.
    expect(html).not.toContain("a full relational database server");
  });

  it("points an OPEN question at the dock", () => {
    const html = render(QuestionReadonlyView, openQuestion);
    expect(html).toContain(toolsConfig.copy.status.answerInQuestionDock);
  });

  it("never points a DISMISSED question at the dock", () => {
    // The dead end, reached by cancelling instead of by reading. A cancelled
    // question has no `answers`, so the card used to read it as still open and
    // send the reader to a dock that was never coming back.
    //
    // Asserted on the ERRORED part, because that is what a dismissal is on the
    // wire: the server reports it as `error`, so `isError` is the only signal
    // available. Note the card renders an errored part as a collapsed row, so
    // the badge is asserted alongside the absence of the pointer — without it
    // this test would pass merely because the body is hidden, which proves
    // nothing.
    const dismissed = render(QuestionReadonlyView, { ...openQuestion, isError: true });
    expect(dismissed).toContain("Failed");
    expect(dismissed).not.toContain(toolsConfig.copy.status.answerInQuestionDock);
    expect(dismissed).not.toContain(toolsConfig.copy.status.yourAnswer);
  });

  it("says the question is closed when it completed with no answer", () => {
    // The one settled shape that DOES render its body: a part that completed
    // but carries no `answers`. There is nothing to point at, so it says so.
    const closed = render(QuestionReadonlyView, {
      ...openQuestion,
      status: { type: "complete" } as never,
    });
    expect(closed).toContain(toolsConfig.copy.status.questionClosedNoAnswer);
    expect(closed).not.toContain(toolsConfig.copy.status.answerInQuestionDock);
    expect(closed).not.toContain(toolsConfig.copy.status.yourAnswer);
  });

  it("never points a question with no status at the dock", () => {
    // Fail-safe direction: a part whose status cannot be read is treated as
    // settled. Silence is recoverable; sending someone to a dock that is not
    // there is the bug this whole card was rebuilt to stop.
    const html = render(QuestionReadonlyView, { ...openQuestion, status: undefined });
    expect(html).not.toContain(toolsConfig.copy.status.answerInQuestionDock);
  });

  it("points at the dock only while the part is genuinely live", () => {
    // `running` and `requires-action` both mean a form exists and can be
    // answered, so both get the pointer. `complete` and `incomplete` do not.
    for (const type of ["running", "requires-action"] as const) {
      const html = render(QuestionReadonlyView, { ...openQuestion, status: { type } as never });
      expect(html).toContain(toolsConfig.copy.status.answerInQuestionDock);
    }
    for (const type of ["complete", "incomplete"] as const) {
      const html = render(QuestionReadonlyView, { ...openQuestion, status: { type } as never });
      expect(html).not.toContain(toolsConfig.copy.status.answerInQuestionDock);
    }
  });

  it("shows no answer while the question is still open", () => {
    // The answer block must not be inferred from the result text, or an open
    // question would claim one.
    const html = render(QuestionReadonlyView, openQuestion);
    expect(html).not.toContain(toolsConfig.copy.status.yourAnswer);
  });

  it("points an open question at the dock, never at a card that is not there", () => {
    // The old copy said "Answer it on the question card above." This surface
    // has no such card, and the copy before that pointed at a panel above the
    // TRANSCRIPT — which is where the dock used to live. It is now directly
    // above the composer, and the caption must name that place.
    const html = render(QuestionReadonlyView, openQuestion);
    expect(html).toContain("just above the text field");
    expect(html).not.toContain("question card above");
    expect(html).not.toContain("above the transcript");
  });

  it("drops the open-question caption once there is an answer", () => {
    const html = render(QuestionReadonlyView, answeredQuestion(capturedQuestionPart.state.metadata.answers));
    expect(html).not.toContain(toolsConfig.copy.status.answerInQuestionDock);
  });

  it("renders the answer from a RELOADED history, where no event ever fires", () => {
    // Non-vacuity: the payload is read out of the raw part array the history
    // projection attaches, which is the only thing a reloaded conversation has.
    const answers = openCodeQuestionAnswersFromParts(capturedQuestionRawParts, `tbai-v2-tool:msg_1:${encodeURIComponent(CAPTURED_QUESTION_PART_ID)}`);
    expect(answers).toEqual([["Postgres"]]);
    const html = render(QuestionReadonlyView, answeredQuestion(answers));
    expect(html).toContain("Postgres");
    expect(html).toContain(toolsConfig.copy.status.yourAnswer);
  });

  it("reports no answers for a still-running part and for no part at all", () => {
    const callId = `tbai-v2-tool:msg_1:${encodeURIComponent(CAPTURED_QUESTION_PART_ID)}`;
    expect(openCodeQuestionAnswersFromParts([capturedPendingQuestionPart], callId)).toBeNull();
    expect(openCodeQuestionAnswersFromParts(capturedQuestionRawParts, "tbai-v2-tool:msg_1:other")).toBeNull();
    expect(openCodeQuestionAnswersFromParts(undefined, callId)).toBeNull();
  });

  it("ignores an `answers` value that is not the captured shape", () => {
    // `Form.Answer` is a keyed map, so an object here is a real possibility
    // from another producer — and it must not render as `undefined`.
    const callId = `tbai-v2-tool:msg_1:${encodeURIComponent(CAPTURED_QUESTION_PART_ID)}`;
    for (const answers of [["Postgres"], [{ q0: "Postgres" }], [null], "Postgres"]) {
      const parts = [{ ...capturedQuestionPart, state: { ...capturedQuestionPart.state, metadata: { answers } } }];
      expect(openCodeQuestionAnswersFromParts(parts, callId), JSON.stringify(answers)).toBeNull();
    }
  });
});

describe("OpenCode edit — the patch renders as a diff", () => {
  it("shows the diff instead of native completion text", () => {
    const html = render(OpenCodeEditView, {
      ...toolPart(
        "edit",
        { filePath: "src/a.ts", oldString: "x", newString: "y" },
        nativeContent("Edit applied successfully."),
      ),
      diffPatch: REAL_EDIT_PATCH,
    });
    // The added lines are visible...
    expect(html).toContain("ADDED_BY_EDIT");
    expect(html).toContain("ALSO_ADDED");
    // ...and the useless "applied successfully" string is gone.
    expect(html).not.toContain("Edit applied successfully.");
    expect(html).not.toContain("undefined");
  });

  it("parses the git-style header rather than dumping it as text", () => {
    // A parser that failed on `Index:` would fall back to showing the raw patch,
    // header and all. The `===` rule must not survive into the rendered diff.
    const html = render(OpenCodeEditView, {
      ...toolPart("edit", { filePath: "src/a.ts" }, nativeContent("Edit applied successfully.")),
      diffPatch: REAL_EDIT_PATCH,
    });
    expect(html).not.toContain("======");
    expect(html).not.toContain("@@ -10,4 +10,6 @@");
  });

  it("keeps the title from the file path, not from the patch header", () => {
    const html = render(OpenCodeEditView, {
      ...toolPart("edit", { filePath: "src/a.ts" }, nativeContent("Edit applied successfully.")),
      diffPatch: REAL_EDIT_PATCH,
    });
    expect(html).toContain("edit · src/a.ts");
  });

  it("falls back to native completion text when there is no patch", () => {
    // Every `write` part lands here by data: a whole-file write has nothing to
    // diff against, so OpenCode records no patch for it.
    const html = render(OpenCodeEditView, {
      ...toolPart("edit", { filePath: "src/a.ts" }, nativeContent("Edit applied successfully.")),
      diffPatch: null,
    });
    expect(html).toContain("Edit applied successfully.");
  });
});

/* -------------------------------------------------------------------------
 * The body path, driven by a REAL V2 result.
 *
 * The result text below is verbatim from a live OpenCode session, read through
 * `GET /api/opencode/session/<id>/message`, and it is passed in the shape the
 * runtime actually uses: the bare `[ToolContent, ...]` array.
 *
 * The bug these cover: normalization collapses that array to a plain string
 * (or to `{ content }` / `{ stdout }`), the shared extractor recognised only
 * arrays, so every renderer that reads the body afterwards got `null` and
 * printed "No output." for a tool that had returned data. `bash` hid it with
 * its own terminal branch — which is why only `grep` was reported live.
 * ---------------------------------------------------------------------- */

const REAL_GREP_TEXT =
  "Found 12 matches\n" +
  "D:\\Temp\\ai-chat-app\\web\\src\\components\\shared\\QuestionFormCard.tsx:\n" +
  "  Line 39:  * - Actions: Dismiss, Back, Next, Submit. (No approval/permission metaphors).\n";

const REAL_READ_TEXT =
  "Read file D:\\Temp\\ai-chat-app\\package.json, lines 1-47\n" +
  "1: {\n" +
  "2:   \"name\": \"tbai\",\n";

/** Every renderer that renders its body through the shared helper. */
const BODY_RENDERERS = [
  ["read", OpenCodeReadToolUI, { filePath: "D:\\Temp\\ai-chat-app\\package.json" }],
  ["glob", OpenCodeGlobToolUI, { pattern: "**/*.tsx" }],
  ["grep", OpenCodeGrepToolUI, { pattern: "approval", path: "D:\\Temp\\ai-chat-app\\web\\src" }],
  ["write", OpenCodeWriteToolUI, { filePath: "D:\\ws\\b.ts", content: "x" }],
  ["task", OpenCodeTaskToolUI, { description: "d", prompt: "p", subagent_type: "general" }],
  ["webfetch", OpenCodeWebFetchToolUI, { url: "https://example.com" }],
  ["skill", OpenCodeSkillToolUI, { name: "brainstorming" }],
  ["question", QuestionReadonlyView, { questions: [{ question: "postgres or sqlite?" }] }],
] as const;

describe("OpenCode bodies — a real V2 result is rendered, not replaced by 'No output.'", () => {
  for (const [tool, UI, args] of BODY_RENDERERS) {
    it(`${tool} renders the matches of a real content array`, () => {
      const html = render(UI, toolPart(tool, args, nativeContent(REAL_GREP_TEXT)));
      expect(html, tool).toContain("Found 12 matches");
      expect(html, tool).not.toContain("No output.");
    });
  }

  it("grep shows the matched file and line, as OpenCode reported them", () => {
    const html = render(
      OpenCodeGrepToolUI,
      toolPart("grep", { pattern: "approval", path: "D:\\Temp\\ai-chat-app\\web\\src" }, nativeContent(REAL_GREP_TEXT)),
    );
    expect(html).toContain("grep · approval");
    expect(html).toContain("QuestionFormCard.tsx");
    expect(html).toContain("Line 39");
  });

  it("read shows the file text through its `{ content }` shape", () => {
    const html = render(
      OpenCodeReadToolUI,
      completedRead({ filePath: "D:\\Temp\\ai-chat-app\\package.json" }, nativeContent(REAL_READ_TEXT)),
    );
    expect(html).toContain("Read file D:\\Temp\\ai-chat-app\\package.json, lines 1-47");
    expect(html).toContain("&quot;name&quot;: &quot;tbai&quot;");
    expect(html).not.toContain("No output.");
  });

  it("bash still reaches its own terminal branch, not this fallback", () => {
    // `bash` escapes the shared body by design: it renders `TerminalBlock`
    // directly, so the shared helper is never the thing that has to work.
    const html = render(
      OpenCodeBashToolUI,
      toolPart("bash", { command: "echo hi" }, nativeContent("hi\n")),
    );
    expect(html).toContain("hi");
    expect(html).not.toContain("No output.");
  });

  it("still says 'No output.' when the tool really returned nothing", () => {
    // The empty state must survive the fix: an empty result is not a result.
    for (const value of [[], "", null, { content: [] }]) {
      const html = render(
        OpenCodeGrepToolUI,
        toolPart("grep", { pattern: "approval" }, value),
      );
      expect(html, JSON.stringify(value)).toContain("No output.");
    }
  });
});
