import { describe, it, expect } from "bun:test";
import {
  OPENCODE_ARGS,
  isNormalizedOpenCodeTool,
  normalizeOpenCodeArgs,
  normalizeOpenCodeResult,
  openCodePatchFromParts,
  openCodeResultText,
  openCodeWebSearchProviderFromParts,
  parseOpenCodeWebSearchHits,
} from "./adapt";
import {
  exaLiveDocument,
  parallelDocument,
  tinyfishDocument,
  webSearchContent,
  webSearchMetadata,
  webSearchRawPart,
} from "@/testing/websearch-payloads";

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

  it("reads a captured websearch document carried in a native V2 content array", () => {
    // The same array shape as the results above, carrying a real search
    // document instead of prose (fixtures in `@/testing/websearch-payloads`).
    expect(parseOpenCodeWebSearchHits(webSearchContent(parallelDocument))).toEqual([
      { title: "PrimeReact | React UI Component Library", domain: "v11.primereact.org" },
      { title: "GitHub - mana-ui/ui: One more react UI components library", domain: "github.com" },
    ]);
  });
});

/* -------------------------------------------------------------------------
 * The real V2 result, and the round trip that lost it.
 *
 * The fixtures below are VERBATIM from a live OpenCode session, read through
 * `GET /api/opencode/session/<id>/message`. They are not hand-written and they
 * are not wrapped: a completed tool state carries `content` as
 * `[ToolContent, ...]`, and that array is exactly what a renderer receives
 * (`v2History.partsForMessage` and the `session.tool.success` handler both set
 * the part's `output` to `content`; the message projection passes `output`
 * through as the tool part's `result`).
 *
 * A `{ content: [...] }` WRAPPER is not what the runtime produces. A renderer
 * test built on one passes while the real path renders "No output.", because
 * normalization leaves a wrapper untouched and the extractor can still find the
 * array inside it.
 * ---------------------------------------------------------------------- */

/** A real completed `grep` result ("Found 12 matches" was the live symptom). */
const REAL_GREP_CONTENT = [
  {
    type: "text",
    text:
      "Found 12 matches\n" +
      "D:\\Temp\\ai-chat-app\\web\\src\\features\\opencode\\V2FormCard.tsx:\n" +
      "  Line 39:  * - Actions: Dismiss, Back, Next, Submit. (No approval/permission metaphors).\n" +
      "\n" +
      "  Line 156:       logger.info(\"approval\", \"question.submitted\", {\n",
  },
];

/** A real completed `read` result. */
const REAL_READ_CONTENT = [
  {
    type: "text",
    text:
      "Read file D:\\Temp\\ai-chat-app\\package.json, lines 1-47\n" +
      "1: {\n" +
      "2:   \"name\": \"tbai\",\n" +
      "3:   \"version\": \"0.1.0\",\n",
  },
];

/** A real completed `question` result. */
const REAL_QUESTION_CONTENT = [
  {
    type: "text",
    text:
      'User has answered your questions: "Which database should I use, postgres or sqlite?"="postgres". ' +
      "You can now continue with the user's answers in mind.",
  },
];

/** Every renderer that consumes the shared `body` helper. */
const BODY_TOOLS = [
  "read",
  "glob",
  "grep",
  "webfetch",
  "skill",
  "question",
  "task",
  "websearch",
  "write",
] as const;

describe("openCodeResultText — the real V2 result, before and after normalization", () => {
  it("reads a bare native V2 content array", () => {
    expect(openCodeResultText(REAL_GREP_CONTENT)).toBe(REAL_GREP_CONTENT[0].text);
    expect(openCodeResultText(REAL_READ_CONTENT)).toBe(REAL_READ_CONTENT[0].text);
  });

  it("reads a bare string result, which is what normalization returns", () => {
    // THE REGRESSION: normalization collapses the content array to a plain
    // string, and the extractor used to recognise only arrays — so every
    // renderer that read the body afterwards saw `null` and printed
    // "No output." for a tool that had returned data.
    expect(openCodeResultText(REAL_GREP_CONTENT[0].text)).toBe(REAL_GREP_CONTENT[0].text);
  });

  it("keeps a real grep result readable through normalization", () => {
    const text = openCodeResultText(normalizeOpenCodeResult("grep", REAL_GREP_CONTENT));
    expect(text).toBe(REAL_GREP_CONTENT[0].text);
    expect(text).toContain("Found 12 matches");
  });

  it("keeps a real read result readable through its `{ content }` shape", () => {
    // `read` normalizes to `{ content: "<text>" }`, so the extractor must read
    // that field too — the wrapper is created here, not by OpenCode.
    const shaped = normalizeOpenCodeResult("read", REAL_READ_CONTENT);
    expect(shaped).toEqual({ content: REAL_READ_CONTENT[0].text });
    expect(openCodeResultText(shaped)).toBe(REAL_READ_CONTENT[0].text);
  });

  it("keeps a real question result readable through normalization", () => {
    const text = openCodeResultText(normalizeOpenCodeResult("question", REAL_QUESTION_CONTENT));
    expect(text).toBe(REAL_QUESTION_CONTENT[0].text);
  });

  it("keeps a terminal result readable through its `{ stdout }` shape", () => {
    for (const tool of ["bash", "shell"]) {
      const shaped = normalizeOpenCodeResult(tool, REAL_READ_CONTENT);
      expect(shaped, tool).toEqual({ stdout: REAL_READ_CONTENT[0].text });
      expect(openCodeResultText(shaped), tool).toBe(REAL_READ_CONTENT[0].text);
    }
  });

  it("loses no text for any tool that renders the shared body", () => {
    for (const tool of BODY_TOOLS) {
      const before = openCodeResultText(REAL_READ_CONTENT);
      const after = openCodeResultText(normalizeOpenCodeResult(tool, REAL_READ_CONTENT));
      expect(after, tool).toBe(before);
    }
  });

  it("normalizing an already-normalized result changes nothing", () => {
    // `openCodeView` normalizes once; a renderer must be able to read the
    // result it is given without a second pass re-wrapping it.
    for (const tool of [...BODY_TOOLS, "bash", "shell"]) {
      const once = normalizeOpenCodeResult(tool, REAL_READ_CONTENT);
      expect(normalizeOpenCodeResult(tool, once), tool).toEqual(once);
    }
  });

  it("still reads the `{ content: [...] }` envelope and a file content part", () => {
    // The envelope is not the real V2 shape, but the generic renderer may
    // still hand it over, so it must keep working.
    const wrapped = { content: REAL_GREP_CONTENT };
    expect(openCodeResultText(wrapped)).toBe(REAL_GREP_CONTENT[0].text);
    expect(openCodeResultText([{
      type: "file",
      uri: "file:///workspace/report.txt",
      mime: "text/plain",
      name: "report.txt",
    }])).toBe("report.txt");
  });

  it("reports no text for empty, error and unexpected results", () => {
    for (const value of [
      null,
      undefined,
      "",
      [],
      { content: [] },
      { stdout: "" },
      { error: "File not found", type: "tool.execution" },
      { content: 42 },
      ["not", "tool", "content"],
      42,
      true,
    ]) {
      expect(openCodeResultText(value), JSON.stringify(value ?? null)).toBeNull();
    }
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

/**
 * `openCodeWebSearchProviderFromParts` — who answered the search.
 *
 * The only accepted source is `state.metadata.provider` on the part this
 * `callId` refers to. Every positive case below is built from a CAPTURED
 * document and a CAPTURED metadata object (`@/testing/websearch-payloads`), so
 * a change in the server's shape fails here instead of in the card.
 */
const WS_ID = "call_1e288607721c43aca7bc060e";

/** A real `websearch` part, from a captured document + captured metadata. */
const webSearchPartOf = (
  id: string,
  document: string,
  metadata: unknown,
): Record<string, unknown> =>
  webSearchRawPart({ id, query: "bun runtime latest version 2026", document, metadata });

describe("openCodeWebSearchProviderFromParts — the provider is read, never assumed", () => {
  it("reads the provider from a captured part's own metadata", () => {
    const parts = [webSearchPartOf(WS_ID, exaLiveDocument, webSearchMetadata.exa)];
    expect(openCodeWebSearchProviderFromParts(parts, WS_ID)).toBe("exa");
  });

  it("reads every provider this app has actually been served", () => {
    // Each pair is a real document with that provider's real metadata beside
    // it; the name is the server's, so a rename in the server is what fails.
    expect(
      openCodeWebSearchProviderFromParts(
        [webSearchPartOf("c1", exaLiveDocument, webSearchMetadata.exa)],
        "c1",
      ),
    ).toBe("exa");
    expect(
      openCodeWebSearchProviderFromParts(
        [webSearchPartOf("c2", parallelDocument, webSearchMetadata.parallel)],
        "c2",
      ),
    ).toBe("parallel");
    expect(
      openCodeWebSearchProviderFromParts(
        [webSearchPartOf("c3", tinyfishDocument, webSearchMetadata.tinyfish)],
        "c3",
      ),
    ).toBe("tinyfish");
  });

  it("picks its own part out of a message holding several", () => {
    // The id match is the whole join key: a wrong part's provider would be
    // worse than none, so this is the case that proves it is not read ambient.
    const parts = [
      webSearchPartOf("c_first", exaLiveDocument, webSearchMetadata.exa),
      webSearchPartOf("c_second", parallelDocument, webSearchMetadata.parallel),
    ];
    expect(openCodeWebSearchProviderFromParts(parts, "c_second")).toBe("parallel");
    expect(openCodeWebSearchProviderFromParts(parts, "c_first")).toBe("exa");
  });

  it("reads a provider through the derived V2 call id", () => {
    // Built exactly as `deriveV2ToolCallId` builds it: the prefix, then each
    // segment URL-encoded SEPARATELY, joined by a literal ":".
    const parts = [webSearchPartOf(WS_ID, exaLiveDocument, webSearchMetadata.exa)];
    const derived = `tbai-v2-tool:${encodeURIComponent("msg_0e451da24001Ga4Ucma7RT6dAS")}:${encodeURIComponent(WS_ID)}`;
    expect(openCodeWebSearchProviderFromParts(parts, derived)).toBe("exa");
  });

  it("returns null — not a label — when the field is absent", () => {
    const parts = [webSearchPartOf(WS_ID, exaLiveDocument, { truncated: false })];
    expect(openCodeWebSearchProviderFromParts(parts, WS_ID)).toBeNull();
    const empty = [webSearchPartOf(WS_ID, exaLiveDocument, {})];
    expect(openCodeWebSearchProviderFromParts(empty, WS_ID)).toBeNull();
  });

  it("returns null when `provider` is present but the wrong type", () => {
    for (const provider of [42, true, null, ["exa"], { name: "exa" }]) {
      const parts = [webSearchPartOf(WS_ID, exaLiveDocument, { provider })];
      expect(openCodeWebSearchProviderFromParts(parts, WS_ID)).toBeNull();
    }
  });

  it("treats a blank provider as absent", () => {
    for (const provider of ["", "   ", "\n"]) {
      const parts = [webSearchPartOf(WS_ID, exaLiveDocument, { provider })];
      expect(openCodeWebSearchProviderFromParts(parts, WS_ID)).toBeNull();
    }
  });

  it("returns null for a part with no metadata at all (e.g. still running)", () => {
    expect(
      openCodeWebSearchProviderFromParts(
        [{ id: "c_run", state: { status: "running" } }],
        "c_run",
      ),
    ).toBeNull();
    expect(
      openCodeWebSearchProviderFromParts([{ id: "c_null", state: null }], "c_null"),
    ).toBeNull();
    expect(
      openCodeWebSearchProviderFromParts(
        [{ id: "c_str", state: { metadata: "exa" } }],
        "c_str",
      ),
    ).toBeNull();
  });

  it("returns null rather than guessing on absent parts or a wrong id", () => {
    const parts = [webSearchPartOf(WS_ID, exaLiveDocument, webSearchMetadata.exa)];
    // No parts at all.
    expect(openCodeWebSearchProviderFromParts(undefined, WS_ID)).toBeNull();
    expect(openCodeWebSearchProviderFromParts(null, WS_ID)).toBeNull();
    expect(openCodeWebSearchProviderFromParts([], WS_ID)).toBeNull();
    // Parts that are not an array.
    expect(openCodeWebSearchProviderFromParts({ parts }, WS_ID)).toBeNull();
    // No id to match.
    expect(openCodeWebSearchProviderFromParts(parts, undefined)).toBeNull();
    expect(openCodeWebSearchProviderFromParts(parts, "")).toBeNull();
    // An id that is in no part.
    expect(openCodeWebSearchProviderFromParts(parts, "some_other_id")).toBeNull();
  });

  it("ignores non-object entries instead of throwing", () => {
    const parts = [null, "junk", 42, webSearchPartOf(WS_ID, exaLiveDocument, webSearchMetadata.exa)];
    expect(openCodeWebSearchProviderFromParts(parts, WS_ID)).toBe("exa");
  });

  it("is unaffected by the sibling `truncated` key, in either position", () => {
    // `truncated` is the only other key the server sends. It must neither be
    // mistaken for the provider nor block reading it.
    expect(
      openCodeWebSearchProviderFromParts(
        [webSearchPartOf(WS_ID, exaLiveDocument, { truncated: true, provider: "exa" })],
        WS_ID,
      ),
    ).toBe("exa");
    expect(
      openCodeWebSearchProviderFromParts(
        [webSearchPartOf(WS_ID, exaLiveDocument, { provider: "exa", truncated: true })],
        WS_ID,
      ),
    ).toBe("exa");
  });

  it("reads the provider out of the untouched document, not out of its text", () => {
    // Proof the answer comes from metadata: the same document with a different
    // provider reports that provider, and a document mentioning "exa" with no
    // metadata reports nothing.
    expect(
      openCodeWebSearchProviderFromParts(
        [webSearchPartOf(WS_ID, exaLiveDocument, webSearchMetadata.parallel)],
        WS_ID,
      ),
    ).toBe("parallel");
    const bare = { ...webSearchPartOf(WS_ID, exaLiveDocument, {}) };
    expect(openCodeWebSearchProviderFromParts([bare], WS_ID)).toBeNull();
  });
});
