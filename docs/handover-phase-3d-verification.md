# Handover — finish verifying Code-mode tool rendering (Phase 3D)

You are picking up one remaining task on a chat app. All the code is written and
tested; what is missing is **live end-to-end verification with a model-driven tool
call**. Read this whole file before touching anything — the blocker was
mis-diagnosed once already, and §2 corrects it.

## 1. Repo

`D:\Temp\ai-chat-app` — a desktop-style chat app (Bun + TypeScript backend, React
+ Vite frontend, `assistant-ui` + AI SDK v7 + Tailwind). "Code mode" is a second
mode backed by an embedded **OpenCode** server that runs agentic tool calls
(`read`, `write`, `edit`, `bash`, `glob`, `grep`, …).

**Read first — the decision record, explains every design choice:**
`docs/opencode-block-rendering-plan.md`

Do NOT delete `.workbuddy-ai/` (project data, not cache). Work is also logged in
`.workbuddy-ai/memory/2026-09-17.md` and `.workbuddy-ai/memory/MEMORY.md`.

## 2. The blocker — CORRECTED (read this carefully)

An earlier handover said this was blocked by "no model credit" (`balance=0`).
**That was wrong**, and it matters: it sent verification down the wrong path.

Facts, all verified:

- `GET /config` shows the default model is `bai/hy3`, and **`bai` is out of
  credit** (`credit insufficient balance: balance=0`). That is real but it is not
  the whole story.
- `GET /provider` shows **`connected: ["google","opencode","openrouter","bai"]`**,
  and the `opencode` provider has **free models** — including
  `nemotron-3.5-lightning-free`, which is the model Code mode actually uses
  (visible in the app's model chip).
- **That free model works.** Verified: `POST /session/{id}/prompt_async` with
  `{model:{providerID:"opencode",modelID:"nemotron-3.5-lightning-free"}}` and the
  text "Reply with exactly: PING" returned `text="PING"`, `completed=true`,
  `output tokens=2`. It is just **slow — about 30 seconds** for a trivial reply.

**So the real blocker has two layers. The first is the actual wall:**

> **The OpenCode message-creation endpoint (`POST /session/{id}/message`) is
> down.** It is the endpoint the app calls to send a prompt and that an assistant
> turn is built from. It currently returns **`500 Unexpected server error`** (with
> a ref), and a second attempt **hangs** (no response for 3+ minutes). A `GET` on
> the same session still works, so the server is alive but this write path is
> wedged. **Consequence:** no message can be created, so neither a real model run
> nor a synthetic injection of a completed `edit` part is possible. This is the
> single root cause of every remaining "not verified live" item.

Evidence for the endpoint failure:
- Drove the app UI properly: selected `opencode/nemotron-3.5-lightning-free`
  through the composer (the app's model catalog only exposes `opencode`-free and
  `bai` models — the connected `google` provider is **not** selectable), typed a
  write+edit prompt, sent it. The conversation was created and the session model
  was set, but the OpenCode session received **0 messages** — dispatch failed
  silently.
- Calling `POST /session/{id}/message` directly (even a minimal `{parts:[{type:
  "text",text:"x"}]}`) returns 500, then hangs on retry.

**The second layer (now moot, but explains the earlier confusion):** even if the
endpoint worked, `prompt_async` only does a single generation step and does not
pump OpenCode's multi-turn agent loop, so model-requested tool calls stall at
`running` with `time:{start}` and no `end`, turn `completed=false`, 0 pending
permissions. Text-only turns complete normally.

Earlier evidence for that layer (now superseded by the endpoint failure): a real
write+edit run left `read` and `write` `running` with no end; the `read` part in
`ses_f54c09377ffes9Qw1ir1haM3RX` sat `running` since `2026-09-16T17:29:53Z`
(the user's original complaint); `opencode/mimo-v2.5-free` returned `429`.

**Therefore:** the remaining work is to **repair/restart the OpenCode server** (or
the backend that spawns it) so `POST /session/{id}/message` returns 2xx again.
Then, in the app with a model selected, send a write+edit prompt and approve the
gate. Optionally wire the connected `google` provider into the app's model catalog
so a tool-capable model is selectable. Do **not** conclude "no credit, blocked"
— that trap is gone; the wall is the endpoint. And do not confuse "the model
answered" with "the tool call completed"; check `state.status === "completed"` on
the *tool part*.

## 3. What is ALREADY verified (do not redo)

- Phases 2, 3A, 3B, 3C, 4 are implemented, unit/render-tested and mutation-checked.
- **A completed tool call renders correctly — verified live and visually.** This
  was the thing that had never been seen. A completed `bash` part renders as its
  own terminal block showing the command (`echo handover-probe-ok`), a green
  **`✓ exit 0`** badge, and the output (`handover-probe-ok`) as its own block,
  with no console errors. This also confirms the `TerminalBlock` `status` fix
  works in production (the success badge only renders when `done` is true).

## 4. Still to verify

| Item | Status |
|---|---|
| `bash` completed → terminal output | **verified live** (§3) |
| `read` completed → file body | **not verified** |
| `edit` completed → **diff** (not "Edit applied successfully.") | **not verified** |
| approval gate: approve / deny, and no wedge | **not verified** live |

### Technique that lets you verify result rendering with NO model at all

`POST /session/{sessionID}/shell` creates a real **completed** tool part:
```bash
curl -s -X POST "http://127.0.0.1:$P/session/<sessionID>/shell" \
  -H 'content-type: application/json' \
  -d '{"agent":"build","command":"echo hello"}'
```
Verified working (200; part `bash`/`completed`, `output="handover-probe-ok\r\n"`).
Use it to exercise completed-state rendering whenever a model is unavailable.

## 5. Environment — re-discover, these values change

- **Backend:** `http://localhost:3000` (serves the built frontend from `web/dist`,
  proxies OpenCode under `/api/opencode/*`).
- **The OpenCode server port is dynamic — never hardcode it.** Find it:
  ```bash
  netstat -ano | grep -i listening | grep 127.0.0.1 | awk '{print $2}' \
    | sed 's/.*://' | sort -un | while read p; do
      r=$(curl -s -m 1 "http://127.0.0.1:$p/config" 2>/dev/null | head -c 40)
      case "$r" in *'opencode.ai/config'*) echo "PORT $p -> OpenCode";; esac
    done
  ```
  Several stale servers exist; pick the one that knows your session:
  `curl -s "http://127.0.0.1:$P/session/<id>"`. (It was **53660** at handover.)
- **App conversations ↔ OpenCode sessions:** `GET http://localhost:3000/api/conversations`
  maps `id` → `opencodeSessionId`. A session must be linked to a conversation for
  the app to render it. Useful ones:
  - conversation `m4fc89xrxg9k3vuhwx8yoo7c` → `ses_f54c09377ffes9Qw1ir1haM3RX`
    (has the completed `bash` part; its stuck `read` is here too)
  - conversation `ahpmdzob56zjmkgl7r765mh6` → `ses_f54cc688effeRQZdSnEacw7FA1`
    ("live-stream verify", running `write`)
  - conversation `i4vmqrs590jwrk6phvp7bs10` → `ses_f54ae8edeffe5KwBUMIf2Wi32p`
  - Open the app directly at `http://localhost:3000/?cb=<n>#/chat/<conversationId>`

## 6. Commands and traps

```bash
cd /d/Temp/ai-chat-app
bun run typecheck        # expect exit 0

# Full suite. USE THE 30s TIMEOUT.
bun test --path-ignore-patterns "web/e2e/**" --timeout=30000
# expect: 706 pass, 2 skip, 0 fail   (708 tests / 75 files)

# Rebuild the frontend after ANY source change
cd web && bunx vite build --emptyOutDir false
```

1. **Never run the suite with the default 5s per-test timeout.** Several
   process-spawning backend tests take 2.6–3.4s *alone*; under parallel load they
   cross 5s and cascade into unrelated `CredentialStore`/`todo` failures, giving
   6–12 bogus failures. With `--timeout=30000` it is green in ~21s. This is a
   timeout budget problem, not a defect — **do not "fix" those tests.**
2. **The prompt endpoint is `POST /session/{id}/prompt_async`** (204 = accepted).
   `POST /session/{id}/prompt` returns the SPA HTML — wrong route. Body requires
   `parts`; `model` is `{providerID, modelID}`.
3. **The browser caches the bundle.** After rebuilding use `?cb=<n>` and confirm
   the loaded file: `agent-browser eval "JSON.stringify(performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/assets\/index-.*\.js/.test(n)))"`
4. **`agent-browser screenshot` frames a SMALLER viewport (1088px) than
   `agent-browser eval` (1264px).** A card can be visible to
   `getBoundingClientRect` yet cropped out of the shot. Check the element's own
   rect (`visible`, `top`, `color`) before calling a render broken.
5. **`agent-browser` sometimes hangs.** Prefer `open <url>` then a separate
   `snapshot` writing to a file, over one long chained command. If it hangs
   >2 min, stop it and retry simply.
6. **`useAuiState` THROWS without an `AuiProvider`** ("requires an AuiProvider").
   That is why the OpenCode renderers are split into a **pure view** (data as a
   prop, unit-testable) plus a **thin registered wrapper** calling the hook. Keep
   that split or you break the render tests.
7. **Verify against the running server, not an installed package's schema.**
   `@opencode/schema@2.0.4` describes a *newer* shape than the running server
   (1.18.31) and caused a wrong conclusion once.

## 7. Useful facts about the data shapes

The richest source of real shapes is OpenCode's own DB (~1400 sessions, ~2850 tool
parts, all projects), read-only:
```
C:\Users\RTPC\.local\share\opencode\opencode.db
```
`part.data` is JSON — query with `bun:sqlite`:
`json_extract(data,'$.tool')`, `'$.state.status'`, `'$.state.metadata'`.

Surveyed over 253 completed parts:
- an `edit` result is the literal `"Edit applied successfully."`; the patch is in
  `metadata.diff` and `metadata.filediff.patch`
- a `write` result is `"Wrote file successfully."` with **no patch at all** (a
  whole-file write has nothing to diff against) — showing no diff is correct
- the runtime projection **drops `state.metadata`**; the patch is reached via
  message metadata `metadata.custom.opencode.parts` (see `useOpenCodeEditPatch`)
- `parse-diff` (the `DiffViewer` parser) handles OpenCode's git-style `Index:` /
  `===` header — verified on a real patch

## 8. "The wedge" — confirm it is gone

The user originally reported that a permission prompt could **wedge**: the card
kept offering Approve/Deny after the server had forgotten the request, so every
click failed forever. Phases 1/3A fixed it by retiring the card once the server
proves the request is gone. When you have a working model, deliberately exercise
this: deny a gated tool, and let a permission be resolved elsewhere, then confirm
the card **retires** rather than offering controls that cannot succeed.

### 8.1 Wedge root cause — RESOLVED 2026-09-17 (the first diagnosis was wrong)

The wedge was first blamed on a server-side permission **store/routing mismatch**
and called unfixable without an OpenCode change. **That was incorrect**, and the
correction matters: the probe had sent the reply **without** the session's
`?directory=`. The permission and question stores are **directory-scoped**, so
the unscoped call resolved an empty set and answered `PermissionNotFoundError`.
With the directory supplied, the canonical route works. Measured live on the
managed 1.18.31 server:

```
GET  /permission                             -> []
GET  /permission?directory=<sessionDir>      -> [ <the pending request> ]
POST /permission/<rid>/reply?directory=<dir> {"reply":"once"}   -> 200 true, tool running -> completed
POST /permission/<rid>/reply?directory=<dir> {"reply":"reject"} -> 200 true, tool running -> error
```

The fix belongs in TBAi code and is implemented: `opencodeScope.ts` owns the
directory rule once; `permissionCompat.ts` / `questionCompat.ts` add it to the
list + reply calls; `initialHydration.ts` replays the pending set on connect;
`stalePermissions.ts` reconciles against the same scoped endpoint;
`runtimeClient.ts` composes all four. Verified through the real UI too — a
permission raised with **no page open** surfaced after load (initial hydration),
and both Approve and Deny resolved on the directory-scoped route, with no
unscoped reply and no fallback call.

**Still open — verification, not implementation:** a real completed `edit` part
(carrying `metadata.filediff.patch`) has not yet been captured rendering through
OpenCode → runtime → UI. Report it as LIVE BLOCKED until it is.

## 9. Reporting rules

- **Never claim a visual result without the user seeing it.** The user is the only
  one who can look at the rendered UI. State exactly what you observed and what
  you did not.
- Distinguish "the model replied" from "the tool call completed" — check the tool
  part's `state.status`.
- Report: exact commands, quoted observed output, screenshots for anything visual,
  and anything that contradicts the plan doc.
- If you fix a defect, add a test that fails without the fix, then mutation-check
  it (break the code, confirm the test fails, revert, and
  `grep -rn "MUTATION" web/src src` to prove no probe was left behind).

## 10. Definition of done

1. A model-driven run in which tool calls reach `completed` (not just text turns).
2. `read` shows its body; `bash` shows terminal output; `edit` shows a **diff**.
3. An approval is approved and another denied, with no wedge.
4. `bun run typecheck` exit 0; full suite green at `--timeout=30000`.
5. `docs/opencode-block-rendering-plan.md` §6 (Phase 3D) updated with what was
   actually observed, plus any new finding recorded as a numbered finding.

If you cannot obtain a model that completes tool calls, say so plainly, report
everything verified so far (including §3), and stop — do not substitute a render
test for a live check and call it verified.
