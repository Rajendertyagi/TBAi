/**
 * Static parity harness for the `POST /api/chat` extraction.
 *
 * ## What this protects
 *
 * The extraction is a MOVE, so the definition of done is "nothing changed".
 * Two families of construct carry observable behaviour that a type check and a
 * test suite cannot see changing:
 *
 *  1. **Every log event.** `logger.warn("chat", "chat_request_rejected", {...})`
 *     is how the client, the CI annotations and the support trail all observe
 *     this route. A dropped or renamed event is a silent regression.
 *  2. **Every `c.json` response body and status.** A 400 that becomes a 500, or
 *     a body that loses `requestId`, breaks clients that key on it.
 *
 * ## Why a multiset of normalized text, not an AST
 *
 * The point of the refactor is that code MOVES between files. Line numbers,
 * file names, indentation and variable names all legitimately change. What must
 * not change is the literal text of each construct. So this captures normalized
 * source text and compares it as a multiset — order- and location-independent.
 *
 * ## The limitation, stated plainly
 *
 * This proves the captured SOURCE is unchanged. It does NOT prove runtime
 * behaviour: it cannot see a settlement race, a changed control-flow order, or a
 * value computed differently. It is a tripwire against accidental edits during
 * a move, not a substitute for the behavioural suites.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "./repo-root";

/**
 * Every module that makes up `POST /api/chat`.
 *
 * The route entry is `index.ts` INSIDE this directory, not a sibling of it —
 * `src/routes/chat.ts` and `src/routes/chat/` used to coexist, and that
 * file/directory collision is gone. So the walk alone is the whole source set;
 * naming the entry separately would scan it twice and report every log event
 * and response body as a duplicate that the baseline never had.
 */
const PHASE_DIR = "src/routes/chat";

/** `<logger>.warn("scope", "event", {` — level, scope and event are literals. */
const LOG_CALL = /\.(warn|error|info|debug)\(\s*"([a-z][a-z0-9_]*)"\s*,\s*"([a-z][a-z0-9_.]*)"/g;

/**
 * Any `c.json(...)` response construction.
 *
 * Deliberately NOT anchored to `return`: once a rejection lives inside a
 * `PhaseResult`, the source is `return { ok: false, response: c.json(...) }`,
 * not `return c.json(...)`. Anchoring on `return` silently dropped every
 * response a phase moved into a module — the harness reported green while nine
 * bodies went uncounted. Match the constructor, not the statement shape.
 */
const C_JSON = /\bc\.json\(/g;

/**
 * Collapse whitespace so indentation and wrapping do not register as changes,
 * and drop trailing commas before a closing bracket.
 *
 * The trailing-comma rule matters because a MOVE legitimately reformats: the
 * original `c.json(\n  { ... },\n  400,\n)` and the moved `c.json({ ... }, 400)`
 * are the same response. Without this, a pure formatting difference reads as a
 * changed body — a false positive that trains you to ignore the harness.
 *
 * Object KEYS, string CONTENT and status codes are never touched: those are the
 * parts a client can observe.
 */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/,\s*([)\]}])/g, "$1")
    .trim();
}

/** Every .ts file the extraction owns: the route entry plus the phase modules. */
export function collectSources(repoRoot = REPO_ROOT): string[] {
  const files: string[] = [];
  const phaseDir = join(repoRoot, PHASE_DIR);
  if (statSync(phaseDir, { throwIfNoEntry: false })?.isDirectory()) {
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts")) files.push(relative(repoRoot, full).replace(/\\/g, "/"));
      }
    };
    walk(phaseDir);
  }
  return files;
}

/**
 * Pull one `return c.json(...)` statement starting at `from`.
 *
 * Scans to the matching `);` by depth, so nested objects and arrays inside the
 * body cannot terminate the match early.
 */
function readJsonStatement(text: string, from: number): string | null {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

export type Parity = {
  /** `level|scope|event` for every log call, e.g. `warn|chat|chat_request_rejected`. */
  logEvents: string[];
  /** Normalized source of every `return c.json(...)` statement. */
  responses: string[];
  /** Files that were scanned, so an empty scan is never mistaken for parity. */
  files: string[];
};

export function capture(repoRoot = REPO_ROOT): Parity {
  const files = collectSources(repoRoot);
  const logEvents: string[] = [];
  const responses: string[] = [];

  for (const file of files) {
    const text = readFileSync(join(repoRoot, file), "utf8");

    for (const match of text.matchAll(LOG_CALL)) {
      logEvents.push(`${match[1]}|${match[2]}|${match[3]}`);
    }

    for (const match of text.matchAll(C_JSON)) {
      const statement = readJsonStatement(text, match.index + match[0].length - 1);
      if (statement) responses.push(normalize(`c.json${statement}`));
    }
  }

  return {
    logEvents: logEvents.sort(),
    responses: responses.sort(),
    files: files.sort(),
  };
}

/**
 * Multiset difference between the baseline and the current capture.
 *
 *  - `removed` — in the baseline, absent now. Something was LOST: a dropped log
 *    event, a deleted response body. This is the failure that matters.
 *  - `added` — present now, absent from the baseline. Something NEW appeared.
 *
 * Multiset rather than set, so a duplicated call site cannot hide behind a
 * count difference: two identical events baseline, one now, reports the loss.
 */
export function diff(base: string[], next: string[]): { removed: string[]; added: string[] } {
  const pool = [...base];
  const added: string[] = [];
  for (const entry of next) {
    const at = pool.indexOf(entry);
    if (at === -1) added.push(entry);
    else pool.splice(at, 1);
  }
  return { removed: pool, added };
}
