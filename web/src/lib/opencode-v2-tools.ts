/**
 * The tools OpenCode v2 ships, and the v1 names it replaced.
 *
 * ## Why this is a checked-in constant and not a runtime query
 *
 * The obvious guard is to ask the server what tools it has. There is no such
 * endpoint. OpenCode 2.0.15 serves 113 paths in its OpenAPI document and none of
 * them is a tool catalogue; `/openapi.json`'s `metadata` is typed as a bare
 * `object` with no declared properties, so even a tool part's own metadata shape
 * is unspecified by the API. The official `@opencode/client` has no tool
 * namespace for the same reason — `tools` appears there only as a session-stats
 * filter. So a client cannot enumerate, and the list has to be right by
 * construction.
 *
 * ## Where the list came from
 *
 * Three independent sources, in increasing order of authority:
 *
 * 1. OpenChamber, a working v2 client, documents the v2 set and the v1 renames
 *    in `packages/ui/src/lib/opencode/tools.ts`.
 * 2. OpenCode's own shipped binary. Reading `opencode.exe` (203 MB) as bytes and
 *    searching for each name as a literal is decisive in a way no doc is:
 *    `todowrite`, `todoread`, `multiedit`, `plan_enter` and `plan_exit` occur
 *    **zero** times, while `subagent` occurs 277 times and `websearch` 97. A
 *    removed tool is absent from the executable that implements it.
 * 3. A live v2 session, where `search("todowrite")` and `search("todo")` both
 *    return an empty catalog and the exposed `opencode.*` management tools match
 *    this file's namespace list exactly.
 *
 * ## What went wrong before this file existed
 *
 * `todowrite` had a renderer, tests, and a row in the tool-UI tracker, for a tool
 * v2 deleted. A model with no todo tool says so — truthfully — and improvises a
 * `todo.md` file in the user's workspace instead. The card could never fire, and
 * nothing in the build noticed: the registry is name-keyed, `type: "backend"`
 * does not require a `render` (verified: a tool registered with no renderer
 * still passes `tsc`), and a stale name is indistinguishable from a working one
 * until someone runs the app. The tracker even carried the correct finding in
 * its Open questions while its coverage table listed the tool as working.
 *
 * So the invariant is asserted here instead of trusted: every name in
 * {@link OPENCODE_V2_TOOLS} is registered, every registered name is either a v2
 * tool or a deliberately-kept v1 alias, and nothing from
 * {@link OPENCODE_V1_REMOVED} is registered at all.
 */

/** The built-in tools OpenCode v2 ships. */
export const OPENCODE_V2_TOOLS = [
  "edit",
  "execute",
  "glob",
  "grep",
  "patch",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "webfetch",
  "websearch",
  "write",
] as const;

/**
 * Tools under OpenCode's own `opencode.` namespace, which arrive on the wire as
 * `opencode.<name>`. TBAi does not render these — they manage OpenCode itself
 * (rename a session, move it, list models) and are not part of a coding turn —
 * but they are listed so the coverage test can say so out loud rather than
 * failing on them.
 */
export const OPENCODE_V2_MANAGEMENT_TOOLS = [
  "models",
  "session_move",
  "session_rename",
] as const;

/**
 * v1 names v2 still accepts, mapped to what replaced them.
 *
 * These are kept REGISTERED on purpose, and deleting them would be a regression.
 * The registry is name-keyed, so an entry for a name this build never sends costs
 * one line and protects a build that does. `be6f75a` added `subagent` beside
 * `task` for exactly this reason, and a name-keyed registry that lacks the name
 * the server used is how a delegated call once rendered as a raw JSON dump.
 */
export const OPENCODE_V2_ALIASES: Readonly<Record<string, string>> = {
  /** v2 renamed `bash` to `shell`; both are emitted by different builds. */
  bash: "shell",
  /** v2 renamed `task` to `subagent`; the live server sends only `subagent`. */
  task: "subagent",
};

/**
 * v1 tools v2 removed outright, with no successor.
 *
 * Registered entries for these are dead code: the server cannot send them, so the
 * renderer can never fire. Verified absent from the shipped binary, not merely
 * undocumented.
 */
export const OPENCODE_V1_REMOVED = [
  "lsp",
  "multiedit",
  "plan_enter",
  "plan_exit",
  "todoread",
  "todowrite",
] as const;
