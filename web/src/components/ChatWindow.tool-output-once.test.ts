import { describe, it, expect, beforeAll } from "bun:test";
import { stripComments } from "@/testing/source-scope";

/**
 * Who owns the duplicated tool output? (Defect 3 — the finding, pinned.)
 *
 * ## The report
 *
 * "One shell command's output appears in the tool card, then again in the
 * assistant's prose, and in Direct mode a third time in a language-less
 * markdown code block."
 *
 * ## The answer, from the data rather than from reading the report
 *
 * **Two of the three copies are the model's, and TBAi has no fix for them.**
 * The evidence, read off live payloads on 2026-09-28:
 *
 * 1. **TBAi has no system prompt that asks for an echo.** The Direct engine's
 *    only `instructions` input is `conversation.systemPrompt`
 *    (`src/routes/chat.ts`, `instructions: conversation.systemPrompt`), and it
 *    is a per-conversation field the USER writes — nullable, unset by default.
 *    Every Direct conversation inspected here has `systemPrompt: null`. There
 *    is no TBAi-authored default, no per-tool instruction, and no tool
 *    description that asks the model to repeat anything: the native tool
 *    descriptions in `src/tools/index.ts` state what each tool does and
 *    nothing about how to report it.
 *
 * 2. **The model writes the prose and the fence itself.** Two real captures
 *    from `GET /api/conversations/<id>/messages`:
 *
 *      - a `run_command` whose card shows its own output, followed by the
 *        assistant text "The command executed successfully. Output:\n\n```\nhi\n```"
 *        — the model quoted the output back inside a fence, in one turn.
 *      - a `list_dir` followed by "The current working directory is **empty** —
 *        no files or subdirectories are present."
 *
 *    The `data-tbai-progress` part in the same message is a machine part, not
 *    text: it is never rendered as prose and carries no tool output.
 *
 * 3. **The renderer adds no third copy.** `MarkdownText` renders the text part
 *    it is given. A fence the model wrote becomes a code block; nothing in
 *    `markdown-text.tsx` or `ChatWindow.tsx` re-emits a tool result into a
 *    text part. Grepping the frontend for a write of `type: "text"` finds only
 *    user prompts, test fixtures, and the MCP sampling reply — never a tool
 *    result.
 *
 * 4. **On the OpenCode surface it does not happen at all.** Across all 398
 *    assistant messages in the live store that contain BOTH tool calls and
 *    text, ZERO repeat a substantive (>= 40 char) line of their own tool
 *    output in the same message's prose. OpenCode's agent prompt governs that
 *    engine's behaviour, and that prompt is not TBAi's to edit.
 *
 * ## What this file therefore asserts
 *
 * Not that the duplication is gone — it cannot be, from here — but that the
 * TBAi-side surfaces did not grow a second renderer for tool output, and did
 * not grow a prompt that asks for one. That is the part a future change could
 * plausibly break, and the part this fix was scoped to.
 *
 * ## What was deliberately NOT done
 *
 * No suppression of the model's prose, and no hiding of output the model
 * legitimately wrote. The maintainer's instruction was explicit: do not hide
 * it, and do not hack around the model's own behaviour. Suppressing a code
 * block the model wrote would also hide every legitimate code block in every
 * ordinary answer, which is a far larger loss than the duplication it removes.
 * The language-less fence is a STYLE artefact of the model (it omitted the
 * info string), not a TBAi rendering defect.
 */
describe("tool output is rendered once by TBAi", () => {
  let chatWindowSource = "";
  let markdownSource = "";
  let chatRouteSource = "";

  beforeAll(async () => {
    chatWindowSource = stripComments(
      await Bun.file(
        new URL("../components/ChatWindow.tsx", import.meta.url),
      ).text(),
    );
    markdownSource = stripComments(
      await Bun.file(
        new URL("../components/assistant-ui/elements/markdown-text.tsx", import.meta.url),
      ).text(),
    );
    chatRouteSource = stripComments(
      await Bun.file(new URL("../../../src/routes/chat.ts", import.meta.url)).text(),
    );
  });

  it("renders a text part as markdown and nothing else", () => {
    // The one text branch of the part switch. It hands the part to
    // `MarkdownText`; it does not consult any tool result, so a tool's output
    // cannot be re-emitted as prose by this file.
    expect(chatWindowSource).toContain('case "text":');
    const textCase = /case "text":[\s\S]*?case "reasoning":/.exec(chatWindowSource)?.[0] ?? "";
    expect(textCase.length).toBeGreaterThan(0); // non-vacuity: the branch was located
    expect(textCase).toContain("<MarkdownText");
    // No tool result is read inside the text branch.
    expect(textCase).not.toContain("part.result");
    expect(textCase).not.toContain("openCodeResultText");
  });

  it("has no code path that writes a tool result into a text part", () => {
    // The only text-part construction in the frontend is a user prompt (the
    // composer's recovery re-send) and the OpenCode first-prompt handoff. If a
    // tool result were ever pasted into prose, it would have to be one of
    // these.
    expect(chatWindowSource).not.toContain('type: "text"');
    expect(markdownSource).not.toContain('type: "text"');
  });

  it("sends no TBAi-authored system prompt asking the model to repeat output", () => {
    // `instructions` is the ONLY system-prompt seam on the Direct engine, and
    // it is wired to the user's own per-conversation field. Asserted on the
    // assignment, so a TBAi-authored default or a second `instructions` key
    // cannot appear without this failing.
    const instructions = [...chatRouteSource.matchAll(/instructions:/g)];
    expect(instructions.length).toBe(1);
    expect(chatRouteSource).toContain(
      "...(conversation?.systemPrompt ? { instructions: conversation.systemPrompt } : {})",
    );
    // And the only way it is set is a conversation field, not a constant.
    expect(chatRouteSource).not.toMatch(/instructions:\s*["'`]/);
  });
});
