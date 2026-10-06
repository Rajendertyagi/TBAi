# Computer control (cua-driver) as a native tool — plan

**Status:** plan only. No implementation yet. Nothing in this document has been written to code.
**Date:** 2026-10-03
**Scope:** Windows only. macOS is explicitly out of scope (see [Non-goals](#non-goals)).
**Baseline:** `src/tools/index.ts` has 15 native tools; `browser` / `browser_action` already exist
and wrap the `agent-browser` CLI.

## Summary

Add two native tools — `computer` (screenshot, ungated) and `computer_action` (click/type/key/scroll,
approval-gated) — backed by `cua-driver`, a standalone Rust binary from trycua that speaks MCP over
stdio. The driver is downloaded on first use, hash-verified, and kept as a long-lived child process.

The architectural argument for doing it this way rather than as an MCP server is in
[Why native and not MCP](#why-native-and-not-mcp). The short version: the existing native-tool path
already provides the approval gate and the telemetry funnel that a computer-control tool needs, and
an MCP registration would provide neither.

**Effort:** 9 files (3 new, 6 edited). ~60 lines of glue plus the driver client.
**Blocking unknowns:** 2, both cheap to resolve. See [Step 0](#step-0--resolve-the-two-blocking-unknowns).

## What this actually is

The distinction that makes this comprehensible, and that everything else follows from:

| | Browser automation (exists today) | Computer control (this plan) |
|---|---|---|
| Sees | Structure — DOM, element refs | Pixels only |
| Clicks | "the element with ref `e1`" | "x=412, y=288" |
| Speed | Fast, one step per action | ~1–2s per step (screenshot round-trip) |
| If the page changes | Still works | Can click the wrong thing |
| Needs a vision model | No | **Yes** |
| Reaches | That page only | Any application on the desktop |

`browser_action` clicks by `ref` — a handle from `snapshot the DOM`. That is page-scoped by
construction: the ref means nothing outside the tab it came from. Computer control has no refs
because it has no DOM; it works from coordinates against a screenshot, which is why it can reach
any window.

The loop is the same in both cases and is already proven in this codebase:

1. capture state (DOM snapshot / screenshot)
2. decide what to do
3. act (click ref / click coordinate)
4. repeat

## Why native and not MCP

Option B — registering `cua-driver` as an MCP stdio server through the existing
`services/mcp/manager.ts` — is roughly an hour of work and requires no new tool code, because the
driver's tools would flow into the merged tool set automatically. It was rejected for two reasons:

1. **No approval gate.** `browser_action` is approval-gated at `src/routes/chat.ts:903`
   (`browser_action: "user-approval"`). A tool that moves the real mouse across the whole desktop
   with no confirmation step is a materially different risk class from a tool that clicks inside a
   sandboxed browser tab. Shipping it ungated is the one thing I would not compromise on.
2. **No funnel.** Native tools run through `instrumentedExecute` (`src/tools/tool-funnel.ts`),
   emitting `tool.start` / `tool.finish` / `tool.error` per the documented taxonomy. MCP tools are
   explicitly excluded from `nativeToolkit` and fall through to `ToolFallback` in `ChatWindow`. That
   means no rich renderer and no structured telemetry for the single most surprising tool in the app.

Worth noting for later, not for now: registering via MCP would be the only cheap way to get computer
control into the **opencode** engine, which runs its own tools and receives none of ours. If that
becomes a requirement, revisit this decision — but do not trade away the approval gate to get it.

## Non-goals

- **macOS.** Requires code signing, Accessibility / Screen Recording / Apple Events entitlements,
  TCC trust requirements, and the three-process split (app / helper / driver) that codeg exists to
  satisfy. Windows grants UI automation to a process with no signing and no manifest. This plan is
  Windows-only and the file layout below reflects that.
- **A separate helper process.** codeg splits `codeg.exe` → `codeg-computer-helper.exe` →
  `cua-driver` so the OS permission is held by the helper and not the app. On Windows that
  containment buys nothing: `codeg.exe` drives the driver directly, in-process.
- **The opencode engine.** Native tools are not injected into it (verified: `nativeTools` is
  referenced only by `src/routes/chat.ts` and `src/context/assemble.ts`, both direct-engine paths).
- **Continuous screen capture.** No recording, no frame streaming, no disk cache of screen content.
  One screenshot per `computer` call, discarded after the model reads it. The tool is
  demand-driven by construction.
- **Type / key / scroll in stage one.** Screenshot + click first (see [Staging](#staging)).

## Step 0 — resolve the two blocking unknowns

Both are cheap. Do them before writing any glue, because either can invalidate the plan.

### 0.1 Does direct chat accept image input?

`computer` returns a screenshot. If the direct-engine models cannot take images, the tool is
useless regardless of how well the driver works. This gates everything.

Check the provider/model configuration for image support on the direct path, and confirm an image
part survives into the model request. If direct chat is text-only today, adding vision is a
**separate, larger piece of work** than this plan — larger, in fact, than the driver integration.
Resolve this first.

### 0.2 What does the driver actually advertise?

Every tool name in this plan — `screenshot`, `click`, `type`, `key`, `scroll` — is an **assumption**.
It is inferred from how codeg uses the driver, not read from the driver.

Resolve empirically: obtain `cua-driver.exe`, spawn it with piped stdio, send the MCP `initialize`
handshake, then `tools/list`, and record the response verbatim. The real schema for each tool is
what `computer_action`'s Zod schema must be written against — guessing it produces a schema that
validates the wrong shape and fails at call time.

Record the output in this document before proceeding.

### Step 1 — obtain and pin the driver

- Download the release archive for `windows-x86_64`.
- Compute and record the SHA-256 of the archive.
- Extract; confirm the executable name inside the archive.

Record all three values here:

```
Driver version:      TBD
Archive SHA-256:     TBD
Executable name:     TBD
Executable SHA-256:  TBD
```

If the driver offers a manifest or signed release metadata, prefer recording the upstream-published
digests over locally computed ones, and additionally pin what we compute — codeg's approach, and the
reason it is worth the extra few lines here.

## Staging

Two stages, split on purpose. Stage one proves the loop and the integration; stage two broadens the
action surface once the risky part is known to work.

| Stage | Tools | Purpose |
|---|---|---|
| 1 | `computer` (screenshot), `computer_action` (click) | Prove capture → decide → act works end to end |
| 2 | extend `computer_action` with `type`, `key`, `scroll` | Broaden the action vocabulary |

Stage one is deliberately a single action verb. A click is fully reversible and its effect is
visible in the next screenshot, which makes it the safest possible first action and the most
informative test of whether the coordinate handoff is correct.

## Files

9 files: 3 new, 6 edited.

### New (3)

**`src/services/computer.ts`** — the backend. The only substantive file.

Mirrors `src/services/browser.ts` in shape and export discipline. Required exports:

| Export | Purpose |
|---|---|
| `CUA_DRIVER_BIN` / `DRIVER_TIMEOUT_MS` / `DRIVER_MAX_OUTPUT_BYTES` | Constants, matching browser.ts's naming |
| `ensureDriver()` | Download, verify SHA-256, unzip to cache. Idempotent. |
| `driverChildEnv(env)` | Environment for the child process — namespace it as `browserChildEnv()` namespaces the browser |
| `runComputerRead(args, opts)` | Screenshot. No approval. |
| `runComputerAction(args, opts)` | Click / later type/key/scroll. Approval-gated upstream. |

Two design points:

- **The driver is a long-lived child, not per-call.** `agent-browser` is already treated as a
  persistent daemon; the driver should be the same. Spawning per tool call would add process-start
  latency to every action, and the screenshot→click loop would pay it on each step. Hold one child,
  multiplex requests over its stdin/stdout, and restart it if it dies.
- **Request correlation.** JSON-RPC over a shared pipe needs request IDs matched to responses, and
  has to survive the driver writing non-response lines to stdout. Handle unsolicited notifications;
  do not assume one line in, one line out.

### Edited (6)

**1. `src/lib/validation.ts`** — schemas at the API boundary, ~15 lines.

Add `computerReadSchema`, `computerActionSchemaFull` and their type exports alongside the browser
schemas at lines 392–411 / 539–540. Schemas live here first; `tools/schemas.ts` re-exports them.

**2. `src/tools/schemas.ts`** — re-export, ~4 lines.

Add to the import block (lines 15–29) and to `toolSchemas` after line 51. This is the single source
of truth both the server `tool()` defs and the client `defineToolkit` derive from — editing it in
only one of those two places is exactly the drift this file exists to prevent.

**3. `src/tools/index.ts`** — tool definitions, ~35 lines.

Add `computer` and `computer_action` to `nativeTools` after the browser entries (line 445), copying
the `browser` / `browser_action` shape precisely. This is what inherits `instrumentedExecute` and the
approval gate — the reason for the native path.

**4. `web/src/tools/toolkit.ts`** — register renderers, ~2 lines.

Two entries after line 75, both `display: "standalone"` — the documented rule for approval-gated
tools, whose cards stay visible outside collapsed groups.

**5. `src/routes/chat.ts`** — one line.

Add `computer_action: "user-approval"` next to `browser_action` at line 903.

**6. `web/src/tools/computer/ComputerToolUI.tsx`** and `ComputerActionToolUI.tsx`** — see below.

### Not touched

- `src/services/mcp/` — the driver is not an MCP server here.
- `src/context/assemble.ts` — merges `nativeTools` wholesale, so new tools flow through untouched.
- `src/tools/tool-funnel.ts` — the funnel is inherited via `instrumentedExecute`.
- `web/src/tools/toolkit.ts` `openCodeToolkit` — opencode keeps its own tools.

### UI renderers

`ComputerToolUI` renders the screenshot. `BrowserToolUI` already solves screenshot display, so this
is largely reuse of that path rather than new work.

`ComputerActionToolUI` renders the pending click — target coordinates, and whatever the driver
returns about what it hit. This is the card the user reads when deciding to approve. It should show
the coordinates plainly; a human approving a click on their own desktop needs to be able to tell
*where* it is about to land.

## Implementation order

1. **Step 0** — vision support, then the driver's real `tools/list`. Nothing else until both land.
2. **`src/services/computer.ts`**, screenshot path only.
3. Schemas (`validation.ts` → `schemas.ts`), tool defs, toolkit registration.
4. Approval wiring in `routes/chat.ts` + the action renderer.
5. `computer_action` with click. Loop is live.
6. Stage two: `type`, `key`, `scroll`.

## Risks and open questions

| Risk | Note |
|---|---|
| Direct chat has no vision | Step 0.1. Potentially larger than the integration itself. |
| Driver does not speak plain MCP over stdio on Windows | Step 0.2. Unverified assumption; the plan depends on it. |
| Tool names/schemas differ from assumption | Step 0.2 resolves it by observation. |
| Screenshot latency | ~1–2s per step is expected. Model choice matters; a slow vision model compounds per step. |
| Screen content ends up in conversation history | Screenshots are message content. Worth a decision on redaction/retention before shipping, and worth confirming how `context/assemble.ts` budgets image parts. **Not yet investigated.** |
| Mouse hijack | The user's cursor moves without them asking. Approval gating is the mitigation; the UX needs to make a pending click obvious. |
| Tool enable/discovery surface | Not yet located. A grep for `browser_action` outside the files listed above will show whether tools need registering anywhere else. |

## References

- `src/tools/index.ts` — native tool definitions, `browser` / `browser_action` at lines 421–445
- `src/services/browser.ts` — the pattern `computer.ts` follows
- `src/lib/validation.ts` — schema boundary, browser schemas at 392–411
- `src/tools/schemas.ts` — shared schema source of truth
- `web/src/tools/toolkit.ts` — renderer registration, `nativeToolkit` at 55–76
- `src/routes/chat.ts:903` — approval gating
- `src/tools/tool-funnel.ts` — telemetry funnel inherited via `instrumentedExecute`
- codeg `src-tauri/src/computer/driver.rs` — the pinned-driver pattern (digest pinning, cached by
  version, downloaded on demand)
- codeg `src-tauri/src/computer/helper/driver_proc.rs` — confirms the driver is spawned with piped
  stdin/stdout and speaks MCP on that socket
