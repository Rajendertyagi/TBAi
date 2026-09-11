import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffViewer } from "../src/components/diff-viewer";
import { prettyPatch } from "./fixtures/diff-samples";

/**
 * Rich-rendering tests. assistant-ui's runtime-context components
 * (MarkdownTextPrimitive, GroupedParts, ToolFallback) require a mounted
 * assistant runtime, so their live behavior is verified in the browser E2E.
 * The DiffViewer is a pure component and SSR-verifiable here.
 */

const PATCH = `--- a/src/hello.ts
+++ b/src/hello.ts
@@ -1,4 +1,5 @@
 const hello = "world";
-print("hello")
+// greet loudly
+console.log("hello", hello);
 export { hello };
`;

describe("DiffViewer (official component, SSR)", () => {
  it("renders additions and deletions", () => {
    const html = renderToStaticMarkup(<DiffViewer patch={PATCH} />);
    expect(html).toContain("console.log");
    expect(html).toContain("print");
  });

  it("shows addition/deletion stats", () => {
    const html = renderToStaticMarkup(<DiffViewer patch={PATCH} />);
    expect(html).toContain("+2");
    expect(html).toContain("-1");
  });

  it("handles a realistic multi-file git patch without crashing", () => {
    const html = renderToStaticMarkup(<DiffViewer patch={prettyPatch} />);
    expect(html).toContain("src/hello.ts");
  });

  it("renders an empty patch without crashing", () => {
    const html = renderToStaticMarkup(<DiffViewer patch="" />);
    expect(typeof html).toBe("string");
  });

  it("streaming-safe: a truncated (still-arriving) patch does not crash", () => {
    const truncated = PATCH.slice(0, Math.floor(PATCH.length / 2));
    const html = renderToStaticMarkup(<DiffViewer patch={truncated} />);
    expect(typeof html).toBe("string");
  });
});
