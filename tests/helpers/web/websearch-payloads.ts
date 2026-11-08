/**
 * REAL OpenCode `websearch` result documents, captured and kept verbatim.
 *
 * WHY THIS FILE EXISTS. The renderer once parsed a JSON payload
 * (`{"search_id":…,"results":[{url,title,publish_date,excerpts}]}`) that no
 * server has ever sent, and a hand-written fixture of that fiction shipped the
 * bug green: every real search rendered "Read 0 sources". A fabricated fixture
 * cannot be caught by a test written against the same fabrication, so the
 * fixtures here are the bytes the server produced, and each one names where it
 * came from. A test that needs a web-search payload imports it from here; it
 * never invents one.
 *
 * THE REAL SHAPE is a MARKDOWN document: one ATX heading per hit,
 * `## [title](url)`, followed by that provider's own snippet lines until the
 * next hit heading. How many lines a snippet takes is provider-dependent, which
 * is why every capture below is kept: they differ.
 *
 * WHERE THEY CAME FROM. The app's own OpenCode server, read from the store it
 * writes (`session_message.data` → the tool part's `state.content[0].text`),
 * which is the same text the API returns to the browser. `exaLiveDocument` was
 * captured from the run that reproduced this defect end-to-end in the app at
 * `http://localhost:3001`; the others are earlier real sessions from the same
 * server, so the provider names (`state.metadata.provider`) are the server's,
 * not ours.
 *
 * Where a document is too long to keep whole, the fixture holds the HEAD of
 * each hit verbatim and says so on the export. Nothing is reworded, reordered
 * inside a hit, or re-indented: a fabricated line would be indistinguishable
 * from a real one, which is the failure this file exists to prevent.
 */

/** One completed native-V2 tool `content` array carrying one document. */
export function webSearchContent(document: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: document }];
}

/**
 * The VERBATIM `state.metadata` of each captured `websearch` call.
 *
 * Read from the live store on 2026-09-28 — every `websearch` part in all 50
 * sessions the proxy listed, 8 of them, with no filtering. Each object is the
 * server's own bytes, not a subset: `state.metadata` of a completed websearch
 * carries `provider` and `truncated` and nothing else, on 8 of 8.
 *
 *   exa       4  (ses_f1baee8d8, ses_f1be0d939 ×2, ses_f1c02e629)
 *   parallel  3  (ses_f1bfe280a ×2, ses_f1c2e73ae)
 *   tinyfish  1  (ses_f1c1de300)
 *
 * `tavily` and `firecrawl` are in this store too — from the sessions that
 * produced the documents above, read before this probe — and their metadata is
 * recorded in each export's own header. They are not re-probed here because
 * those sessions have aged out of the listing, and a re-read that returned
 * nothing would be a guess dressed as a capture.
 *
 * `truncated` was `false` on every call seen. It is kept in these literals
 * because the payload carries it, and no reader renders it: see
 * `openCodeWebSearchProviderFromParts`.
 */
export const webSearchMetadata = {
  exa: { provider: "exa", truncated: false },
  parallel: { provider: "parallel", truncated: false },
  tinyfish: { provider: "tinyfish", truncated: false },
  tavily: { provider: "tavily", truncated: false },
  firecrawl: { provider: "firecrawl", truncated: false },
} as const satisfies Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * A raw V2 `websearch` part, assembled from the two verbatim halves above: the
 * `state.content` document the server returned and the `state.metadata` it
 * returned beside it.
 *
 * The ENVELOPE is not a capture — it is the shape `v2History.ts:105-129` reads
 * (`message.content[].type === "tool"`, `name`, `state.{status,input,
 * metadata,content}`) and `v2MessageProjection.ts:188-199` re-emits, wrapped in
 * the `type`/`id` keys the official content part also carries. A test that
 * needs a web-search part in the message-metadata array builds it here rather
 * than hand-writing the wrapper a second time.
 */
export function webSearchRawPart(input: {
  readonly id: string;
  readonly query: string;
  readonly document: string;
  readonly metadata: unknown;
}): Record<string, unknown> {
  return {
    type: "tool",
    id: input.id,
    name: "websearch",
    state: {
      status: "completed",
      input: { query: input.query },
      content: webSearchContent(input.document),
      metadata: input.metadata,
    },
  };
}

/**
 * `exa` — the live document from the run that reproduced the defect, in full.
 *
 * Session `ses_f1baee8d8ffechi0ZPh7bB5pAp`, message
 * `msg_0e451da24001Ga4Ucma7RT6dAS`, tool input
 * `{"query":"bun runtime latest version 2026"}`,
 * `state.metadata = {"provider":"exa","truncated":false}`, eight hits.
 *
 * The shape worth pinning: a `Published: <ISO timestamp>` line directly under
 * the heading, and snippets that contain their OWN markdown (`# Bun v1.4.2`,
 * `### Runtime#`, a fenced code block, a pipe table).
 */
export const exaLiveDocument = `## [Bun v1.4.2 | Bun Blog](https://bun.com/blog/bun-v1.4.2)
Published: 2026-09-05T05:39:32.000Z

Bun v1.4.2 | Bun Blog

# Bun v1.4.2
...
September 5, 2026

This release fixes two ... impacting Elysia and \`AsyncLocalStorage\`, a hang in \`@discord ... /ws\`, CMYK JPEG decoding in \`Bun ... Image\`, a rare J ... crash, and a GC crash on musl.

## [Bun — A fast all-in-one JavaScript runtime](https://bun.com/)

Install Bun v1.4.2
...
v1.4.2 Latest release · September 2026
...
Bun 1.4.2 fixes 7 issues, including two v1.4.1 regressions: a bun build rename bug impacting Elysia apps and an AsyncLocalStorage memory leak. It also fixes worker_threads 'online' ordering, GC and JIT crashes, CMYK JPEG decoding in Bun.Image and a bun install lockfile panic, and upgrades JavaScriptCore

## [Bun v1.4.1 | Bun Blog](https://bun.com/blog/bun-v1.4.1)
Published: 2026-09-04T06:47:12.000Z

Bun v1.4.1 | Bun Blog

# Bun v1.4.1
...
September 4, 2026

Bun v1.4.1 fixes 202 issues, addressing 236 👍.
...
### Runtime#

## [bun](https://www.npmjs.com/package/bun)

- Version: 1.3.14
- License: MIT
- Homepage: https://bun.com
- Repository: git+https://github.com/oven-sh/bun.git
- Weekly downloads: 3038838
- Dependents: 255
- Created: 2013-03-13T21:04:46.269Z
- Updated: 2026-05-13T04:02:43.438Z
...
| Version | Published | Deps |
| --- | --- | --- |
| 0.0.1 | 2013-03 ... 13T21:05:02.668Z | 0 |
| 0.0.10 | 2013-09-12T12:11:32.061Z | 0 |
| 0.0. ... 1 | 2014-11-08T06:28:43.319Z | ... |
| 0.0.12 | 2017-10-03T20:06:12.729Z | 1 |
| 0.0.2 | 20 ... 13T21:25:05.747Z
...
| 0.0. ... 12:50.124Z
...
| 0.0
...
845Z | 6 |
...
1 | 2 ... 01- ... T20:07:27 ... 391Z | ... |
| 0 ... -canary | 2 ... 3-01-2 ... T18:03:39.870Z | 6 |
| 0.5.1-canary.20230124.1 | 2023-01-24T1 ... 20:18.089Z |
...
0.5.1-canary.20230125.1 | ... 23-01- ... 5T20:42:44.801Z
...
0.5. ... .ff6fb58 ... 2023-01-24T18:40:06.610Z | 6 |
| 0.5.10-canary.20230407.1 | 2023-04-07T14:06:27.365Z | 6 |
| 0.5.10-canary.20230407.2 | 2023-04-07T23:09:10.491Z | 6 |

## [Installation | Bun Docs](https://bun.com/docs/installation)

Bun automatically releases an (untested) canary build on every commit to main. To upgrade to the latest canary build:
...
## Installing Older Versions#

Since Bun is a single binary, you can install older versions by re-running the installer script with a specific version.

To install a specific version, pass the git tag to the install script:
...
\`\`\`
curl -fsSL https://bun.com/install | bash -s "bun-v1.3.3"
\`\`\`
...
Windows, pass
...
### Latest Version Downloads#

Linux x64

glibc, Nehalem or newer

## [Bun — A fast all-in-one JavaScript runtime](https://bun.sh/?launch=)

Install Bun v1.3.14
...
v1.3.14 Latest release · May 2026

## [Bun (software)](https://en.wikipedia.org/wiki/Bun_(software))

| Bun | |
| --- | --- |
| | |
| Original author | Jarred Sumner |
| Developer | Anthropic |
| Release | September 14, 2021; 4 years ago [1] |
| Stable release | 1.4.2 [2] / 5 September 2026; 8 days ago |
| Written in | Rust, C++ (JSC bindings), C (WebSocket bindings), TypeScript, JavaScript |
| Operating system | Linux, macOS, Windows |
| License | MIT license [3] |
| Website | bun.com |
| Repository | github.com/oven-sh/bun |
...
2. ↑"Release 1.4.2". 5 September 2026. Retrieved 5 September 2026.

## [Bun](https://endoflife.date/bun)

# Bun 

 📅 Last updated on 06 September 2026 🤖 

Bun is an open-source JavaScript runtime that focuses on speed and comes with a bundler, test runner, and a Node.js-compatible package manager.

| Release | Released | Security Support | Latest |
| --- | --- | --- | --- |
| 1 | 3 years ago (07 Sep 2023) | Yes | 1.4.2 (04 Sep 2026) |
...
You should be running one of the supported release numbers listed above in the rightmost column.`;

/**
 * `parallel` — two hits, each the verbatim head of a real hit, ten lines apart
 * in the source document and joined here with one blank line.
 *
 * Session `ses_f20b796dbffeAU8sM4ls49iHBP`, message
 * `msg_0e1a94870001Kskejk8lMtnuJy`, tool input
 * `{"query":"marimind UI library React components"}`,
 * `state.metadata = {"provider":"parallel","truncated":false}` (ten hits in
 * total; this fixture keeps hits 1 and 3).
 *
 * The shape worth pinning: MANY snippet lines per hit, with no `Published:`
 * line, and hits that repeat a domain (`bun.com` here three times over the
 * whole document) — the element keys a row by domain, so a repeated domain is
 * normal and must not be mistaken for one hit.
 */
export const parallelDocument = `## [PrimeReact | React UI Component Library](https://v11.primereact.org/)

PrimeReact | React UI Component Library
Roles, states, and properties are automatically applied following WAI-ARIA patterns. Focus trapping, restoration, and visible focus indicators throughout. Modern tooling, great defaults, and no surprises. From data tables to charts, dialogs to menus. Everything you need. Full type safety with auto-complete.
Every prop, event, and ref is typed.

## [GitHub - mana-ui/ui: One more react UI components library](https://github.com/mana-ui/ui)

GitHub - mana-ui/ui: One more react UI components library
One more react UI components library. Contribute to mana-ui/ui development by creating an account on GitHub.`;

/**
 * `tavily` — the verbatim head of hit 1 (stopping at its second `##` line) and
 * of hit 2 (stopping after its third snippet line).
 *
 * Session `ses_f20b796dbffeAU8sM4ls49iHBP`, message
 * `msg_0df8626f500157CI0K3FldhBPw`, tool input
 * `{"query":"spell-check npm package alternatives jspell enchant.js JavaScript 2024"}`,
 * `state.metadata = {"provider":"tavily","truncated":false}`.
 *
 * The shape worth pinning: a SNIPPET THAT CONTAINS ITS OWN MARKDOWN HEADINGS —
 * `# Search results`, `## 1000+ packages found`, `### codemirror-spell-checker`
 * — inside hit 1. A hit is a heading that is a LINK, never a bare `##` line, or
 * this document would report a dozen sources instead of two.
 */
export const tavilyDocument = `## [spell-checking - npm search](https://www.npmjs.com/search?q=spell-checking)

⚠️

npm tokens that bypass 2FA are being restricted — account changes (Aug 2026) and direct publishing (Jan 2027). Learn how to prepare →

npm

Sign UpSign In

# Search results

## 1000+ packages found

Sort by: Default

## [spell-checker-js CDN by jsDelivr - A CDN for npm and GitHub](https://www.jsdelivr.com/package/npm/spell-checker-js)

# spell-checker-js

 danakt

js`;

/**
 * `tinyfish` — the document quoted in the bug report for this defect, verbatim:
 * two lines per hit, no `Published:` line, one snippet line.
 *
 * `state.metadata.provider` was `tinyfish` (the profile's default search
 * provider, used when no `websearch` provider is configured). The capture was
 * taken live through the app; the session id was not kept with the quote, so
 * unlike the exports above this one is pinned by SHAPE, not by a re-readable
 * store row. Every assertion made against it is also made against a fixture
 * that does carry a session id.
 */
export const tinyfishDocument = `## [Bun — A fast all-in-one JavaScript runtime](https://bun.com/)

NEWBun v1.4.2 released→ Bun is a fast JavaScript runtime & toolkit. September 2026 Elysia regression fixed. Bun 1.4.2 fixes 7 issues, including two v1.4.1 ...

## [oven-sh/bun: Incredibly fast JavaScript runtime, bundler ...](https://github.com/oven-sh/bun)

Kernel version 5.6 or higher is strongly recommended, but the minimum is 5.1. Get the current Bun version … © 2026 GitHub, Inc.`;

/**
 * `firecrawl` — a completed search with NOTHING in it: the whole content part
 * is one line of prose. Session `ses_f20b796dbffeAU8sM4ls49iHBP`, message
 * `msg_0dfa393ad001IuBN3lkwecfp44`, tool input
 * `{"query":"AI generated UI components how it works example"}`,
 * `state.metadata = {"provider":"firecrawl","truncated":false}`.
 *
 * The shape worth pinning: there is no hit list here at all, so a renderer must
 * not report a source count over it.
 */
export const firecrawlNoResults = `No search results found. Please try a different query.`;

/**
 * The JSON payload the renderer used to parse, kept ONLY as the shape that must
 * NOT be recognised.
 *
 * No OpenCode server has ever sent it (the `exa`, `parallel`, `tavily` and
 * `tinyfish` documents above are what it does send), and it is why this defect
 * shipped: the code believed a shape that does not exist and the test believed
 * it with it. Kept as a negative fixture so re-introducing that belief fails a
 * test instead of shipping again.
 */
export const inventedJsonPayload = JSON.stringify({
  search_id: "search_abc",
  results: [
    {
      url: "https://www.example.com/page",
      title: "Example Title",
      publish_date: "2025-03-19",
      excerpts: ["excerpt one"],
    },
  ],
});
