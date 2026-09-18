import { describe, it, expect } from "bun:test";
import {
  OPENCODE_ARGS,
  isNormalizedOpenCodeTool,
  normalizeOpenCodeArgs,
  normalizeOpenCodeResult,
  openCodePatchFromParts,
} from "./adapt";

/**
 * The argument names below are the AUTHORITY, not a guess.
 *
 * They come from the running OpenCode server's own per-tool JSON schema:
 * `GET /experimental/tool?provider=<p>&model=<m>`. Verified 2026-09-16 against
 * OpenCode 1.18.31. If a test here fails, either the mapping broke or OpenCode
 * renamed a field — both need a human to look.
 */
const OPENCODE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ["filePath", "offset", "limit"],
  write: ["content", "filePath"],
  edit: ["filePath", "oldString", "newString", "replaceAll"],
  glob: ["pattern", "path"],
  grep: ["pattern", "path", "include"],
  bash: ["command", "timeout", "workdir"],
};

/** Our rich UIs' field names, per the renderers in `tools/filesystem/ui.tsx`. */
const OUR_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ["path"],
  write: ["path"],
  edit: ["path", "oldText", "newText"],
  glob: ["query"],
  grep: ["query"],
  bash: ["cwd"],
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

describe("normalizeOpenCodeResult — the result is a plain string", () => {
  it("wraps `read` output in the envelope the reader UI reads", () => {
    // ReadFileToolUI summarizes `(r as any).content`; OpenCode returns the file
    // text itself, so without this the body renders empty.
    expect(normalizeOpenCodeResult("read", "file text")).toEqual({
      content: "file text",
    });
  });

  it("maps `bash` output to stdout for the terminal block", () => {
    // The terminal renders from `{ stdout, stderr }` via `resultToLines`;
    // OpenCode returns one combined string.
    expect(normalizeOpenCodeResult("bash", "ok\n")).toEqual({ stdout: "ok\n" });
  });

  it("does not invent an exit code for `bash`", () => {
    // `exitCode` lives in the part's `metadata`, which the runtime drops before
    // our UI sees it. Claiming 0 would report success for a failed command.
    const shaped = normalizeOpenCodeResult("bash", "boom") as Record<string, unknown>;
    expect(shaped.exitCode).toBeUndefined();
    expect("exitCode" in shaped).toBe(false);
  });

  it("leaves tools with no shim alone", () => {
    expect(normalizeOpenCodeResult("glob", "a.ts\nb.ts")).toBe("a.ts\nb.ts");
    expect(normalizeOpenCodeResult("edit", "applied")).toBe("applied");
    expect(normalizeOpenCodeResult("write", "wrote 3 lines")).toBe("wrote 3 lines");
  });

  it("does not touch a non-string result", () => {
    const obj = { content: "x" };
    expect(normalizeOpenCodeResult("read", obj)).toBe(obj);
    expect(normalizeOpenCodeResult("read", undefined)).toBeUndefined();
    expect(normalizeOpenCodeResult("bash", { stdout: "already" })).toEqual({
      stdout: "already",
    });
  });
});

/**
 * `openCodePatchFromParts` — reading OpenCode's patch out of a raw tool part.
 *
 * The fixtures below are the ACTUAL shapes recorded by OpenCode, copied from its
 * local session database. The shape survey that drove this design, over every
 * completed `edit`/`write` part stored locally (253 parts):
 *
 *   - `edit`  : 148/148 have `metadata.diff` AND `metadata.filediff.patch`
 *   - `write` : 0/105 have either — a whole-file write has nothing to diff
 *               against, so it records `metadata.filepath` + `exists` instead
 *   - `state.output` is ALWAYS just "Edit applied successfully." /
 *               "Wrote file successfully." — never a patch
 */
const PATCH = "Index: D:\\ws\\a.ts\n--- D:\\ws\\a.ts\n+++ D:\\ws\\a.ts\n@@ -1 +1 @@\n-x\n+y\n";

/** A completed `edit` part, exactly as OpenCode records it. */
const editPart = {
  type: "tool",
  tool: "edit",
  callID: "call_edit_1",
  state: {
    status: "completed",
    input: { filePath: "D:\\ws\\a.ts", oldString: "x", newString: "y" },
    output: "Edit applied successfully.",
    metadata: {
      diagnostics: {},
      diff: PATCH,
      filediff: { file: "D:\\ws\\a.ts", patch: PATCH, additions: 1, deletions: 1 },
      truncated: false,
    },
    title: "ws\\a.ts",
  },
};

/** A completed `write` part — note the absence of any patch. */
const writePart = {
  type: "tool",
  tool: "write",
  callID: "call_write_1",
  state: {
    status: "completed",
    input: { filePath: "D:\\ws\\b.ts", content: "hello\n" },
    output: "Wrote file successfully.",
    metadata: {
      diagnostics: {},
      filepath: "D:\\ws\\b.ts",
      exists: false,
      truncated: false,
    },
    title: "ws\\b.ts",
  },
};

describe("openCodePatchFromParts — the patch lives in metadata, not the result", () => {
  it("extracts the patch from a completed `edit` part", () => {
    expect(openCodePatchFromParts([editPart], "call_edit_1")).toBe(PATCH);
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

  it("falls back to `metadata.diff` when `filediff` is absent", () => {
    const part = {
      ...editPart,
      state: { ...editPart.state, metadata: { diff: PATCH } },
    };
    expect(openCodePatchFromParts([part], "call_edit_1")).toBe(PATCH);
  });

  it("returns null rather than guessing on partial or malformed input", () => {
    expect(openCodePatchFromParts(undefined, "call_edit_1")).toBeNull();
    expect(openCodePatchFromParts([], "call_edit_1")).toBeNull();
    expect(openCodePatchFromParts([editPart], undefined)).toBeNull();
    expect(openCodePatchFromParts([editPart], "not_the_id")).toBeNull();
    // A part with no metadata (e.g. still running) must not throw.
    expect(
      openCodePatchFromParts(
        [{ callID: "call_x", state: { status: "running" } }],
        "call_x",
      ),
    ).toBeNull();
    expect(
      openCodePatchFromParts([{ callID: "call_y", state: null }], "call_y"),
    ).toBeNull();
  });

  it("treats a whitespace-only patch as absent", () => {
    const part = {
      ...editPart,
      state: { ...editPart.state, metadata: { diff: "   \n  " } },
    };
    expect(openCodePatchFromParts([part], "call_edit_1")).toBeNull();
  });

  it("ignores non-object entries instead of throwing", () => {
    expect(
      openCodePatchFromParts([null, "junk", 42, editPart], "call_edit_1"),
    ).toBe(PATCH);
  });
});
