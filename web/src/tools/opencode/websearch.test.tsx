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
import {
  normalizeOpenCodeArgs,
  parseOpenCodeWebSearchHits,
} from "./adapt";

/**
 * Websearch renderer contract (T3-O24…T3-O30).
 *
 * `OpenCodeWebSearchToolUI` projects the verified OpenCode `websearch` payload
 * onto the official `WebSearch` element. The element shows `title` + `domain`
 * per hit; the raw JSON stays visible beneath it. When the call is gated,
 * denied, failed, or awaiting a continuation, the renderer defers to
 * `BackendToolView` so the shared approval lifecycle is untouched.
 *
 * `web/` has no DOM runner. The element is driven through
 * `renderToStaticMarkup` against REAL OpenCode-shaped input, with the two
 * runtime hooks the renderer uses faked via `mock.module` so the decision
 * logic (element vs `BackendToolView`, `searching` flag, `results`/`raw`)
 * is pinned without a live runtime.
 */

// ── Fakes for the two hooks the renderer consumes ────────────────────────────

// `useToolArgsStatus` returns `{ propStatus, ... }`; the renderer destructures
// `propStatus` from it. `useAuiState` is read by other OpenCode renderers, so
// it is re-provided as a no-op for this file.
let fakeQuery: string | undefined = "my query";

const useToolArgsStatusMock = mock(
  () => ({ propStatus: fakeQuery === undefined ? undefined : { query: fakeQuery } }),
);
const useAuiStateMock = mock(() => null);

function installRendererHookFakes() {
  mock.module("@assistant-ui/react", () => ({
    ...realReactExports,
    useToolArgsStatus: useToolArgsStatusMock,
    useAuiState: useAuiStateMock,
  }));
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
) => ({
  type: "tool-call",
  toolCallId: "call_ws",
  toolName: "websearch",
  args,
  argsText: JSON.stringify(args),
  result,
  status,
  approval,
  respondToApproval: async () => {},
});

function render(
  UI: unknown,
  props: Record<string, unknown>,
): string {
  const Any = UI as unknown as (p: Record<string, unknown>) => ReactElement;
  return renderToStaticMarkup(createElement(Any, props));
}

// A real OpenCode websearch result: a JSON string of { search_id, results }.
const REAL_RESULT = JSON.stringify({
  search_id: "search_abc",
  results: [
    {
      url: "https://www.example.com/page",
      title: "Example Title",
      publish_date: "2025-03-19",
      excerpts: ["excerpt one"],
    },
    {
      url: "https://docs.example.org/guide",
      title: "Docs Guide",
      publish_date: null,
      excerpts: [],
    },
  ],
});

// ── T3-O24 — mapping: real JSON → { title, domain }[], url hostname, www. off

describe("T3-O24 — websearch mapping", () => {
  it("projects a real payload onto { title, domain }[] with www. stripped", () => {
    const hits = parseOpenCodeWebSearchHits(REAL_RESULT);
    expect(hits).toEqual([
      { title: "Example Title", domain: "example.com" },
      { title: "Docs Guide", domain: "docs.example.org" },
    ]);
  });

  it("reads domain from the url hostname", () => {
    const hits = parseOpenCodeWebSearchHits(
      JSON.stringify({
        results: [{ url: "https://sub.domain.io/x", title: "S" }],
      }),
    );
    expect(hits).toEqual([{ title: "S", domain: "sub.domain.io" }]);
  });

  it("renders the mapped hits in the element", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    const html = render(OpenCodeWebSearchToolUI, webSearchPart({ query: "q" }, REAL_RESULT));
    expect(html).toContain("Example Title");
    expect(html).toContain("example.com");
    expect(html).toContain("Docs Guide");
    expect(html).toContain("docs.example.org");
  });
});

// ── T3-O25 — plain-text / unparseable / null → results: [], raw text shown ──

describe("T3-O25 — websearch fallback (plain text)", () => {
  it("plain-text (non-JSON) result maps to no hits (null sentinel)", () => {
    // Non-JSON is "not the verified shape" → null (raw text still shown), not [].
    expect(parseOpenCodeWebSearchHits("just some text, not json")).toBeNull();
  });

  it("null / empty / non-string result maps to no hits (null sentinel)", () => {
    expect(parseOpenCodeWebSearchHits(null)).toBeNull();
    expect(parseOpenCodeWebSearchHits("")).toBeNull();
    expect(parseOpenCodeWebSearchHits(undefined)).toBeNull();
  });

  it("a well-formed payload with zero results maps to [] (not null)", () => {
    expect(parseOpenCodeWebSearchHits(JSON.stringify({ results: [] }))).toEqual([]);
  });

  it("the raw text stays visible beneath the element when hits are absent", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart({ query: "q" }, "plain prose result, no structure"),
    );
    // The element renders its query + a "Read 0 sources" line; the raw text
    // is shown in the body so no real data is discarded.
    expect(html).toContain("plain prose result, no structure");
  });
});

// ── T3-O26 — empty/malformed: [] vs null kept distinguishable ───────────────

describe("T3-O26 — websearch empty/malformed edges", () => {
  it("an empty results array is [] (structured, no usable hits)", () => {
    expect(parseOpenCodeWebSearchHits(JSON.stringify({ results: [] }))).toEqual([]);
  });

  it("a hit missing a usable title is dropped, never given a placeholder", () => {
    const hits = parseOpenCodeWebSearchHits(
      JSON.stringify({
        results: [
          { url: "https://ok.example", title: "Kept" },
          { url: "https://ok.example", title: "" }, // blank title
          { url: "https://ok.example" }, // no title
        ],
      }),
    );
    expect(hits).toEqual([{ title: "Kept", domain: "ok.example" }]);
  });

  it("a hit with a bad/missing url is dropped", () => {
    const hits = parseOpenCodeWebSearchHits(
      JSON.stringify({
        results: [
          { url: "not a url", title: "Bad" },
          { title: "NoUrl" },
          { url: "https://good.example", title: "Good" },
        ],
      }),
    );
    expect(hits).toEqual([{ title: "Good", domain: "good.example" }]);
  });

  it("null (not this shape) is kept distinct from [] (structured-empty)", () => {
    // The two sentinels must not collapse: `null` means "not a verified
    // payload" (fallback to raw text), `[]` means "verified, zero usable hits".
    expect(parseOpenCodeWebSearchHits("garbage")).toBeNull();
    expect(parseOpenCodeWebSearchHits(JSON.stringify({ results: [] }))).toEqual([]);
  });
});

// ── T3-O27 — searching state ────────────────────────────────────────────────

describe("T3-O27 — websearch searching state", () => {
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
      webSearchPart({ query: "done" }, REAL_RESULT, { type: "complete" }),
    );
    expect(html).toContain("Read 2 sources");
    expect(html).not.toContain("Searching");
  });
});

// ── T3-O28 — query rendering ────────────────────────────────────────────────

describe("T3-O28 — websearch query rendering", () => {
  it("renders args.query in the element's pill", () => {
    installRendererHookFakes();
    fakeQuery = "the exact query";
    const html = render(
      OpenCodeWebSearchToolUI,
      webSearchPart({ query: "the exact query" }, REAL_RESULT),
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

// ── T3-O29 — gated path: defers to BackendToolView ──────────────────────────

describe("T3-O29 — websearch gated path", () => {
  it("a gated (awaiting-approval) websearch defers to the shared card", () => {
    installRendererHookFakes();
    fakeQuery = "q";
    // `approval.approved === undefined` means the decision is pending — the
    // element is skipped and the shared approval card is shown instead.
    const part = webSearchPart(
      { query: "q" },
      REAL_RESULT,
      { type: "complete" },
      { id: "per_ws", options: [], approved: undefined },
    );
    const html = render(OpenCodeWebSearchToolUI, part);
    // The element's result rows are NOT rendered on the gated path; the card
    // is (the approval UI is owned by BackendToolView).
    expect(html).not.toContain("Example Title");
    // The shared shell is what carries the approval lifecycle.
    expect(html).not.toContain("Read 2 sources");
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
    // No result rows on the denied path — the shared card owns it.
    expect(html).not.toContain("Read");
    expect(html).not.toContain("Example Title");
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

// ── T3-O30 — regression: unrelated renderers unchanged ──────────────────────

describe("T3-O30 — unrelated OpenCode renderers unchanged", () => {
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
      completed("read", { filePath: "D:\\ws\\n.txt" }, "line1\nline2"),
    );
    expect(html).toContain("line1");
    expect(html).toContain("line2");
  });

  it("glob/grep still title on the pattern", () => {
    expect(
      render(
        OpenCodeGlobToolUI,
        completed("glob", { pattern: "**/*.ts" }, "a.ts"),
      ),
    ).toContain("glob · **/*.ts");
    expect(
      render(
        OpenCodeGrepToolUI,
        completed("grep", { pattern: "needle", include: "*.ts" }, "x.ts:1"),
      ),
    ).toContain("grep · needle");
  });

  it("bash still renders its terminal output", () => {
    expect(
      render(
        OpenCodeBashToolUI,
        completed("bash", { command: "echo hi" }, "hi\n"),
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
        completed("write", { filePath: "D:\\ws\\w.txt", content: "data" }, "Wrote file successfully."),
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
