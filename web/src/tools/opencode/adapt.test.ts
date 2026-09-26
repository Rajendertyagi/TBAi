import { describe, it, expect } from "bun:test";
import {
  OPENCODE_ARGS,
  isNormalizedOpenCodeTool,
  normalizeOpenCodeArgs,
  normalizeOpenCodeResult,
  openCodePatchFromParts,
  openCodeResultText,
  parseOpenCodeWebSearchHits,
} from "./adapt";

/**
 * The argument names below are the AUTHORITY, not a guess.
 *
 * They come from the running OpenCode server's own per-tool JSON schema:
 * `GET /experimental/tool?provider=<p>&model=<m>`. These fields are the native
 * V2 contract used by the current client. If a test here fails, either the
 * mapping broke or the server contract changed — both need a human to look.
 */
const OPENCODE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ["filePath", "offset", "limit"],
  write: ["content", "filePath"],
  edit: ["filePath", "oldString", "newString", "replaceAll"],
  glob: ["pattern", "path"],
  grep: ["pattern", "path", "include"],
  bash: ["command", "timeout", "workdir"],
  shell: ["command", "timeout", "workdir"],
};

/** Our rich UIs' field names, per the renderers in `tools/filesystem/ui.tsx`. */
const OUR_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ["path"],
  write: ["path"],
  edit: ["path", "oldText", "newText"],
  glob: ["query"],
  grep: ["query"],
  bash: ["cwd"],
  shell: ["cwd"],
};

describe("normalizeOpenCodeArgs — filePath maps to our path", () => {
  it("gives `read` a path from OpenCode's filePath", () => {
    const args = normalizeOpenCodeArgs("read", {
      filePath: "D:\\ws\\a.txt",
      offset: 10,
      limit: 20,
    });
    expect(args?.path).toBe("D:\\ws\\a.txt");
    // Untouched fields survive, so nothing is silently dropped.
    expect(args?.offset).toBe(10);
    expect(args?.limit).toBe(20);
  });

  it("keeps OpenCode's own field alongside ours", () => {
    // The raw name is the truth about what was requested: keeping it means a
    // wrong mapping shows up as a redundant field, not as missing data.
    const args = normalizeOpenCodeArgs("read", { filePath: "a.txt" });
    expect(args?.filePath).toBe("a.txt");
    expect(args?.path).toBe("a.txt");
  });

  it("maps `write` filePath to path and leaves content alone", () => {
    const args = normalizeOpenCodeArgs("write", {
      filePath: "a.txt",
      content: "hello",
    });
    expect(args?.path).toBe("a.txt");
    expect(args?.content).toBe("hello");
  });

  it("maps `edit` filePath/oldString/newString to path/oldText/newText", () => {
    const args = normalizeOpenCodeArgs("edit", {
      filePath: "a.ts",
      oldString: "before",
      newString: "after",
      replaceAll: true,
    });
    expect(args?.path).toBe("a.ts");
    expect(args?.oldText).toBe("before");
    expect(args?.newText).toBe("after");
    expect(args?.replaceAll).toBe(true);
  });

  it("maps `glob`/`grep` pattern to query", () => {
    for (const tool of ["glob", "grep"]) {
      const args = normalizeOpenCodeArgs(tool, { pattern: "**/*.ts" });
      expect(args?.query, tool).toBe("**/*.ts");
      // `path` is a genuine OpenCode field for these — it must not be touched.
      expect(args?.path, tool).toBeUndefined();
    }
  });

  it("maps `bash` workdir to our cwd", () => {
    const args = normalizeOpenCodeArgs("bash", {
      command: "ls",
      workdir: "D:\\ws",
    });
    expect(args?.cwd).toBe("D:\\ws");
    expect(args?.command).toBe("ls");
  });
});

describe("normalizeOpenCodeArgs — edges", () => {
  it("never overwrites a value that is already ours", () => {
    // `path` is a real OpenCode field for glob/grep, so an alias must not be
    // allowed to clobber it.
    const args = normalizeOpenCodeArgs("grep", {
      pattern: "x",
      path: "src",
      query: "already-set",
    });
    expect(args?.query).toBe("already-set");
    expect(args?.path).toBe("src");
  });

  it("passes an unknown tool through untouched", () => {
    const original = { whatever: 1 };
    expect(normalizeOpenCodeArgs("todowrite", original)).toBe(original);
    expect(isNormalizedOpenCodeTool("todowrite")).toBe(false);
  });

  it("returns undefined for undefined args rather than inventing an object", () => {
    // A still-streaming part can have no input yet; the renderer must see that
    // as absent, not as an empty object it might title as "".
    expect(normalizeOpenCodeArgs("read", undefined)).toBeUndefined();
  });

  it("does not allocate a new object when there is nothing to alias", () => {
    // Identity is preserved so React props stay referentially stable.
    const original = { limit: 5 };
    expect(normalizeOpenCodeArgs("read", original)).toBe(original);
  });

  it("covers every tool the table claims to normalize", () => {
    // Guards against a table entry added without a case above.
    for (const tool of Object.keys(OPENCODE_ARGS)) {
      expect(OPENCODE_FIELDS[tool], `${tool} has no authoritative field list`).toBeDefined();
      expect(OUR_FIELDS[tool], `${tool} has no expected field list`).toBeDefined();
    }
  });
});

describe("normalizeOpenCodeResult — native V2 content", () => {
  it("rejects plain strings instead of reviving a non-native result shape", () => {
    expect(normalizeOpenCodeResult("read", "file text")).toBe("file text");
    expect(normalizeOpenCodeResult("bash", "ok\n")).toBe("ok\n");
    expect(normalizeOpenCodeResult("shell", "boom")).toBe("boom");
  });

  it("maps native V2 text content arrays to rich-UI result shapes", () => {
    const content = [{ type: "text", text: "native output" }];
    expect(normalizeOpenCodeResult("read", content)).toEqual({ content: "native output" });
    expect(normalizeOpenCodeResult("bash", content)).toEqual({ stdout: "native output" });
    expect(normalizeOpenCodeResult("shell", content)).toEqual({ stdout: "native output" });
    expect(normalizeOpenCodeResult("glob", content)).toBe("native output");
  });

  it("accepts native V2 content arrays directly or inside the result object", () => {
    const content = [{ type: "text", text: "native output" }];
    const wrapped = { content };
    expect(openCodeResultText(content)).toBe("native output");
    expect(openCodeResultText(wrapped)).toBe("native output");
    expect(normalizeOpenCodeResult("read", wrapped)).toBe(wrapped);
  });

  it("does not invent an exit code for `bash`", () => {
    const shaped = normalizeOpenCodeResult("bash", [{ type: "text", text: "boom" }]) as Record<string, unknown>;
    expect(shaped.exitCode).toBeUndefined();
    expect("exitCode" in shaped).toBe(false);
  });

  it("rejects object.content strings and leaves unsupported values untouched", () => {
    const contentString = { content: "x" };
    const stdout = { stdout: "already" };
    expect(normalizeOpenCodeResult("read", contentString)).toBe(contentString);
    expect(normalizeOpenCodeResult("read", undefined)).toBeUndefined();
    expect(normalizeOpenCodeResult("bash", stdout)).toBe(stdout);
  });

  it("extracts native V2 text content arrays for rich renderers", () => {
    const content = [{ type: "text", text: "native output" }];
    expect(openCodeResultText(content)).toBe("native output");
    expect(normalizeOpenCodeResult("read", content)).toEqual({ content: "native output" });
    expect(normalizeOpenCodeResult("shell", content)).toEqual({ stdout: "native output" });
  });

  it("keeps native V2 file content visible in a text result", () => {
    expect(openCodeResultText([{
      type: "file",
      uri: "file:///workspace/report.txt",
      mime: "text/plain",
      name: "report.txt",
    }])).toBe("report.txt");
  });

  it("parses websearch JSON carried inside native V2 content arrays", () => {
    const content = [{ type: "text", text: JSON.stringify({
      results: [{ title: "Native result", url: "https://example.com/result" }],
    }) }];
    expect(parseOpenCodeWebSearchHits(content)).toEqual([
      { title: "Native result", domain: "example.com" },
    ]);
  });
});

/**
 * `openCodePatchFromParts` — reading the native V2 patch out of a raw tool part.
 *
 * The only accepted patch location is `state.metadata.files[].patch`. The result
 * text and unrelated metadata fields are deliberately not patch sources.
 */
const PATCH = "Index: D:\\ws\\a.ts\n--- D:\\ws\\a.ts\n+++ D:\\ws\\a.ts\n@@ -1 +1 @@\n-x\n+y\n";

/** A completed `edit` part, exactly as OpenCode records it. */
const editPart = {
  type: "tool",
  tool: "edit",
  id: "call_edit_1",
  state: {
    status: "completed",
    input: { filePath: "D:\\ws\\a.ts", oldString: "x", newString: "y" },
    content: [{ type: "text", text: "Edit applied successfully." }],
    metadata: {
      files: [{ file: "D:\\ws\\a.ts", patch: PATCH, additions: 1, deletions: 1 }],
    },
    title: "ws\\a.ts",
  },
};

/** A completed `write` part — note the absence of any patch. */
const writePart = {
  type: "tool",
  tool: "write",
  id: "call_write_1",
  state: {
    status: "completed",
    input: { filePath: "D:\\ws\\b.ts", content: "hello\n" },
    content: [{ type: "text", text: "Wrote file successfully." }],
    metadata: {},
    title: "ws\\b.ts",
  },
};

describe("openCodePatchFromParts — the patch lives in metadata, not the result", () => {
  it("extracts the patch from a completed `edit` part", () => {
    expect(openCodePatchFromParts([editPart], "call_edit_1")).toBe(PATCH);
  });

  it("extracts a native V2 patch from metadata.files", () => {
    const part = {
      type: "tool",
      id: "call_v2_edit",
      name: "edit",
      state: {
        status: "completed",
        input: { filePath: "D:\\ws\\a.ts" },
        content: [{ type: "text", text: "Edit applied successfully." }],
        metadata: { files: [{ file: "a.ts", patch: PATCH }] },
      },
    };
    expect(openCodePatchFromParts([part], "tbai-v2-tool:msg%3Aedit:call_v2_edit")).toBe(PATCH);
  });

  it("finds its own part among many", () => {
    expect(
      openCodePatchFromParts([writePart, editPart], "call_edit_1"),
    ).toBe(PATCH);
  });

  it("returns null for `write`, which records no patch at all", () => {
    // Not special-cased — `write` simply has no diff in its metadata. Rendering
    // an empty diff card for it would be wrong, so null is the correct answer.
    expect(openCodePatchFromParts([writePart], "call_write_1")).toBeNull();
  });

  it("rejects metadata fields outside `files[].patch`", () => {
    const part = {
      ...editPart,
      state: { ...editPart.state, metadata: { diff: PATCH } },
    };
    expect(openCodePatchFromParts([part], "call_edit_1")).toBeNull();
  });

  it("returns null rather than guessing on partial or malformed input", () => {
    expect(openCodePatchFromParts(undefined, "call_edit_1")).toBeNull();
    expect(openCodePatchFromParts([], "call_edit_1")).toBeNull();
    expect(openCodePatchFromParts([editPart], undefined)).toBeNull();
    expect(openCodePatchFromParts([editPart], "not_the_id")).toBeNull();
    // A part with no metadata (e.g. still running) must not throw.
    expect(
      openCodePatchFromParts(
        [{ id: "call_x", state: { status: "running" } }],
        "call_x",
      ),
    ).toBeNull();
    expect(
      openCodePatchFromParts([{ id: "call_y", state: null }], "call_y"),
    ).toBeNull();
  });

  it("treats a whitespace-only `files[].patch` as absent", () => {
    const part = {
      ...editPart,
      state: { ...editPart.state, metadata: { files: [{ patch: "   \n  " }] } },
    };
    expect(openCodePatchFromParts([part], "call_edit_1")).toBeNull();
  });

  it("ignores non-object entries instead of throwing", () => {
    expect(
      openCodePatchFromParts([null, "junk", 42, editPart], "call_edit_1"),
    ).toBe(PATCH);
  });
});
