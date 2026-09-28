import { describe, it, expect } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { classifyOpenCodeResultBody } from "./adapt";
import { OpenCodeReadToolUI } from "./ui";
import { failureCopyOf } from "@/tools/filesystem/ui";
import { toolsConfig } from "@/config/tools";
import {
  capturedBinaryReadContent,
  capturedEditErrorPart,
  capturedErrorEnvelopeOutput,
  capturedReadCompletedContent,
  capturedReadErrorPart,
  capturedWebFetchErrorOutput,
  capturedWebFetchErrorPart,
} from "@/testing/tool-result-payloads";

/**
 * A failed tool and an empty tool must not look the same.
 *
 * ## What changed
 *
 * `TextBody` printed `noOutput` whenever the text extractor returned nothing.
 * That conflated two facts:
 *
 *   - the tool ran and produced nothing → "No output." is honest;
 *   - the tool produced something the renderer cannot decode → "No output." is
 *     a lie about the tool and a silent failure about the card.
 *
 * Every one of the 40 `error` parts in the live store has the shape
 * `{ status:"error", input, error:{type,message} }` with NO `content` key, and
 * the projection hands the card `{ error, type }` (see
 * `@/testing/tool-result-payloads` for the capture and the counts). That
 * envelope has no text field, so the text-only extractor returned `null` for it
 * and a FAILED read rendered as "No output." with no failure marker.
 *
 * Two changes close it, each asserted below against a real payload:
 *
 *   1. `classifyOpenCodeResultBody` (in `adapt.ts`) tells "empty" apart from
 *      "unreadable", and `ResultBody` labels them differently.
 *   2. `BackendToolView` takes the part's `isError` — the runtime's own verdict
 *      — so a failure is a failure even with no readable `error` string.
 */

function render(
  UI: ToolCallMessagePartComponent,
  props: Record<string, unknown>,
): string {
  const Any = UI as unknown as (p: Record<string, unknown>) => ReactElement;
  return renderToStaticMarkup(createElement(Any, props));
}

/** A settled part in the native V2 shape, with the runtime's `isError` set. */
const part = (
  result: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "tool-call",
  toolCallId: "call_1",
  toolName: "read",
  args: { filePath: "D:\\ws\\notes.txt" },
  argsText: JSON.stringify({ filePath: "D:\\ws\\notes.txt" }),
  result,
  status: { type: "complete" },
  ...extra,
});

/* -------------------------------------------------------------------------
 * 1. The decoder: three outcomes, not two.
 * ---------------------------------------------------------------------- */
describe("classifyOpenCodeResultBody — empty is not the same as unreadable", () => {
  it("reads a completed read's native content array as text", () => {
    // REAL: `capturedReadCompletedContent` is verbatim from a completed `read`.
    const body = classifyOpenCodeResultBody(capturedReadCompletedContent);
    expect(body.kind).toBe("text");
    expect(body.kind === "text" && body.text).toContain("alpha");
  });

  it("reads a completed read of a BINARY file as text, via the file part's name", () => {
    // REAL: the 35 `file` items in the store are all `read` of an image. This
    // guards against classifying "not a text part" as unreadable — the card CAN
    // say something true about it, and did before this change.
    const body = classifyOpenCodeResultBody(capturedBinaryReadContent);
    expect(body.kind).toBe("text");
    expect(body.kind === "text" && body.text).toContain(
      "causeC-2-answer-on-card.jpg",
    );
  });

  it("calls a genuinely empty result empty", () => {
    // Shapes the store never produced (no completed part had an empty
    // `content`), so the empty branch needs its own cases.
    expect(classifyOpenCodeResultBody([]).kind).toBe("empty");
    expect(classifyOpenCodeResultBody("").kind).toBe("empty");
    expect(classifyOpenCodeResultBody("   \n ").kind).toBe("empty");
    expect(classifyOpenCodeResultBody(null).kind).toBe("empty");
    expect(classifyOpenCodeResultBody(undefined).kind).toBe("empty");
    expect(classifyOpenCodeResultBody({ content: "" }).kind).toBe("empty");
  });

  it("calls a FAILED result unreadable, not empty — this is the reported defect", () => {
    // REAL: `{ error, type }` is exactly what `v2History`/`v2Events` build for
    // the 40 error parts, none of which carried a `content` key.
    expect(classifyOpenCodeResultBody(capturedErrorEnvelopeOutput).kind).toBe(
      "unreadable",
    );
    expect(classifyOpenCodeResultBody(capturedWebFetchErrorOutput).kind).toBe(
      "unreadable",
    );
  });

  it("calls a content array of unknown parts unreadable", () => {
    // Present, non-empty, and not decodable — a different case from the empty
    // array above, which is why the two cannot share one branch.
    expect(classifyOpenCodeResultBody([{ type: "image", blob: "…" }]).kind).toBe(
      "unreadable",
    );
    expect(classifyOpenCodeResultBody({ content: 42 }).kind).toBe("unreadable");
  });
});

/* -------------------------------------------------------------------------
 * 2. The card: a failure never renders as "No output."
 *
 * The BADGE is asserted from the rendered markup; the REASON is asserted from
 * `failureCopyOf`, because the reason lives inside a collapsed
 * `CollapsedDecisionRow` whose content Radix does not emit to static markup.
 * Both halves of the same decision are covered, neither vacuously.
 * ---------------------------------------------------------------------- */
describe("a failed read shows a failure marker, never 'No output.'", () => {
  it("renders the failure badge for the captured read error", () => {
    // REAL state: `capturedReadErrorPart` — `status:"error"`, no `content`,
    // `error.type: "tool.execution"`.
    const html = render(
      OpenCodeReadToolUI,
      part(capturedErrorEnvelopeOutput, { isError: true }),
    );
    expect(html).toContain("Failed");
    // The defect's exact symptom.
    expect(html).not.toContain(toolsConfig.copy.status.noOutput);
    expect(html).not.toContain(toolsConfig.copy.status.resultUnreadable);
  });

  it("reports the server's own reason for that failure, verbatim", () => {
    const failed = failureCopyOf(capturedErrorEnvelopeOutput, true);
    expect(failed?.reason).toBe(capturedReadErrorPart.state.error.message);
    expect(failed?.copy).toContain(capturedReadErrorPart.state.error.message);
  });

  it("does the same for the captured webfetch failure, whose error.type differs", () => {
    // REAL: `error.type: "unknown"`. Pinned so nothing can start branching on
    // the type field, which carries no usable distinction.
    const html = render(
      OpenCodeReadToolUI,
      part(capturedWebFetchErrorOutput, { isError: true }),
    );
    expect(html).toContain("Failed");
    expect(html).not.toContain(toolsConfig.copy.status.noOutput);

    const failed = failureCopyOf(capturedWebFetchErrorOutput, true);
    expect(failed?.reason).toBe(capturedWebFetchErrorPart.state.error.message);
  });

  it("still fails a part the runtime marked error but gave no readable reason", () => {
    // The case the `isError` prop exists for. `isError` is the runtime's own
    // verdict (set by `v2MessageProjection` for `status === "error"`), so a
    // part it called failed is a failure — with or without a readable `error`.
    // Before this, `failureOf` was the only signal, and such a part fell
    // through to the success body.
    const html = render(
      OpenCodeReadToolUI,
      part({ nothing: "useful" }, { isError: true }),
    );
    expect(html).toContain("Failed");
    expect(html).not.toContain(toolsConfig.copy.status.noOutput);

    const failed = failureCopyOf({ nothing: "useful" }, true);
    expect(failed?.reason).toBeNull();
    expect(failed?.copy).toBe(toolsConfig.copy.status.failedWithoutReason);
  });

  it("does not invent a failure for a part the runtime did not mark error", () => {
    // The other direction, so the guard above cannot be satisfied by making
    // every unreadable result a failure: an undecodable result on a part the
    // runtime called SUCCESSFUL is a card problem, not a tool failure. It must
    // say the card could not display it, and must not claim a failure that did
    // not happen.
    const html = render(OpenCodeReadToolUI, part({ nothing: "useful" }));
    expect(html).not.toContain("Failed");
    expect(html).toContain(toolsConfig.copy.status.resultUnreadable);
    expect(html).not.toContain(toolsConfig.copy.status.noOutput);

    expect(failureCopyOf({ nothing: "useful" }, false)).toBeNull();
  });

  it("still reads a readable `error` when the runtime set no isError flag", () => {
    // A denial reloaded from pruned history arrives exactly this way: the
    // result keeps its `error` string, the approval marker is gone, and
    // `denialOf` has already declined to call it a denial. It is still a
    // failure, so `isError` must not have become the ONLY signal.
    const failed = failureCopyOf(
      { error: "Execution failed before the tool ran." },
      false,
    );
    expect(failed?.reason).toBe("Execution failed before the tool ran.");
  });
});

/* -------------------------------------------------------------------------
 * 3. The card: a genuinely empty result still says so.
 * ---------------------------------------------------------------------- */
describe("a genuinely empty result still says 'No output.'", () => {
  it("keeps the honest empty state for a completed read with no content", () => {
    const html = render(OpenCodeReadToolUI, part([]));
    expect(html).toContain(toolsConfig.copy.status.noOutput);
    expect(html).not.toContain("Failed");
    expect(html).not.toContain(toolsConfig.copy.status.resultUnreadable);
  });

  it("keeps it for an empty string result", () => {
    const html = render(OpenCodeReadToolUI, part(""));
    expect(html).toContain(toolsConfig.copy.status.noOutput);
    expect(html).not.toContain("Failed");
  });

  it("still paints real output unchanged", () => {
    // Non-vacuity: the guards above would also pass if the card refused to
    // render a body at all.
    const html = render(OpenCodeReadToolUI, part(capturedReadCompletedContent));
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    expect(html).not.toContain(toolsConfig.copy.status.noOutput);
    expect(html).not.toContain(toolsConfig.copy.status.resultUnreadable);
  });
});

/* -------------------------------------------------------------------------
 * 4. The other captured failure shape: `edit`.
 * ---------------------------------------------------------------------- */
describe("the captured edit failure", () => {
  it("reports its own message, verbatim", () => {
    // REAL: `capturedEditErrorPart`, one of the 18 `edit` errors. Asserted
    // through the same path, so the fix is not specific to `read`.
    const html = render(
      OpenCodeReadToolUI,
      part(
        {
          error: capturedEditErrorPart.state.error.message,
          type: capturedEditErrorPart.state.error.type,
        },
        { isError: true },
      ),
    );
    expect(html).toContain("Failed");
    expect(html).not.toContain(toolsConfig.copy.status.noOutput);

    const failed = failureCopyOf(
      {
        error: capturedEditErrorPart.state.error.message,
        type: capturedEditErrorPart.state.error.type,
      },
      true,
    );
    expect(failed?.copy).toContain(capturedEditErrorPart.state.error.message);
  });
});
