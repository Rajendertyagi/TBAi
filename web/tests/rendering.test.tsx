import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeDiff } from "../src/components/assistant-ui/elements/code-diff";
import { patchToCodeDiffs } from "../src/lib/patch-to-diffs";
import { prettyPatch } from "./fixtures/diff-samples";

/**
 * Rich-rendering tests. assistant-ui's runtime-context components
 * (MarkdownTextPrimitive, GroupedParts, ToolFallback) require a mounted
 * assistant runtime, so their live behavior is verified in the browser E2E.
 * `CodeDiff` and `patchToCodeDiffs` are pure and SSR-verifiable here, and this
 * is the same path `ChatWindow` and `OpenCodeEditView` render through.
 *
 * Re-pointed from the legacy `DiffViewer` when it was replaced by the official
 * element. The assertions are unchanged — only the component under test and the
 * way it is composed.
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

/** Renders a patch the way the app does: parse, then one `CodeDiff` per file. */
const renderPatch = (patch: string) =>
  renderToStaticMarkup(
    <>
      {patchToCodeDiffs(patch).map((file, index) => (
        <CodeDiff
          key={`${index}-${file.filename}`}
          filename={file.filename}
          additions={file.additions}
          deletions={file.deletions}
          lines={file.lines}
          cycle={0}
        />
      ))}
    </>,
  );

describe("CodeDiff (official element, SSR)", () => {
  it("renders additions and deletions", () => {
    const html = renderPatch(PATCH);
    expect(html).toContain("console.log");
    expect(html).toContain("print");
  });

  it("shows addition/deletion stats", () => {
    const html = renderPatch(PATCH);
    expect(html).toContain("+2");
    expect(html).toContain("-1");
  });

  it("handles a realistic multi-file git patch without crashing", () => {
    const html = renderPatch(prettyPatch);
    expect(html).toContain("src/hello.ts");
  });

  it("renders an empty patch without crashing", () => {
    const html = renderPatch("");
    expect(typeof html).toBe("string");
  });

  it("streaming-safe: a truncated (still-arriving) patch does not crash", () => {
    const truncated = PATCH.slice(0, Math.floor(PATCH.length / 2));
    const html = renderPatch(truncated);
    expect(typeof html).toBe("string");
  });
});
