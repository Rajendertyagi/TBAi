import { describe, it, expect, beforeAll } from "bun:test";

/**
 * Source-level guard for the reply renderer's smoothing contract.
 *
 * This is NOT a behavioural test. `web/` has no component-test runner (no
 * vitest/jest/testing-library and no DOM harness) — its tests are pure logic
 * under `bun test`, so the primitive cannot be rendered here and its props
 * cannot be inspected at runtime. The contract is therefore asserted against
 * the source, and the behaviour is confirmed by the browser run instead.
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
    new URL("./markdown-text.tsx", import.meta.url),
  ).text();
});

describe("reply Markdown renderer", () => {
  it("renders the markdown primitive", () => {
    expect(PRIMITIVE.test(source)).toBe(true);
  });

  it("disables client-side text smoothing", () => {
    const element = source.match(PRIMITIVE)?.[0] ?? "";
    expect(element).toContain("smooth={false}");
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
