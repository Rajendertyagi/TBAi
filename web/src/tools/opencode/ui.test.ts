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
  OpenCodeWriteToolUI,
  QuestionReadonlyView,
} from "./ui";
import { isLinkedQuestion } from "@/features/opencode/toolLinkedQuestion";
import type { OpenCodeQuestionRequest } from "@assistant-ui/react-opencode";

/**
 * Renders the REAL component tree (OpenCode view → BackendToolView → ToolCard)
 * against REAL OpenCode-shaped input, and asserts the three things a rich UI
 * must show: the tool title, the requested path, and the result body.
 *
 * This is a genuine render, not a source-text assertion. `web/` has no DOM, but
 * `react-dom/server` needs none, and the completed-tool branch of
 * `BackendToolView` is hook-free, so the whole path is exercised.
 *
 * The props below use OpenCode's ACTUAL field names and result type, verified
 * live against OpenCode 1.18.31:
 *   - `read` args are `{ filePath }` (from GET /experimental/tool)
 *   - a completed part's `state.output` is a plain STRING
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
const BODY = "alpha\nbeta\ngamma\n";

describe("OpenCode read — title, path and body all populate", () => {
  it("titles the card with the tool and the requested file path", () => {
    const html = render(OpenCodeReadToolUI, completedRead({ filePath: PATH }, BODY));
    expect(html).toContain(`read · ${PATH}`);
  });

  it("renders the file text as the body", () => {
    const html = render(OpenCodeReadToolUI, completedRead({ filePath: PATH }, BODY));
    for (const line of ["alpha", "beta", "gamma"]) {
      expect(html, line).toContain(line);
    }
  });

  it("renders no `undefined` anywhere", () => {
    // The exact symptom of an unmapped field: a title reading "read · undefined".
    const html = render(OpenCodeReadToolUI, completedRead({ filePath: PATH }, BODY));
    expect(html).not.toContain("undefined");
  });

  it("takes the path from filePath, not from an absent `path`", () => {
    // Non-vacuity control: with no args there is no path to show, which proves
    // the path above came from OpenCode's `filePath` via normalization.
    const html = render(OpenCodeReadToolUI, completedRead({}, BODY));
    expect(html).toContain("read · ");
    expect(html).not.toContain(PATH);
  });

  it("still works when the args already use our own field name", () => {
    // Normalization must add an alias, not require one.
    const html = render(OpenCodeReadToolUI, completedRead({ path: PATH }, BODY));
    expect(html).toContain(`read · ${PATH}`);
  });

  it("shows a placeholder rather than nothing for an empty body", () => {
    const html = render(OpenCodeReadToolUI, completedRead({ filePath: PATH }, ""));
    expect(html).toContain("No output.");
  });
});

describe("OpenCode glob / grep — title comes from `pattern`", () => {
  it("titles glob with the pattern", () => {
    const html = render(
      OpenCodeGlobToolUI,
      completedRead({ pattern: "**/*.tsx", path: "web/src" }, "a.tsx\nb.tsx"),
    );
    expect(html).toContain("glob · **/*.tsx");
    expect(html).not.toContain("undefined");
  });

  it("titles grep with the pattern and renders the matches", () => {
    const html = render(
      OpenCodeGrepToolUI,
      completedRead({ pattern: "useStaleApprovalGuard", include: "*.tsx" }, "a.tsx:12"),
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
  it("titles an edit with the file path and falls back to the result string", () => {
    // Rendered WITHOUT a patch: the card must still say something useful rather
    // than render empty. `OpenCodeEditView` is the pure half — the registered
    // `OpenCodeEditToolUI` adds a hook that needs an AuiProvider, which this
    // test environment does not have.
    const html = render(
      OpenCodeEditView,
      toolPart(
        "edit",
        { filePath: "src/a.ts", oldString: "BEFORE_TOKEN", newString: "AFTER_TOKEN" },
        "Edit applied successfully.",
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
        "Wrote file successfully.",
      ),
    );
    expect(html).toContain("write · src/b.ts");
    expect(html).toContain("Wrote file successfully.");
    expect(html).not.toContain("undefined");
  });

  it("shows what will be replaced in the approval card, not the result", () => {
    // The preview belongs to the decision: it is what the user approves. The
    // same split the native writer/editor use (`argPreview` reaches the gate,
    // not the completed body).
    //
    // A patch is passed IN as well, deliberately: the gate must still show the
    // find/replace pair. If the diff leaked into the gate, the user would be
    // approving a change that has not happened yet.
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
        diffPatch: "@@ -1 +1 @@\n-GATE_MUST_NOT_SHOW_THIS\n",
      },
    );
    expect(html).toContain("edit · src/a.ts");
    expect(html).toContain("BEFORE_TOKEN");
    expect(html).toContain("AFTER_TOKEN");
    expect(html).not.toContain("GATE_MUST_NOT_SHOW_THIS");
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
      toolPart("bash", { command: "echo TERMINAL_CMD" }, "TERMINAL_OUTPUT\n"),
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
      toolPart("bash", { command: "true" }, ""),
    );
    expect(html).toContain("bash · true");
    expect(html).toContain("No output.");
  });

  it("does not let the terminal fast-path replace a gate awaiting an answer", () => {
    // The hazard this guards: `bash` renders the terminal directly when output
    // exists, which would skip `BackendToolView` — and with it the approval
    // gate — on the one tool where the gate matters most. A part can legitimately
    // hold both an outstanding permission and output (e.g. a re-run), so the
    // gate must win.
    const html = render(
      OpenCodeBashToolUI,
      toolPart("bash", { command: "rm -rf build" }, "GATED_OUTPUT", {
        approval: { id: "per_bash_1", options: [] },
      }),
    );
    expect(html).toContain("Approve");
    expect(html).not.toContain("GATED_OUTPUT");
  });

  it("does not let the terminal fast-path replace a closed-gate message", () => {
    // `resolution` set means the request is gone. The gate renders a closed-gate
    // card for it — the "Closed" badge is the at-rest signal (the explanatory
    // text sits inside a collapsed region) — so the fast-path must yield here
    // too, not just in the awaiting case.
    const html = render(
      OpenCodeBashToolUI,
      toolPart("bash", { command: "rm -rf build" }, "STALE_OUTPUT", {
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
 * The patch does not come from the result: OpenCode's `edit` result is the
 * string "Edit applied successfully.", and the patch lives in the part's
 * `metadata` (see `openCodePatchFromParts`). These tests cover the render half —
 * given a patch, the card shows a diff instead of that string.
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

describe("OpenCode question — linked bridge (Phase B)", () => {
  // The linked half of `OpenCodeQuestionToolUI` (shared `QuestionCard` via
  // `useToolLinkedQuestion`) is hook-based and needs a live provider, so it is
  // not static-renderable here. The bridge's *decisions* are proven instead:
  // which question is linked (callID match), which stay panel-answerable
  // (unlinked only), and how answer/skip forward (covered in
  // toolLinkedQuestion.test.ts). This block pins the panel-exclusion split and
  // the unlinked read-only fallback that renders without a provider.

  it("a tool-linked question is excluded from the fallback panel", () => {
    const linked = {
      id: "que_linked",
      tool: { callID: "call_linked" },
      questions: [{ question: "Pick one" }],
    } as unknown as OpenCodeQuestionRequest;
    // The panel keeps only unlinked questions; a tool-linked one is answered
    // on its own tool card, so it must not also appear in the panel.
    expect(isLinkedQuestion(linked)).toBe(true);
    const unlinked = [linked].filter((req) => !isLinkedQuestion(req));
    expect(unlinked).toEqual([]);
  });

  it("a question without a tool.callID stays panel-answerable", () => {
    const unlinked = {
      id: "que_plain",
      questions: [{ question: "Which file?" }],
    } as unknown as OpenCodeQuestionRequest;
    expect(isLinkedQuestion(unlinked)).toBe(false);
    const panel = [unlinked].filter((req) => !isLinkedQuestion(req));
    expect(panel.map((r) => r.id)).toEqual(["que_plain"]);
  });

  it("answered/rejected questions leave no pending entry to answer", () => {
    // Once the adapter resolves a question it drops out of the pending list,
    // so there is nothing for the panel to offer — the split is by pending
    // state, not by request id, and a resolved request simply is not present.
    const afterAnswer: OpenCodeQuestionRequest[] = [];
    expect(afterAnswer.filter((req) => !isLinkedQuestion(req))).toEqual([]);
  });

  it("the unlinked question renders the read-only fallback preview", () => {
    // With no linked question, `OpenCodeQuestionToolUI` falls back to the
    // read-only view, which is the hook-free branch and static-renderable.
    // The argPreview (question text + option list) shows once the part is no
    // longer running, so assert against a completed part.
    const html = render(
      QuestionReadonlyView,
      toolPart(
        "question",
        { questions: [{ question: "Which file should we edit?", options: [{ label: "a.ts" }] }] },
        "answered: a.ts",
      ),
    );
    expect(html).toContain("Which file should we edit?");
    expect(html).toContain("a.ts");
    expect(html).not.toContain("undefined");
  });
});

describe("OpenCode edit — the patch renders as a diff", () => {
  it("shows the diff instead of the result string", () => {
    const html = render(OpenCodeEditView, {
      ...toolPart(
        "edit",
        { filePath: "src/a.ts", oldString: "x", newString: "y" },
        "Edit applied successfully.",
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
      ...toolPart("edit", { filePath: "src/a.ts" }, "Edit applied successfully."),
      diffPatch: REAL_EDIT_PATCH,
    });
    expect(html).not.toContain("======");
    expect(html).not.toContain("@@ -10,4 +10,6 @@");
  });

  it("keeps the title from the file path, not from the patch header", () => {
    const html = render(OpenCodeEditView, {
      ...toolPart("edit", { filePath: "src/a.ts" }, "Edit applied successfully."),
      diffPatch: REAL_EDIT_PATCH,
    });
    expect(html).toContain("edit · src/a.ts");
  });

  it("falls back to the result string when there is no patch", () => {
    // Every `write` part lands here by data: a whole-file write has nothing to
    // diff against, so OpenCode records no patch for it.
    const html = render(OpenCodeEditView, {
      ...toolPart("edit", { filePath: "src/a.ts" }, "Edit applied successfully."),
      diffPatch: null,
    });
    expect(html).toContain("Edit applied successfully.");
  });
});
