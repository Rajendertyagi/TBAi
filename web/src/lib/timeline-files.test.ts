import { describe, expect, it } from "bun:test";
import type { ToolCallMessagePart } from "@assistant-ui/react";
import { createInitialV2ThreadState } from "@/features/opencode/v2Events";
import { projectV2RepositoryItems } from "@/features/opencode/v2MessageProjection";
import { toStats, buildRestingLabel } from "@/components/assistant-ui/elements/session-timeline";
import { patchFromToolMetadata } from "@/lib/tool-patch";
import {
  readTimelineFiles,
  timelineFilesFromPatch,
  timelinePathFromInput,
} from "@/lib/timeline-files";

/**
 * "M files changed" in the session timeline was structurally always zero.
 *
 * The bug was not a wrong number, it was a missing shape. `toStats` looked for
 * `added`/`removed` on each tool's own result object; OpenCode's `edit` and
 * `write` outputs carry neither, and nothing in the OpenCode path ever produced
 * them. So the arithmetic was correct and the input was always empty — and a
 * correct answer to an empty question looks exactly like a lie.
 *
 * The data was never missing. Every one of those calls already carries a unified
 * diff, which is countable with the parser the app already uses for every diff on
 * screen. These tests are therefore written as a **chain**: real projection in,
 * real timeline label out. A test on either half alone would have passed while
 * the number stayed at zero, which is exactly what happened for as long as this
 * bug existed.
 */

const SESSION_ID = "ses_timeline_files_test";
const MESSAGE_ID = "msg_timeline_files_test";
const TOOL_ID = "call_timeline_files_test";

/** The patch shape verified live: a real `@@` hunk with context. */
const EDIT_PATCH = [
  "--- a/src/alpha.ts",
  "+++ b/src/alpha.ts",
  "@@ -1,3 +1,3 @@",
  " const beta = 2;",
  "-const alpha = 1;",
  "+const alpha = 99;",
  " const gamma = 3;",
].join("\n");

/** What `write` actually sends: `@@ -0,0 +1,N @@`, every line an addition. */
const WRITE_PATCH = [
  "--- a/src/beta.ts",
  "+++ b/src/beta.ts",
  "@@ -0,0 +1,3 @@",
  "+one",
  "+two",
  "+three",
].join("\n");

/**
 * A V2 thread state with one completed tool part, as the live server sends it.
 */
function stateWithTool(
  name: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  status: "complete" | "running" | "error" = "complete",
) {
  const initial = createInitialV2ThreadState(SESSION_ID);
  return {
    ...initial,
    messages: {
      [MESSAGE_ID]: {
        id: MESSAGE_ID,
        parentId: null,
        role: "assistant" as const,
        createdAt: 1,
        parts: [
          {
            kind: "tool" as const,
            id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
            order: 0,
            name,
            input,
            output: [{ type: "text", text: "done" }],
            ...(metadata === undefined ? {} : { metadata }),
            status,
            permissionId: null,
          },
        ],
        source: null,
      },
    },
    messageOrder: [MESSAGE_ID],
  };
}

/** The tool part the projection produces. */
function projectedPart(
  name: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  status?: "complete" | "running" | "error",
): ToolCallMessagePart {
  const [item] = projectV2RepositoryItems(stateWithTool(name, input, metadata, status));
  const part: unknown = item?.message.content[0];
  if (part === null || typeof part !== "object" || (part as { type?: unknown }).type !== "tool-call") {
    throw new Error(`expected a tool-call part, got ${JSON.stringify(part)}`);
  }
  return part as ToolCallMessagePart;
}

describe("the timeline's file count, end to end", () => {
  it("counts the lines a real edit patch changes", () => {
    const part = projectedPart("edit", { filePath: "src/alpha.ts" }, {
      files: [{ file: "src/alpha.ts", patch: EDIT_PATCH }],
    });
    // Through the timeline's own reader, not through the artifact directly.
    expect(toStats([part])).toEqual([{ file: "src/alpha.ts", added: 1, removed: 1 }]);
  });

  it("counts a whole-file write, which the live payload does carry a patch for", () => {
    // The old comment here claimed `write` had no patch at all. It does, and a new
    // file is the easiest case: 3 additions, 0 deletions.
    const part = projectedPart("write", { filePath: "src/beta.ts" }, {
      files: [{ file: "src/beta.ts", patch: WRITE_PATCH }],
    });
    expect(toStats([part])).toEqual([{ file: "src/beta.ts", added: 3, removed: 0 }]);
  });

  it("puts the real number in the label the reader sees", () => {
    const part = projectedPart("edit", { filePath: "src/alpha.ts" }, {
      files: [{ file: "src/alpha.ts", patch: EDIT_PATCH }],
    });
    const label = buildRestingLabel(4, toStats([part]).length, 0);
    // The old behaviour produced "4 steps · 0 files changed" on every coding turn.
    expect(label).not.toContain("0 files changed");
    expect(label).toBe("4 steps · 1 file changed");
  });

  it("still reports zero when nothing changed, rather than inventing a count", () => {
    // A no-op edit: a patch with only context. Zero is a true answer here, and it
    // is the one case where "0 files changed" is correct.
    const noop = [
      "--- a/src/alpha.ts",
      "+++ b/src/alpha.ts",
      "@@ -1,2 +1,2 @@",
      " const beta = 2;",
      " const gamma = 3;",
    ].join("\n");
    const part = projectedPart("edit", { filePath: "src/alpha.ts" }, {
      files: [{ file: "src/alpha.ts", patch: noop }],
    });
    expect(toStats([part])).toEqual([{ file: "src/alpha.ts", added: 0, removed: 0 }]);
  });
});

describe("no artifact where there is nothing to count", () => {
  it("stays silent for a tool that changes no file", () => {
    const part = projectedPart("shell", { command: "bun --version" }, undefined);
    expect(part.artifact).toBeUndefined();
    expect(toStats([part])).toEqual([]);
  });

  it("stays silent for a running edit, which has not changed anything yet", () => {
    // Counting a running edit would put a number on screen that the next event
    // overwrites — a flicker, and a number that was never true.
    const part = projectedPart(
      "edit",
      { filePath: "src/alpha.ts" },
      { files: [{ file: "src/alpha.ts", patch: EDIT_PATCH }] },
      "running",
    );
    expect(part.artifact).toBeUndefined();
  });

  it("stays silent for a failed edit, whose patch never became the file", () => {
    const part = projectedPart(
      "edit",
      { filePath: "src/alpha.ts" },
      { files: [{ file: "src/alpha.ts", patch: EDIT_PATCH }] },
      "error",
    );
    expect(part.artifact).toBeUndefined();
  });

  it("stays silent when the metadata carries no patch", () => {
    const part = projectedPart("edit", { filePath: "src/alpha.ts" }, { files: [] });
    expect(part.artifact).toBeUndefined();
  });

  it("still counts a tool that reports its own line numbers", () => {
    // The result-object path is untouched, so a tool that already answers this
    // question keeps working.
    const part = projectedPart("edit_file", { path: "a.ts" }, undefined);
    const withCounts = { ...part, result: { path: "a.ts", added: 4, removed: 2 } };
    expect(toStats([withCounts])).toEqual([{ file: "a.ts", added: 4, removed: 2 }]);
  });
});

describe("the artifact is readable, and unrecognisable values mean no data", () => {
  it("rejects an artifact it does not recognise rather than trusting it", () => {
    // `artifact` is `unknown` in the library, so anything can be there: a stale
    // build, another writer, a hand-edited session. Each of these must read as
    // "no data", which is how it rendered before this change.
    for (const bad of [
      null,
      undefined,
      "0 files changed",
      42,
      {},
      { files: null },
      { files: "one" },
      { files: [{ file: "a.ts" }] },
      { files: [{ file: "a.ts", added: "1", removed: 0 }] },
      { files: [{ file: "a.ts", added: -1, removed: 0 }] },
      { files: [{ file: "a.ts", added: Number.NaN, removed: 0 }] },
      { files: [{ file: "", added: 1, removed: 0 }] },
    ]) {
      expect(readTimelineFiles(bad), JSON.stringify(bad)).toEqual([]);
    }
  });

  it("accepts a well-formed artifact, and skips only the malformed rows", () => {
    const rows = readTimelineFiles({
      files: [
        { file: "a.ts", added: 1, removed: 0 },
        null,
        { file: "b.ts", added: 0, removed: 2 },
        { added: 1, removed: 1 },
      ],
    });
    expect(rows).toEqual([
      { file: "a.ts", added: 1, removed: 0 },
      { file: "b.ts", added: 0, removed: 2 },
    ]);
  });
});

describe("the path fallback, which must agree with the other reader", () => {
  it("reads file, filePath and path in that order", () => {
    // OpenCode's `edit`/`write` spell it `filePath`; the native tools spell it
    // `path`. Missing `filePath` used to leave the row unnamed.
    expect(timelinePathFromInput({ file: "a", filePath: "b", path: "c" })).toBe("a");
    expect(timelinePathFromInput({ filePath: "b", path: "c" })).toBe("b");
    expect(timelinePathFromInput({ path: "c" })).toBe("c");
  });

  it("returns empty for an unusable input rather than a placeholder", () => {
    for (const bad of [null, undefined, {}, 7, "a.ts", { path: "" }, { path: 3 }]) {
      expect(timelinePathFromInput(bad), JSON.stringify(bad)).toBe("");
    }
  });

  it("names the row from the tool's argument when the patch does not", () => {
    // A patch with no `---`/`+++` header still counts; the name comes from the
    // call. A count with an unnamed row is worse than no count.
    const headerless = ["@@ -1,2 +1,2 @@", "-old", "+new"].join("\n");
    expect(timelineFilesFromPatch(headerless, "src/alpha.ts")).toEqual([
      { file: "src/alpha.ts", added: 1, removed: 1 },
    ]);
  });
});

describe("patch extraction, the one implementation both callers share", () => {
  it("reads the patch out of a tool part's metadata", () => {
    expect(patchFromToolMetadata({ files: [{ file: "a.ts", patch: EDIT_PATCH }] })).toBe(
      EDIT_PATCH,
    );
  });

  it("returns null for every shape that is not a usable patch", () => {
    for (const bad of [
      null,
      undefined,
      {},
      { files: null },
      { files: [] },
      { files: [{ file: "a.ts" }] },
      { files: [{ file: "a.ts", patch: "" }] },
      { files: [{ file: "a.ts", patch: "   " }] },
      { files: [{ file: "a.ts", patch: 7 }] },
      { files: [null] },
    ]) {
      expect(patchFromToolMetadata(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
