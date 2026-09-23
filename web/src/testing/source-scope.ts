/**
 * Source-scoping helpers for the source-level guard tests.
 *
 * `web/` has no component-test runner (no DOM under `bun test`, and jsdom /
 * happy-dom are not dependencies), so a few contracts can only be asserted
 * against the source text. Those assertions must be *scoped*, because a
 * whole-file `toContain` also matches the import line, a doc comment, or a
 * passing mention — none of which prove the component itself does the thing.
 *
 * Two rules follow, and both are enforced by the helpers here:
 *  1. Strip comments first, so prose describing a rule can never satisfy a
 *     test for the rule.
 *  2. Extract the component's own body, so a match has to be inside it.
 *
 * Shared rather than copied into each test file: duplicated test
 * infrastructure is how two guard tests drift apart and start disagreeing
 * about what "the surface does X" means.
 */

/** Remove comments, so prose about a rule cannot be mistaken for the rule. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * The body of a named function, found by matching its braces.
 *
 * Walks the parameter list before looking for the body, because the params are
 * destructured (their `{` is not the body) and a type annotation may carry
 * braces of its own.
 */
export function functionBody(source: string, name: string): string {
  const decl = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (decl == null) throw new Error(`${name} is not declared in this source`);

  let depth = 0;
  let i = source.indexOf("(", decl.index);
  for (; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }

  const open = source.indexOf("{", i);
  if (open === -1) throw new Error(`${name} has no body`);

  depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, j + 1);
    }
  }
  throw new Error(`${name}'s body is unbalanced`);
}

/** Read a file beside the calling test and return its comment-free body. */
export async function commentedBodyOf(
  name: string,
  relativeFile: string,
  base: string,
): Promise<string> {
  const source = await Bun.file(new URL(relativeFile, base)).text();
  return functionBody(stripComments(source), name);
}

/**
 * The body of a `const name = ... => { ... }` arrow function, brace-matched
 * like `functionBody`. Same scoping rules: comments already stripped, match
 * must sit inside the arrow's own braces.
 */
export function constBody(source: string, name: string): string {
  const decl = new RegExp(`const\\s+${name}\\s*=`).exec(source);
  if (decl == null) throw new Error(`${name} is not declared in this source`);
  const arrow = source.indexOf("=>", decl.index);
  if (arrow === -1) throw new Error(`${name} is not an arrow function`);
  const open = source.indexOf("{", arrow);
  if (open === -1) throw new Error(`${name} has no body`);

  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, j + 1);
    }
  }
  throw new Error(`${name}'s body is unbalanced`);
}

/** Read a file beside the calling test and return a const-arrow body. */
export async function commentedConstBodyOf(
  name: string,
  relativeFile: string,
  base: string,
): Promise<string> {
  const source = await Bun.file(new URL(relativeFile, base)).text();
  return constBody(stripComments(source), name);
}
