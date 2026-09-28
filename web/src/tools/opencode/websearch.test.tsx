import { describe, it, expect, mock } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OpenCodeReadToolUI,
  OpenCodeGlobToolUI,
  OpenCodeGrepToolUI,
  OpenCodeBashToolUI,
  OpenCodeEditToolUI,
  OpenCodeWriteToolUI,
  OpenCodeWebSearchToolUI,
} from "./ui";
import { normalizeOpenCodeArgs, parseOpenCodeWebSearchHits } from "./adapt";
import { toolsConfig } from "@/config/tools";
import {
  exaLiveDocument,
  firecrawlNoResults,
  inventedJsonPayload,
  parallelDocument,
  tavilyDocument,
  tinyfishDocument,
  webSearchContent,
  webSearchMetadata,
  webSearchRawPart,
} from "@/testing/websearch-payloads";

/**
 * Websearch renderer contract, rebuilt on CAPTURED payloads.
 *
 * `OpenCodeWebSearchToolUI` projects the real OpenCode `websearch` document
 * onto the official `WebSearch` element. The element shows `title` + `domain`
 * per hit; the untouched document stays visible beneath it. When the call is
 * gated, denied, failed, or awaiting a continuation, the renderer defers to
 * `BackendToolView` so the shared approval lifecycle is untouched.
 *
 * THE FIXTURES ARE CAPTURED, NOT INVENTED. Every payload comes from
 * `@/testing/websearch-payloads`, which records where each one was read from.
 * The suite this replaces hand-wrote a JSON payload
 * (`{"search_id":…,"results":[…]}`) that no server sends, tested the parser
 * against it, and therefore passed while every real search rendered
 * "Read 0 sources". `describe("fixture provenance")` below is the guard against
 * that coming back.
 *
 * `web/` has no DOM runner. The element is driven through
 * `renderToStaticMarkup` against REAL OpenCode-shaped input, with the two
 * runtime hooks the renderer uses faked via `mock.module` so the decision
 * logic (element vs `BackendToolView`, `searching` flag, `results`/`raw`)
 * is pinned without a live runtime.
 */

// ── Fakes for the two hooks the renderer consumes ────────────────────────────

// `useToolArgsStatus` returns `{ propStatus, ... }`; the renderer destructures
// `propStatus` from it. `useAuiState` serves the raw official V2 parts, so it
// is faked by RUNNING the renderer's own selector against a fake message — the
// projection's `metadata.custom.opencode.parts` key is then exercised for real
// rather than assumed by returning a canned value.
let fakeQuery: string | undefined = "my query";
let fakeRawParts: unknown = null;

const useToolArgsStatusMock = mock(
  () => ({ propStatus: fakeQuery === undefined ? undefined : { query: fakeQuery } }),
);
const useAuiStateMock = mock(
  (selector: (state: unknown) => unknown) =>
    selector({
      message: {
        metadata: { custom: { opencode: { parts: fakeRawParts } } },
      },
    }),
);

function installRendererHookFakes() {
  // Reset per install so a test that seeds raw parts cannot leak them into the
  // next test, which would silently make a "no caption" case render one.
  fakeRawParts = null;
  mock.module("@assistant-ui/react", () => ({
    ...realReactExports,
    useToolArgsStatus: useToolArgsStatusMock,
    useAuiState: useAuiStateMock,
  }));
}

/** The raw V2 parts the next render will find on its message. */
function withRawParts(parts: unknown) {
  fakeRawParts = parts;
}

// `@assistant-ui/react` is a huge module; we only need to override the two
// hooks the websearch renderer uses. `mock.module` replaces the whole module,
// so the factory re-provides every real export plus the two fakes.
import * as realReactExports from "@assistant-ui/react";

// ── A completed `websearch` part, shaped exactly as OpenCode sends it ──────

const webSearchPart = (
  args: Record<string, unknown>,
  result: unknown,
  status: Record<string, unknown> = { type: "complete" },
  approval: unknown = null,
  toolCallId = "call_ws",
) => ({
  type: "tool-call",
  toolCallId,
  toolName: "websearch",
  args,
  argsText: JSON.stringify(args),
  result,
  status,
  approval,
  respondToApproval: async () => {},
});

function render(UI: unknown, props: Record<string, unknown>): string {
  const Any = UI as unknown as (p: Record<string, unknown>) => ReactElement;
  return renderToStaticMarkup(createElement(Any, props));
}

/** How many `## [title](url)` hit headings a captured document carries. */
const headingCount = (document: string): number =>
  document.split("\n").filter((line) => /^##\s+\[.*\]\(.*\)\s*$/.test(line.trim())).length;

// ── The live document: one hit per heading, count derived, rows painted ─────

describe("websearch — the captured exa document that reproduced the defect", () => {
  it("reads one hit per `## [title](url)` heading, with the domain from the url", () => {
    const hits = parseOpenCodeWebSearchHits(webSearchContent(exaLiveDocument));
    expect(hits).toEqual([
      { title: "Bun v1.4.2 | Bun Blog", domain: "bun.com" },
      { title: "Bun — A fast all-in-one JavaScript runtime", domain: "bun.com" },
      { title: "Bun v1.4.1 | Bun Blog", domain: "bun.com" },
      // A `www.` host is normalized the way the element's domain label needs.
      { title: "bun", domain: "npmjs.com" },
      { title: "Installation | Bun Docs", domain: "bun.com" },
      { title: "Bun — A fast all-in-one JavaScript runtime", domain: "bun.sh" },
      { title: "Bun (software)", domain: "en.wikipedia.org" },
      { title: "Bun", domain: "endoflife.date" },
    ]);
  });

  it("renders result rows and a non-zero source count for that document", () => {
    installRendererHookFakes();
    fakeQuery = "bun runtime latest version 2026";
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart(
        { query: "bun runtime latest version 2026" },
        webSearchContent(exaLiveDocument),
      ),
    );
    // THE REGRESSION: this read "Read 0 sources" with an empty card body,
    // because the parser JSON.parse'd a Markdown document.
    expect(html).toContain("Read 8 sources");
    expect(html).toContain("Bun v1.4.2 | Bun Blog");
    expect(html).toContain("bun.com");
  });

  it("paints at most the shared row budget, and says how many were read", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart({ query: "q" }, webSearchContent(exaLiveDocument)),
    );
    // The count is the real one; the rows stop at the budget. Hit 8's domain
    // sits far past the body's own preview cap, so its absence can only mean
    // the row was not painted.
    expect(html).toContain(`Read ${headingCount(exaLiveDocument)} sources`);
    expect(html).toContain("Installation | Bun Docs");
    expect(html).not.toContain("endoflife.date");
    expect(toolsConfig.limits.webSearchMaxResults).toBeLessThan(
      headingCount(exaLiveDocument),
    );
  });

  it("keeps the captured document visible beneath the rows", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart({ query: "q" }, webSearchContent(exaLiveDocument)),
    );
    // The element shows title + domain only; the `Published:` dates, the full
    // urls and the snippets are the document's, so they stay on screen.
    expect(html).toContain("Published: 2026-09-05T05:39:32.000Z");
  });
});

// ── Provider shapes: the same parser, four different documents ──────────────

describe("websearch — the captured provider shapes", () => {
  it("reads a two-line-per-hit document (tinyfish)", () => {
    expect(parseOpenCodeWebSearchHits(webSearchContent(tinyfishDocument))).toEqual([
      { title: "Bun — A fast all-in-one JavaScript runtime", domain: "bun.com" },
      {
        title: "oven-sh/bun: Incredibly fast JavaScript runtime, bundler ...",
        domain: "github.com",
      },
    ]);
  });

  it("reads a many-snippet-line document whose hits repeat a domain (parallel)", () => {
    // Snippet length is provider-dependent and must not decide where a hit
    // ends: the next `## [` heading does.
    expect(parseOpenCodeWebSearchHits(webSearchContent(parallelDocument))).toEqual([
      { title: "PrimeReact | React UI Component Library", domain: "v11.primereact.org" },
      { title: "GitHub - mana-ui/ui: One more react UI components library", domain: "github.com" },
    ]);
  });

  it("does not read a snippet's own markdown headings as hits (tavily)", () => {
    // The first hit's snippet contains `# Search results`,
    // `## 1000+ packages found` and `### …` lines. A hit is a heading that is
    // a LINK; keying on `##` alone would report a dozen sources.
    const hits = parseOpenCodeWebSearchHits(webSearchContent(tavilyDocument));
    expect(hits).toHaveLength(headingCount(tavilyDocument));
    expect(hits?.map((hit) => hit.domain)).toEqual([
      "npmjs.com",
      "jsdelivr.com",
    ]);
  });

  it("tolerates a hit with no snippet at all", () => {
    // Synthetic: no capture is this shape, but the document does not promise a
    // snippet, and a heading alone is still a real hit.
    expect(
      parseOpenCodeWebSearchHits("## [Only a heading](https://example.com/a)\n"),
    ).toEqual([{ title: "Only a heading", domain: "example.com" }]);
  });

  it("tolerates CRLF line endings and surrounding whitespace", () => {
    expect(
      parseOpenCodeWebSearchHits("  ## [Padded](https://example.com/p)  \r\n\r\n"),
    ).toEqual([{ title: "Padded", domain: "example.com" }]);
  });

  it("drops a heading whose link is not a URL, and one with no title", () => {
    // Synthetic edge cases, in the captured document's own shape.
    const document = [
      "## [Real](https://real.example/a)",
      "## [Relative link](/docs/intro)",
      "## [](https://untitled.example/a)",
    ].join("\n");
    expect(parseOpenCodeWebSearchHits(document)).toEqual([
      { title: "Real", domain: "real.example" },
    ]);
  });
});

// ── Not this shape: the fallback, and never a fabricated source count ───────

describe("websearch — payloads that are not the document", () => {
  it("the captured no-results document maps to the null sentinel", () => {
    // `firecrawl` returned this whole line as a completed search: there is no
    // hit list to read, so there is no count to report.
    expect(parseOpenCodeWebSearchHits(webSearchContent(firecrawlNoResults))).toBeNull();
  });

  it("prose, empty and absent results all map to the null sentinel", () => {
    expect(parseOpenCodeWebSearchHits("just some prose, no structure")).toBeNull();
    expect(parseOpenCodeWebSearchHits("")).toBeNull();
    expect(parseOpenCodeWebSearchHits("   \n  ")).toBeNull();
    expect(parseOpenCodeWebSearchHits(null)).toBeNull();
    expect(parseOpenCodeWebSearchHits(undefined)).toBeNull();
  });

  it("a document with headings but no usable hit is [] (not null)", () => {
    // The two sentinels must not collapse: `null` means "not a captured
    // document, fall back to the text", `[]` means "this IS one, and it carries
    // no usable hit".
    const document = "## [Relative only](/docs/intro)\n";
    expect(parseOpenCodeWebSearchHits(document)).toEqual([]);
    expect(parseOpenCodeWebSearchHits("prose")).toBeNull();
  });

  it("shows the real document instead of a source count it cannot back", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart({ query: "q" }, webSearchContent(firecrawlNoResults)),
    );
    // The symptom of this defect was a confident "Read 0 sources" above a
    // result the model then answered from. A payload the parser cannot read
    // goes to the shared shell, which shows what the server actually returned.
    expect(html).not.toContain("Read 0 sources");
    expect(html).not.toContain("Read 1 source");
    expect(html).toContain(firecrawlNoResults);
  });
});

// ── Fixture provenance: the guard against invented payloads ────────────────

describe("fixture provenance — websearch payloads are captured, not invented", () => {
  const captured: Readonly<Record<string, string>> = {
    exaLiveDocument,
    parallelDocument,
    tavilyDocument,
    tinyfishDocument,
  };

  it("every captured document is markdown with a link heading per hit", () => {
    for (const [name, document] of Object.entries(captured)) {
      expect(headingCount(document), name).toBeGreaterThan(0);
      expect(document, name).not.toContain('"results"');
    }
  });

  it("the parser reads exactly one hit per heading in every capture", () => {
    for (const [name, document] of Object.entries(captured)) {
      expect(parseOpenCodeWebSearchHits(webSearchContent(document))?.length, name).toBe(
        headingCount(document),
      );
    }
  });

  it("the JSON payload this defect was built on is NOT recognised", () => {
    // The shape the old code parsed. If this ever starts returning hits, the
    // parser has gone back to believing a payload no server sends.
    expect(parseOpenCodeWebSearchHits(inventedJsonPayload)).toBeNull();
    expect(parseOpenCodeWebSearchHits(webSearchContent(inventedJsonPayload))).toBeNull();
  });
});

// ── the provider caption: a TBAi line, not a fork of the element ───────────

/**
 * The card shows which search engine answered, because nothing else in it says:
 * the document has no trace of it and the vendored `WebSearch` element has no
 * field for it. The caption is our own line in the block this renderer already
 * owns, so the element stays byte-identical to upstream.
 */
describe("websearch — the provider caption", () => {
  /** The captured `exa` run's own part id, as the server recorded it. */
  const EXA_PART_ID = "call_1e288607721c43aca7bc060e";

  it("names the provider the captured exa run was actually served", () => {
    installRendererHookFakes();
    fakeQuery = "bun runtime latest version 2026";
    withRawParts([
      webSearchRawPart({
        id: EXA_PART_ID,
        query: "bun runtime latest version 2026",
        document: exaLiveDocument,
        metadata: webSearchMetadata.exa,
      }),
    ]);
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart(
        { query: "bun runtime latest version 2026" },
        webSearchContent(exaLiveDocument),
        { type: "complete" },
        null,
        EXA_PART_ID,
      ),
    );
    expect(html).toContain(toolsConfig.copy.webSearch.searchedVia("exa"));
    // The rows the caption qualifies are still there — the caption is additive.
    expect(html).toContain("Read 8 sources");
    expect(html).toContain("Bun v1.4.2 | Bun Blog");
  });

  it("names the provider of each other captured run too", () => {
    for (const [provider, document] of [
      ["parallel", parallelDocument],
      ["tinyfish", tinyfishDocument],
    ] as const) {
      installRendererHookFakes();
      fakeQuery = "q";
      withRawParts([
        webSearchRawPart({
          id: "call_part",
          query: "q",
          document,
          metadata: webSearchMetadata[provider],
        }),
      ]);
      const html = render(
        OpenCodeWebSearchToolUI,
        webSearchPart({ query: "q" }, webSearchContent(document), { type: "complete" }, null, "call_part"),
      );
      expect(html, provider).toContain(toolsConfig.copy.webSearch.searchedVia(provider));
    }
  });

  it("renders the caption when the callId is the derived V2 form", () => {
    // The id the projection actually hands a renderer in the app.
    installRendererHookFakes();
    fakeQuery = "q";
    withRawParts([
      webSearchRawPart({
        id: EXA_PART_ID,
        query: "q",
        document: exaLiveDocument,
        metadata: webSearchMetadata.exa,
      }),
    ]);
    const derived = `tbai-v2-tool:${encodeURIComponent("msg_0e451da2")}:${encodeURIComponent(EXA_PART_ID)}`;
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart(
        { query: "q" },
        webSearchContent(exaLiveDocument),
        { type: "complete" },
        null,
        derived,
      ),
    );
    expect(html).toContain(toolsConfig.copy.webSearch.searchedVia("exa"));
  });

  it("renders no caption, and no empty label, when the payload states no provider", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    // A real part whose metadata simply has no `provider` (e.g. a search from
    // before the field existed, or a tool that reports no provenance).
    withRawParts([
      webSearchRawPart({
        id: "call_nopro",
        query: "q",
        document: exaLiveDocument,
        metadata: { truncated: false },
      }),
    ]);
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart(
        { query: "q" },
        webSearchContent(exaLiveDocument),
        { type: "complete" },
        null,
        "call_nopro",
      ),
    );
    expect(html).not.toContain(toolsConfig.copy.webSearch.searchedVia(""));
    expect(html).not.toMatch(/Searched via/);
    // …and the card is otherwise intact: no degradation of the real payload.
    expect(html).toContain("Read 8 sources");
  });

  it("renders no caption when the message carries no raw parts at all", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    withRawParts(undefined);
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart({ query: "q" }, webSearchContent(tinyfishDocument), { type: "complete" }, null, "call_ws"),
    );
    expect(html).not.toMatch(/Searched via/);
    expect(html).toContain("Read 2 sources");
  });

  it("never prints another part's provider", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    // Two searches in one message; the card under test is the second one, so
    // reading ambiently would print "exa" here.
    withRawParts([
      webSearchRawPart({
        id: "call_first",
        query: "q",
        document: exaLiveDocument,
        metadata: webSearchMetadata.exa,
      }),
      webSearchRawPart({
        id: "call_second",
        query: "q",
        document: tinyfishDocument,
        metadata: webSearchMetadata.tinyfish,
      }),
    ]);
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart({ query: "q" }, webSearchContent(tinyfishDocument), { type: "complete" }, null, "call_second"),
    );
    expect(html).toContain(toolsConfig.copy.webSearch.searchedVia("tinyfish"));
    expect(html).not.toContain(toolsConfig.copy.webSearch.searchedVia("exa"));
  });

  it("uses muted theme utilities — no hex, no arbitrary alpha, no inline style", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    withRawParts([
      webSearchRawPart({
        id: "call_c",
        query: "q",
        document: exaLiveDocument,
        metadata: webSearchMetadata.exa,
      }),
    ]);
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart({ query: "q" }, webSearchContent(exaLiveDocument), { type: "complete" }, null, "call_c"),
    );
    const caption = html.slice(html.indexOf(toolsConfig.copy.webSearch.searchedVia("exa")) - 120);
    expect(caption).toContain("text-muted-foreground");
    expect(html).not.toMatch(/style="/);
    // Tailwind's arbitrary-value syntax is `[`, and a hex literal is `#`.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

// ── searching state ────────────────────────────────────────────────────────

describe("websearch — searching state", () => {
  it("searching is true while the call is still running", () => {
    installRendererHookFakes();
    fakeQuery = "live query";
    // A running part has no result yet; the element must show the searching
    // state (the shimmer), not a settled "Read N sources".
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart({ query: "live query" }, undefined, { type: "running" }),
    );
    expect(html).toContain("Searching");
    expect(html).not.toContain("Read 0 sources");
  });

  it("searching is false once the call is complete", () => {
    installRendererHookFakes();
    fakeQuery = "done";
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart(
        { query: "done" },
        webSearchContent(parallelDocument),
        { type: "complete" },
      ),
    );
    expect(html).toContain("Read 2 sources");
    expect(html).not.toContain("Searching");
  });
});

// ── query rendering ────────────────────────────────────────────────────────

describe("websearch — query rendering", () => {
  it("renders args.query in the element's pill", () => {
    installRendererHookFakes();
    fakeQuery = "the exact query";
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart(
        { query: "the exact query" },
        webSearchContent(parallelDocument),
      ),
    );
    expect(html).toContain("the exact query");
  });

  it("shows a streaming placeholder while the query is still being emitted", () => {
    installRendererHookFakes();
    fakeQuery = "Searching…";
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart({ query: "partial" }, undefined, { type: "running" }),
    );
    expect(html).toContain("Searching");
  });
});

// ── gated path: defers to BackendToolView ──────────────────────────────────

describe("websearch — gated path", () => {
  it("a gated (awaiting-approval) websearch defers to the shared card", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    // `approval.approved === undefined` means the decision is pending — the
    // element is skipped and the shared approval card is shown instead.
    const part = webSearchPart(
      { query: "q" },
      webSearchContent(exaLiveDocument),
      { type: "complete" },
      { id: "per_ws", options: [], approved: undefined },
    );
    const html = render(OpenCodeWebSearchToolUI, part);
    // The element's result rows are NOT rendered on the gated path; the card
    // is (the approval UI is owned by BackendToolView).
    expect(html).not.toContain("Read 8 sources");
    expect(html).not.toContain("Installation | Bun Docs");
  });

  it("a denied websearch defers to the shared card", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    // A denial carries `approved: false`; the element's rows are skipped and
    // the shared shell (which owns the decision) is shown instead.
    const part = webSearchPart(
      { query: "q" },
      undefined,
      { type: "incomplete" },
      { id: "per_ws", options: [], approved: false },
    );
    const html = render(OpenCodeWebSearchToolUI, part);
    expect(html).not.toContain("Read");
  });

  it("an approved-pending-continuation websearch defers to the shared card", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    // approved: true but no result yet and not running → awaiting continuation.
    const part = webSearchPart(
      { query: "q" },
      undefined,
      { type: "complete" },
      { id: "per_ws", options: [], approved: true },
    );
    const html = render(OpenCodeWebSearchToolUI, part);
    expect(html).not.toContain("Read");
  });
});

// ── regression: unrelated renderers unchanged ──────────────────────────────

describe("websearch — unrelated OpenCode renderers unchanged", () => {
  const completed = (tool: string, args: Record<string, unknown>, result: unknown) => ({
    type: "tool-call",
    toolCallId: `call_${tool}`,
    toolName: tool,
    args,
    argsText: JSON.stringify(args),
    result,
    status: { type: "complete" },
  });

  it("read still resolves to its own renderer and shows the body", () => {
    const html = render(
      OpenCodeReadToolUI,
      completed("read", { filePath: "D:\\ws\\n.txt" }, { content: webSearchContent("line1\nline2") }),
    );
    expect(html).toContain("line1");
    expect(html).toContain("line2");
  });

  it("glob/grep still title on the pattern", () => {
    expect(
      render(
        OpenCodeGlobToolUI,
        completed("glob", { pattern: "**/*.ts" }, { content: webSearchContent("a.ts") }),
      ),
    ).toContain("glob · **/*.ts");
    expect(
      render(
        OpenCodeGrepToolUI,
        completed("grep", { pattern: "needle", include: "*.ts" }, { content: webSearchContent("x.ts:1") }),
      ),
    ).toContain("grep · needle");
  });

  it("bash still renders its terminal output", () => {
    expect(
      render(
        OpenCodeBashToolUI,
        completed("bash", { command: "echo hi" }, webSearchContent("hi\n")),
      ),
    ).toContain("hi");
  });

  it("edit and write still resolve to their own renderers", () => {
    expect(typeof OpenCodeEditToolUI).toBe("function");
    expect(typeof OpenCodeWriteToolUI).toBe("function");
    // Their normalized titles still come from OpenCode's own fields.
    expect(
      render(
        OpenCodeWriteToolUI,
        completed("write", { filePath: "D:\\ws\\w.txt", content: "data" }, { content: webSearchContent("Wrote file successfully.") }),
      ),
    ).toContain("write · D:\\ws\\w.txt");
  });

  it("websearch is not normalized away (it has no arg aliases)", () => {
    // The websearch renderer reads args.query directly; the normalizer passes
    // it through untouched.
    const args = normalizeOpenCodeArgs("websearch", { query: "q" }) as Record<
      string,
      unknown
    >;
    expect(args?.query).toBe("q");
  });
});
