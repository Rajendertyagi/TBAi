# `tests/` — the one home for tests

Every test source file and every test-only asset in this repository lives here.
Nothing lives beside the code it covers. `bun run test:locations` enforces that
and runs in CI.

## Why the rule is a gate, not a convention

Each runner scopes discovery to this directory:

| Command | Scope |
| --- | --- |
| `bun run test` | `./tests/unit ./tests/integration` |
| `bun run test:dom` | `./tests/dom` (preloaded with `tests/setup/dom-preload.ts`) |
| `bun run test:e2e` | Playwright, `testDir: ../tests/e2e` |

A test file written outside `tests/` is collected by **none** of them. It does
not fail; it silently never runs, and the suite stays green while quietly losing
coverage. That is the whole reason the checker is a hard gate.

## Layout

Layer first, feature second: `tests/<layer>/<feature>/`.

```
tests/
├── unit/          fast, no I/O beyond the repo   (bun run test)
├── integration/   real storage, servers, streams (bun run test)
├── dom/           React + happy-dom              (bun run test:dom)
├── e2e/           Playwright against a built app (bun run test:e2e)
├── helpers/       shared test infrastructure
├── fixtures/      test-only data
├── setup/         runner preloads
├── tsconfig.backend.json   typecheck project for backend tests
├── tsconfig.web.json       typecheck project for web tests
└── README.md
```

### Web-origin unit tests live under `tests/unit/web/`

`web/src/**` and `src/**` both contain a `lib/logger.ts`, so a test cannot be
typechecked by a project that maps `@/*` to both trees. The suite is therefore
split by the code it exercises:

- a test that imports `@/...` (backend) is checked by `tsconfig.backend.json`;
- a test that imports `@web/...` (frontend) is checked by `tsconfig.web.json`;
- tests that import `@web/*` while sitting under `unit/` or `integration/` are
  listed explicitly in both configs' `include`/`exclude`, with the reason
  recorded inline. Keep the two lists in step when adding one.

## Writing a test that reads source

Many guards assert on the **text** of a source file ("this module emits these
lifecycle events", "this card is the vendored reference"). They used to sit
beside that file and locate it relatively, which broke the moment they moved.

Resolve from the repository root instead:

```ts
import { REPO_ROOT } from "../../helpers/repo-root";

const source = await Bun.file(path.join(REPO_ROOT, "web/src/lib/send-operation.ts")).text();
```

Never `new URL(rel, import.meta.url)`, `import.meta.dir + ".."`, or any other
depth counted from the test's own location — that is the bug this directory
existence is most prone to reintroducing.

The shared helper `tests/helpers/web/source-scope.ts` already resolves against
the repository root; prefer it over hand-rolled reads.

### `mock.module` is positional

`mock.module("./client", …)` registers against the **absolute path** the
specifier resolves to. After a move, a sibling-relative specifier resolves to
nothing, Bun registers a mock nobody asks for, and the real module is used — the
suite fails with a transport error that looks like a product defect. Use the
alias (`@/services/opencode/client`) so the pointer survives the next move.

## Spikes (removed)

`tests/spikes/p2-candidate-d/` was P2 candidate-D diagnostic work — disposable
`probes/`, retained `proofs/`, and a `scroll-harness/`. It ran via a
`test:spikes` script that was **never a CI gate**, so nothing executed it
automatically; it had drifted to 8 failing tests, 7 errors, and 20 typecheck
errors against APIs that no longer exist. It was removed on 2026-10-11 along
with the script, its `tsconfig.web.json` include globs, and its entry in the web
layer set used by `scripts/check-test-location.ts`.

Note that "spike" is still a live word in this tree: `tests/integration/core/__spike-sse.test.ts`
and `tests/integration/opencode/opencode-stub-provider-spike.test.ts` are ordinary
`bun run test` integration tests and were deliberately kept.