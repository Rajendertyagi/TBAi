import { describe, it, expect } from "bun:test";
import path from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { REPO_ROOT } from "../../helpers/repo-root";

/**
 * A module that nothing imports is invisible: it typechecks, it lints, it
 * formats, and nothing ever runs it. Unlike an unused binding, which Biome
 * already reports, a whole unused *file* costs nothing to keep and everything to
 * understand — a reader assumes it is live.
 *
 * Four such files accumulated before this gate existed, and each was worse than
 * merely dead:
 *
 *   - `src/db/mappers.ts` read as the canonical row→domain mapper layer and was
 *     already out of date (missing `models`/`thinking`/`apiProtocol`), while
 *     `src/services/storage/conversations.ts` and `src/config/providers.ts` each
 *     carried their own live copy.
 *   - `web/index.ts` was a `console.log("Hello via Bun!")` line from `bun init`.
 *   - `web/src/features/opencode/panelInteractions.ts` was one function with no
 *     callers, left behind by an extraction whose consumer went away.
 *   - `web/src/features/opencode/index.ts` was a barrel every consumer had
 *     already bypassed.
 *
 * WHAT IS SCANNED, AND WHAT IS NOT
 * --------------------------------
 *
 * Importers are read from exactly four trees: **`src`, `web/src`, `tests` and
 * `scripts`**. Modules under `src/` and `web/src/` are the subjects; the other
 * two are scanned only for references.
 *
 * **Configuration files are OUTSIDE this gate's scan scope.** `vite.config.ts`,
 * `web/vite.config.ts`, `web/playwright.config.ts`, `biome.jsonc`, `package.json`
 * and the tsconfig files are never read as potential importers. (The tsconfigs
 * ARE read, but only for their `paths` alias maps — never for references.) So a
 * module referenced ONLY from a configuration file would be reported as an
 * orphan. No such module exists today, which is why this passes — it is not
 * enforced, merely currently true. Do not describe this gate as comprehensive.
 *
 * WHAT THIS PROVES, PRECISELY
 * ---------------------------
 *
 * **Zero recognized direct inbound references.** That is the whole claim, and it
 * is weaker than "unreachable". Documented limits:
 *
 *   1. **Reachability through a dead intermediary is not detected.** If a dead
 *      module A imports module B, then B has a direct inbound reference and
 *      passes — even though nothing live can reach B either. This gate is not a
 *      reachability proof and must not be described as one.
 *   2. **An incomplete read makes this suite FAIL rather than degrade.** A
 *      non-literal dynamic `import(...)`, or a specifier matching a configured
 *      alias that resolves to nothing on disk, means the scan cannot see a
 *      reference that probably exists. Deriving an orphan verdict from an
 *      incomplete view would be a confident wrong answer, so it is reported as a
 *      failure naming the file. A guard that quietly weakens itself is worse than
 *      no guard, because it is trusted either way.
 *
 * The scanner reads code and string data separately, because a regex cannot tell
 * them apart. A test fixture containing the literal text `from "./thing"` inside
 * a string LOOKS like an import to a pattern match and is not one; treating data
 * as code is precisely how a guard reports confident, wrong answers.
 *
 * Alias resolution reads the `paths` maps declared in the tsconfig files, so it
 * follows the projects' own configuration rather than a hardcoded guess. Each
 * rule is tagged with the config that declared it, and its target is resolved
 * against that config's own directory — TypeScript's rule now that `baseUrl`
 * (deprecated in 6.0, removed in 7.0) is gone. A rule is only consulted when the
 * importer is compiled under the config that declared it, because `@/*` is
 * declared twice with different bases (`src/*` in the root config, `web/src/*`
 * in the web config) and TypeScript resolves it per importing project. Every
 * MATCHING rule is then tried before concluding the specifier is unresolved,
 * because the broad `@/*` pattern also matches `@web/testing/...` and resolves
 * nowhere. Trying every match and accepting the first that exists errs toward
 * resolving MORE, which is the safe direction: it cannot manufacture a false
 * orphan.
 */

/** Modules with no importer BY DESIGN: process entry points and the Vite entry. */
const ENTRY_POINTS = new Set([
  "src/index.ts",
  "src/server.ts",
  "web/src/main.tsx",
  "web/src/runtime.ts",
]);

/**
 * Unreachable modules KEPT ON PURPOSE. Each must still contain its marker, so the
 * exception cannot outlive its reason.
 *
 *   approval-card.tsx — the vendored assistant-ui card, superseded by
 *   `components/shared/approval-card.tsx`, which is what every gate renders. The
 *   file documents its own deadness and
 *   `tests/unit/web/components/approval-card-canonical.test.ts` asserts the
 *   successor stays canonical, so removing it is an architectural decision about
 *   the frozen assistant-ui train, not a cleanup.
 */
const ALLOWED_ORPHANS: ReadonlyArray<{ readonly file: string; readonly marker: string }> = [
  {
    file: "web/src/components/assistant-ui/elements/approval-card.tsx",
    marker: "THIS FILE IS CURRENTLY UNUSED",
  },
];

const SOURCE_ROOTS = ["src", "web/src"];
const EXTENSIONS = ["", ".ts", ".tsx", ".css", ".json", "/index.ts", "/index.tsx"];

/**
 * One read of a source file: comment text replaced by spaces, plus a
 * per-character flag saying whether that position is CODE or string data.
 *
 * Length is preserved, so offsets and line numbers stay meaningful.
 *
 * Known limit: a template literal containing a nested template with an
 * interpolation is treated as opaque until its closing backtick. That can hide a
 * comment-looking sequence, which is the safe direction — it keeps code and drops
 * nothing.
 */
interface Scan {
  readonly text: string;
  /** True where the character is executable code, false inside a string. */
  readonly isCode: boolean[];
}

export function scanSource(source: string): Scan {
  const out = source.split("");
  const isCode = new Array<boolean>(source.length).fill(true);
  let i = 0;
  let quote: string | null = null;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (out[k] === "\n") continue;
      out[k] = " ";
      isCode[k] = false;
    }
  };

  while (i < source.length) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (quote !== null) {
      isCode[i] = false;
      if (ch === "\\") {
        if (i + 1 < isCode.length) isCode[i + 1] = false;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      isCode[i] = false;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  return { text: out.join(""), isCode };
}

/** Static import/export and `require()` specifiers that appear in CODE. */
function specifiersIn(scan: Scan): string[] {
  const pattern = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
  return (
    [...scan.text.matchAll(pattern)]
      .filter((m) => scan.isCode[m.index] === true)
      .map((m) => m[1] ?? "")
      // An interpolated specifier is not static: its value is not knowable at scan
      // time. That is an opaque dynamic import, never a reference.
      .filter((s) => s.length > 0 && !s.includes("${"))
  );
}

/**
 * `import(...)` calls in CODE whose argument is not a plain string literal — a
 * variable, or a template literal with an interpolation. Each one means the
 * file's real dependencies cannot be read statically.
 */
function opaqueDynamicImports(scan: Scan): string[] {
  const found: string[] = [];
  for (const match of scan.text.matchAll(/\bimport\s*\(/g)) {
    if (scan.isCode[match.index] !== true) continue;
    const after = scan.text.slice(match.index + match[0].length).replace(/^\s*/, "");
    const literal = /^["']/.test(after);
    // A quoted argument is readable UNLESS it interpolates.
    const interpolating = /^(["'`])[^"'`]*\$\{/.test(after);
    if (!literal || interpolating) found.push(match[0]);
  }
  return found;
}

interface AliasRule {
  /** The part of the pattern before the wildcard. */
  readonly prefix: string;
  /** A pattern with no wildcard is matched exactly. */
  readonly exact: boolean;
  readonly targets: readonly string[];
  /**
   * Repo-relative directory of the tsconfig that DECLARED this rule, and
   * therefore the directory its `targets` are written against.
   *
   * Load-bearing since `baseUrl` was removed (deprecated in TypeScript 6.0,
   * removed in 7.0). With `baseUrl` set, a `paths` target resolved against that
   * one directory for every project; without it, TypeScript resolves each target
   * against the config file that declares it. `tests/tsconfig.web.json` encodes
   * the difference directly — its `@web/testing/*` target went from
   * `"../tests/helpers/web/*"` to `"./helpers/web/*"`, which is the same file
   * reached from two different starting points.
   */
  readonly dir: string;
}

/**
 * `paths` maps declared across the tsconfig files, as (pattern, targets) pairs.
 *
 * Parsed with a tolerant scan rather than JSON.parse because every one of these
 * files carries explanatory comments, which JSON.parse rejects.
 */
function aliasRules(): AliasRule[] {
  const configs = ["tsconfig.json", "web/tsconfig.json", "tests/tsconfig.web.json"];
  const rules: AliasRule[] = [];
  for (const config of configs) {
    const absolute = path.join(REPO_ROOT, config);
    if (statSync(absolute, { throwIfNoEntry: false })?.isFile() !== true) continue;
    // `paths` resolve against the config file that declares them, so each rule
    // is tagged with that file's directory rather than a shared base.
    const dir = path.dirname(config).split(path.sep).join("/");
    const text = readFileSync(absolute, "utf8");
    const pathsBlock = /"paths"\s*:\s*\{([\s\S]*?)\n\s{2}\}/.exec(text);
    if (pathsBlock === null) continue;
    for (const pair of pathsBlock[1]?.matchAll(/"([^"]+)"\s*:\s*\[([^\]]*)\]/g) ?? []) {
      const pattern = pair[1] ?? "";
      const targets = [...(pair[2] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
      const star = pattern.indexOf("*");
      rules.push({
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        exact: star === -1,
        targets,
        dir: dir === "." ? "" : dir,
      });
    }
  }
  return rules;
}

/** Which tsconfig's `@/*` a file belongs to. */
type Project = "backend" | "web" | "tests";

function projectOf(importerId: string): Project {
  if (importerId.startsWith("web/")) return "web";
  if (importerId.startsWith("src/")) return "backend";
  // `tests/` and `scripts/` are compiled by the test projects, which map `@/`
  // to whichever side they exercise, so neither is decidable from the path.
  return "tests";
}

function projectOfRule(rule: AliasRule): Project {
  if (rule.dir === "web") return "web";
  if (rule.dir === "") return "backend";
  return "tests";
}

/**
 * Alias prefixes that name a specific tree instead of "this project", and so
 * stay available to every importer no matter which config declares them.
 *
 * `@/` is the opposite kind of alias: it means "the importing project's own
 * `src`", which is precisely why it has to be scoped. `@backend/*` and `@web/*`
 * are the repository's declared route ACROSS projects, and the web tree is
 * entitled to use them. Scoping them away would make this gate report a real,
 * deliberate cross-project reference as unreadable — which would fail the suite
 * and, worse, invite someone to delete a legitimate import. `@web/testing/*`
 * matches by prefix and belongs to the same group.
 */
const CROSS_PROJECT_PREFIXES: readonly string[] = ["@backend/", "@web/"];

/**
 * The rules that may resolve a specifier written by `importerId`, in config order.
 *
 * A `@/` specifier means "a module of the importing project", and two projects
 * declare the identical alias over a different root: `@/* -> ./src/*` in the
 * root tsconfig means `src/*`, while the same line in `web/tsconfig.json` means
 * `web/src/*`. So a project-scoped rule is only consulted when the config that
 * DECLARED it is one the importer is actually compiled under:
 *
 *   - `web/**` → the web config's rules only. If a web `@/` target does not
 *     exist, the correct answer is "unresolved" — NOT a same-named backend
 *     module.
 *   - `src/**` → the root config's rules only.
 *   - `tests/**` and `scripts/**` → every rule, because a test file is compiled
 *     under both test projects and `@/` is genuinely ambiguous there.
 *
 * Falling back to the other project is what made a web `@/lib/logger` credit
 * `src/lib/logger.ts`. Reaching the backend from the web remains possible, but
 * only through the aliases declared for it — see `CROSS_PROJECT_PREFIXES`.
 *
 * Within the applicable rules EVERY match is tried and the first target that
 * exists wins. That errs toward resolving MORE, so it cannot manufacture a false
 * orphan — and it is required, because the broad `@/*` prefix also matches
 * `@web/testing/...`, which resolves nowhere in the backend root.
 */
function applicableRules(importerId: string, rules: readonly AliasRule[]): readonly AliasRule[] {
  const project = projectOf(importerId);
  if (project === "tests") return rules;
  return rules.filter(
    (rule) =>
      projectOfRule(rule) === project ||
      CROSS_PROJECT_PREFIXES.some((prefix) => rule.prefix.startsWith(prefix)),
  );
}

/**
 * The repo-relative path of a real file for `base`+`target`, or null.
 *
 * Existence on disk is the test — NOT membership of the source-module set. A
 * specifier may legitimately point at a test helper or a sibling script, which
 * are real files outside `src/` and `web/src/`; those are not unresolved
 * references, they simply are not source modules. Treating them as unresolved
 * would report this gate's own scope as a defect.
 */
function existingFile(base: string, target: string): string | null {
  const joined = target.startsWith(".") ? path.posix.join(base, target) : target;
  const normalized = path.posix.normalize(joined).replace(/^\.\//, "");
  for (const ext of EXTENSIONS) {
    const candidate = `${normalized}${ext}`;
    if (statSync(path.join(REPO_ROOT, candidate), { throwIfNoEntry: false })?.isFile()) {
      return candidate;
    }
  }
  return null;
}

type Resolution =
  | { readonly kind: "resolved"; readonly id: string }
  | { readonly kind: "external" }
  | { readonly kind: "unresolved"; readonly specifier: string };

export function resolveSpecifier(
  specifier: string,
  importerId: string,
  rules: readonly AliasRule[],
  known: ReadonlySet<string>,
): Resolution {
  /** A real source module is a reference; a real file outside the source set is
   *  out of scope; no file at all means the scan is incomplete. */
  const classify = (found: string | null): Resolution =>
    found === null
      ? { kind: "unresolved", specifier }
      : known.has(found)
        ? { kind: "resolved", id: found }
        : { kind: "external" };

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return classify(existingFile(path.posix.dirname(importerId), specifier));
  }

  let matchedAnyRule = false;
  for (const rule of applicableRules(importerId, rules)) {
    const matches = rule.exact ? specifier === rule.prefix : specifier.startsWith(rule.prefix);
    if (!matches) continue;
    matchedAnyRule = true;
    const rest = rule.exact ? "" : specifier.slice(rule.prefix.length);
    for (const target of rule.targets) {
      const hit = existingFile(rule.dir, target.replace("*", rest));
      if (hit !== null) return classify(hit);
    }
  }
  // A rule matched but nothing on disk satisfied any candidate: the scan cannot
  // see a reference that probably exists, so it must be reported.
  if (matchedAnyRule) return { kind: "unresolved", specifier };

  // No alias matched and it is not relative: an external package. Correct to skip.
  return { kind: "external" };
}

function walk(relativeRoot: string): string[] {
  const absoluteRoot = path.join(REPO_ROOT, relativeRoot);
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".artifacts" || entry === "dist") continue;
      const child = path.join(dir, entry);
      if (statSync(child).isDirectory()) {
        visit(child);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) found.push(child);
    }
  };
  if (statSync(absoluteRoot, { throwIfNoEntry: false })?.isDirectory()) visit(absoluteRoot);
  return found;
}

function toRepoId(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

describe("no source module has zero recognized direct inbound references", () => {
  const sources = SOURCE_ROOTS.flatMap((root) =>
    walk(root).map((absolute) => ({
      id: toRepoId(absolute),
      absolute,
      scan: scanSource(readFileSync(absolute, "utf8")),
    })),
  );
  const known = new Set(sources.map((s) => s.id));
  const rules = aliasRules();

  const referenced = new Set<string>();
  const unresolved: string[] = [];
  const opaque: string[] = [];

  for (const holder of [...sources.map((s) => s.absolute), ...walk("tests"), ...walk("scripts")]) {
    const scan =
      sources.find((s) => s.absolute === holder)?.scan ?? scanSource(readFileSync(holder, "utf8"));
    const holderId = toRepoId(holder);

    if (known.has(holderId) && opaqueDynamicImports(scan).length > 0) opaque.push(holderId);
    for (const specifier of specifiersIn(scan)) {
      const result = resolveSpecifier(specifier, holderId, rules, known);
      if (result.kind === "resolved") referenced.add(result.id);
      else if (result.kind === "unresolved") unresolved.push(`${holderId} -> ${specifier}`);
    }
  }

  const orphans = sources
    .map((s) => s.id)
    .filter((id) => !referenced.has(id) && !ENTRY_POINTS.has(id))
    .filter((id) => !ALLOWED_ORPHANS.some((entry) => entry.file === id))
    .sort();

  it("finds the sources it is meant to inspect", () => {
    // Non-vacuity. If the walk broke, every assertion below would pass because
    // the orphan set would be empty.
    expect(sources.length).toBeGreaterThan(300);
  });

  it("reads the alias configuration it depends on", () => {
    // If `paths` stopped being found, every alias would look unresolved and the
    // failure would be reported as unresolved specifiers rather than as a broken
    // reader. This names the actual cause.
    expect(rules.length).toBeGreaterThan(0);
  });

  it("resolves every specifier it saw, or says which one it could not", () => {
    expect(unresolved).toEqual([]);
  });

  it("can read every source file's dynamic imports", () => {
    expect(opaque).toEqual([]);
  });

  it("has no module with zero direct inbound references", () => {
    expect(orphans).toEqual([]);
  });

  it("keeps every allowed orphan real, and still carrying its stated reason", () => {
    for (const { file, marker } of ALLOWED_ORPHANS) {
      const absolute = path.join(REPO_ROOT, file);
      expect(statSync(absolute, { throwIfNoEntry: false })?.isFile()).toBe(true);
      expect(readFileSync(absolute, "utf8")).toContain(marker);
    }
  });

  it("keeps every declared entry point real", () => {
    // An allowlist naming a deleted file would make this gate quietly wrong.
    for (const entry of ENTRY_POINTS) {
      expect(statSync(path.join(REPO_ROOT, entry), { throwIfNoEntry: false })?.isFile()).toBe(true);
    }
  });
});

describe("the scanner's own reader behaves", () => {
  it("ignores commented-out imports when counting references", () => {
    // The real case in this repository: a JSDoc {@link import("../x")} in
    // `src/context/memory/enablement.ts` is a comment, not a reference. Before
    // comments were stripped, that line would have masked a genuine orphan.
    const scan = scanSource(
      [
        'import { a } from "./real";',
        '// import { b } from "./commented-out";',
        '/* import { c } from "./block-commented"; */',
        '/** see {@link import("./in-jsdoc")} */',
        'const url = "https://example.com//not-a-comment";',
      ].join("\n"),
    );
    expect(specifiersIn(scan)).toEqual(["./real"]);
    // A naive regex strip would have eaten the URL; this one must not.
    expect(scan.text).toContain("https://example.com//not-a-comment");
  });

  it("does not read an import written inside a string as an import", () => {
    // Test fixtures embed the literal text `from "./thing"` as data. A regex
    // cannot tell that from code, which is why the scan carries a code mask.
    const scan = scanSource(["const sample = 'import { b } from \"./data\";';"].join("\n"));
    expect(specifiersIn(scan)).toEqual([]);
  });

  it("reads a non-literal dynamic import as unreadable rather than as none", () => {
    expect(opaqueDynamicImports(scanSource("await import(targetPath);"))).toHaveLength(1);
    expect(opaqueDynamicImports(scanSource('await import("./real");'))).toHaveLength(0);
    expect(opaqueDynamicImports(scanSource("// await import(x);"))).toHaveLength(0);
    // The interpolation marker is concatenated rather than written inline:
    // Biome's noTemplateCurlyInString is right to flag `${` in a plain string,
    // and suppressing it here would hide the same mistake everywhere else. This
    // is test data whose entire purpose is to contain an interpolation.
    const interpolation = "$" + "{id}";
    expect(
      // biome-ignore lint/style/useTemplate: intentional string concatenation to avoid noTemplateCurlyInString
      opaqueDynamicImports(scanSource("await import(`./x/" + interpolation + "`);")),
    ).toHaveLength(1);
  });

  it("keeps offsets stable so a scanned file still has the same length", () => {
    const sample = "const a = 1; // gone\nconst b = 2;\n";
    expect(scanSource(sample).text).toHaveLength(sample.length);
  });
});

/**
 * Regression tests for alias resolution, run against the REAL `resolveSpecifier`
 * exported above and the REAL files on disk.
 *
 * The bug these cover: `@/*` is declared twice with different bases — `src/*` in
 * the root tsconfig, `web/src/*` in the web one — so a web `@/` import could be
 * credited to a backend module purely because the repository root was tried
 * first. Four modules in this repository have the same path under both roots.
 */
describe("aliases resolve against the importing project, not a fixed order", () => {
  const rules = aliasRules();
  const known = new Set(
    SOURCE_ROOTS.flatMap((root) => walk(root)).map((absolute) => toRepoId(absolute)),
  );

  /** Resolve as if written by `importerId`, and return the module credited. */
  function credited(importerId: string, specifier: string): string | null {
    const result = resolveSpecifier(specifier, importerId, rules, known);
    return result.kind === "resolved" ? result.id : null;
  }

  const OVERLAPPING: ReadonlyArray<{ readonly specifier: string; readonly web: string }> = [
    { specifier: "@/lib/logger", web: "web/src/lib/logger.ts" },
    { specifier: "@/lib/utils", web: "web/src/lib/utils.ts" },
    { specifier: "@/lib/log-scopes", web: "web/src/lib/log-scopes.ts" },
    { specifier: "@/types", web: "web/src/types/index.ts" },
  ];

  it("confirms every overlapping name really does exist under both roots", () => {
    // Non-vacuity: if a twin were deleted, the cases below would stop proving
    // anything and this should be the failure that reports it.
    for (const { specifier, web } of OVERLAPPING) {
      const tail = specifier.slice("@/".length);
      expect(existingFile("", `./src/${tail}`), `backend twin for ${specifier}`).not.toBeNull();
      expect(existingFile("web", `./src/${tail}`), `web module for ${specifier}`).not.toBeNull();
      expect(web).toBe(existingFile("web", `./src/${tail}`));
    }
  });

  for (const { specifier, web } of OVERLAPPING) {
    it(`credits a web import of ${specifier} to the WEB module`, () => {
      expect(credited("web/src/components/SomeFile.tsx", specifier)).toBe(web);
    });
  }

  it("still credits a backend import of the same names to the BACKEND module", () => {
    // The same specifier from a backend importer must resolve the other way.
    expect(credited("src/services/some-service.ts", "@/lib/logger")).toBe("src/lib/logger.ts");
    expect(credited("src/services/some-service.ts", "@/lib/utils")).toBe("src/lib/utils.ts");
  });

  it("still resolves backend-only and web-only paths for the projects that own them", () => {
    // A TEST importer may reach either project: `@/` is ambiguous there, since
    // `tests/tsconfig.backend.json` maps it to `src/*` and
    // `tests/tsconfig.web.json` maps it to `web/src/*`.
    expect(credited("tests/integration/x.test.ts", "@/context/types")).toBe("src/context/types.ts");
    // A WEB importer's `@/` stays inside `web/src`. It must NOT silently reach
    // the backend — that is covered explicitly in the next describe block.
    expect(credited("web/src/app/router.tsx", "@/components/ChatWindow")).toBe(
      "web/src/components/ChatWindow.tsx",
    );
  });

  it("still resolves the cross-project test aliases", () => {
    // `@backend/*` points into `src/`, which IS a source module, so it credits.
    expect(credited("tests/integration/x.test.ts", "@backend/types")).toBe("src/types/index.ts");
    // `@web/testing/*` points at a test helper — a real file, but outside the
    // source set this gate has authority over. It must be `external`
    // (correctly out of scope), never `unresolved` (a scan it could not read).
    const helper = resolveSpecifier(
      "@web/testing/source-scope",
      "tests/dom/opencode/x.test.tsx",
      rules,
      known,
    );
    expect(helper.kind).toBe("external");
  });

  it("still classifies an npm package as external, not unresolved", () => {
    const result = resolveSpecifier("@opencode/client", "web/src/features/x.ts", rules, known);
    expect(result.kind).toBe("external");
  });

  it("still reports an alias that matches the config but resolves nowhere", () => {
    const result = resolveSpecifier(
      "@/definitely-not-here",
      "web/src/components/x.ts",
      rules,
      known,
    );
    expect(result.kind).toBe("unresolved");
  });

  it("does not credit a backend twin when the web module is the real target", () => {
    // The precise failure the ordering bug produced: the backend twin gained a
    // reference it does not have.
    for (const { specifier } of OVERLAPPING) {
      const tail = specifier.slice("@/".length);
      const twin = existingFile("", `./src/${tail}`);
      if (twin === null) continue;
      const fromWeb = credited("web/src/components/SomeFile.tsx", specifier);
      expect(fromWeb, `${specifier} from web must not credit ${twin}`).not.toBe(twin);
    }
  });
});

/**
 * A project-scoped `@/` must not reach into the OTHER project when the target is
 * absent from its own alias root.
 *
 * `@/context/types` is the honest witness in this repository: `src/context/types.ts`
 * exists and `web/src/context/types.ts` does not. A web file writing `@/context/types`
 * is asking for a web module that does not exist — the backend file it would land
 * on is a different module that happens to share a name, and the web tsconfig's
 * `@/*` does not permit reaching it. Resolving it anyway credits `src/` with a
 * reference it never received.
 *
 * Reaching the backend from the web (or a test) is legitimate — but only through
 * the aliases declared for it: `@backend/*` and `@web/*`.
 */
describe("a project-scoped alias does not fall back into the other project", () => {
  const rules = aliasRules();
  const known = new Set(
    SOURCE_ROOTS.flatMap((root) => walk(root)).map((absolute) => toRepoId(absolute)),
  );
  const WEB_IMPORTER = "web/src/components/SomeFile.tsx";

  function resolveFrom(specifier: string, importerId: string) {
    return resolveSpecifier(specifier, importerId, rules, known);
  }

  it("confirms the witness: the backend file exists and the web one does not", () => {
    // Non-vacuity. If a `web/src/context/types.ts` were ever added, the case
    // below would stop proving anything and this is what should say so.
    expect(existingFile("", "./src/context/types")).toBe("src/context/types.ts");
    expect(existingFile("web", "./src/context/types")).toBeNull();
  });

  it("does NOT credit src/context/types.ts for a web `@/context/types` import", () => {
    const result = resolveFrom("@/context/types", WEB_IMPORTER);
    // Must not silently become a reference to the backend module...
    expect(result.kind).not.toBe("resolved");
    // ...it must be reported as an unreadable reference, because the scan cannot
    // confirm one. That is the honest answer and it fails the suite loudly.
    expect(result.kind).toBe("unresolved");
  });

  it("does the same for a web `@/` import of a backend-only module", () => {
    // These have no counterpart under `web/src` at all, so the alias simply has
    // no target. `@/lib/logger` is deliberately NOT in this list: it exists on
    // both sides and is an overlap case, resolved by the previous test.
    for (const specifier of ["@/services/tools", "@/context/types", "@/routes/chat"]) {
      const result = resolveFrom(specifier, WEB_IMPORTER);
      expect(result.kind, `${specifier} from web must not resolve`).toBe("unresolved");
    }
  });

  it("still resolves the web project's own `@/` imports", () => {
    expect(resolveFrom("@/lib/logger", WEB_IMPORTER).kind).toBe("resolved");
    expect(resolveFrom("@/lib/utils", WEB_IMPORTER).kind).toBe("resolved");
    expect(resolveFrom("@/components/ChatWindow", WEB_IMPORTER)).toMatchObject({
      kind: "resolved",
      id: "web/src/components/ChatWindow.tsx",
    });
  });

  it("preserves explicit cross-project access via @backend/*", () => {
    // The alias that EXISTS for reaching the backend from elsewhere.
    expect(resolveFrom("@backend/context/types", WEB_IMPORTER)).toMatchObject({
      kind: "resolved",
      id: "src/context/types.ts",
    });
  });

  it("preserves explicit cross-project access via @web/*", () => {
    expect(
      resolveFrom("@web/components/ChatWindow", "tests/dom/opencode/x.test.tsx"),
    ).toMatchObject({
      kind: "resolved",
      id: "web/src/components/ChatWindow.tsx",
    });
  });

  it("a backend importer's `@/` still resolves inside the backend", () => {
    expect(resolveFrom("@/context/types", "src/services/some-service.ts")).toMatchObject({
      kind: "resolved",
      id: "src/context/types.ts",
    });
  });

  it("a test importer may still reach either project, since `@/` is ambiguous there", () => {
    // `tests/tsconfig.backend.json` maps `@/*` to `src/*` while
    // `tests/tsconfig.web.json` maps it to `web/src/*`, so tests genuinely have
    // two valid answers and both roots remain in scope for them.
    expect(resolveFrom("@/context/types", "tests/integration/x.test.ts")).toMatchObject({
      kind: "resolved",
      id: "src/context/types.ts",
    });
    expect(resolveFrom("@/components/ChatWindow", "tests/integration/x.test.ts")).toMatchObject({
      kind: "resolved",
      id: "web/src/components/ChatWindow.tsx",
    });
  });

  it("no source module in the repository currently relies on the fallback", () => {
    // If a web file really did import a backend module through `@/`, the scan
    // would now report it as unresolved and the suite above would fail. This
    // states the expectation in words so the cause is obvious if it ever does.
    expect(resolveFrom("@/context/types", WEB_IMPORTER).kind).toBe("unresolved");
  });
});
