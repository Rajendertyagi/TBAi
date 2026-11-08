import { describe, it, expect, beforeAll } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";

/**
 * Source-level guard for the reply renderer's smoothing contract.
 *
 * This is NOT a behavioural test. There is no DOM, so a render here would be a
 * `react-dom/server` static snapshot — and the contract below is about a prop
 * that must be PASSED to a third-party primitive, which no snapshot can
 * distinguish from its default. The contract is therefore asserted against the
 * source, and the behaviour is confirmed by the browser run instead.
 *
 * Why it matters: @assistant-ui/react-markdown defaults `smooth` to `true`,
 * which re-animates arriving text as a client-side typewriter (useSmooth) and
 * keeps the part marked "running" until that animation drains. Streamed
 * replies must paint as tokens land, so the default has to be overridden
 * explicitly — and if someone drops that override, this fails.
 */
const PRIMITIVE = /<MarkdownTextPrimitive[\s\S]*?\/>/;

let source = "";

beforeAll(async () => {
  source = await Bun.file(
    path.join(REPO_ROOT, "web/src/components/assistant-ui/elements/markdown-text.tsx"),
  ).text();
});

describe("reply Markdown renderer", () => {
  it("renders the markdown primitive", () => {
    expect(PRIMITIVE.test(source)).toBe(true);
  });

  it("enables client-side text smoothing", () => {
    const element = source.match(PRIMITIVE)?.[0] ?? "";
    expect(element).toContain("smooth={true}");
  });

  it("retains defer", () => {
    const element = source.match(PRIMITIVE)?.[0] ?? "";
    expect(element).toMatch(/\bdefer\b/);
  });

  it("keeps GFM and the component overrides intact", () => {
    const element = source.match(PRIMITIVE)?.[0] ?? "";
    expect(element).toContain("remarkPlugins={[remarkGfm]}");
    expect(element).toContain("components={markdownComponents}");
  });
});
