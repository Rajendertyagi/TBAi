/**
 * Read the source of the `POST /api/chat` route as one body, for tests that
 * assert on the route's TEXT rather than on its runtime behaviour.
 *
 * ## Why this exists
 *
 * Several boundary tests read `src/routes/chat.ts` and assert that something
 * appears in it exactly once, or that a value flows from one place to another.
 * That is a real invariant — "the memory seam is supplied once", "cache options
 * are merged into the single `providerOptions` argument", "the route
 * contributes no system prompt of its own". But pinning those assertions to one
 * FILE made them assertions about layout, and they started failing the moment
 * the route was split into phase modules under `src/routes/chat/`.
 *
 * These tests were never trying to say "this lives in chat.ts". They were trying
 * to say "this lives in the Direct route". This helper states the second thing.
 *
 * ## Why an explicit list, not a directory walk
 *
 * Walking `src/routes/chat/` would silently widen the blast radius every time a
 * phase module is added: a new module's unrelated `assembleContext(` or
 * `instructions:` would break a test about a different concern, and the failure
 * would point at the wrong file. An explicit list forces a deliberate decision
 * whenever the route gains a module, and the assertion stays scoped to the
 * concern it was written for.
 *
 * `readDirectRouteSource(["assemble-run.ts"])` reads chat.ts plus that one
 * module. Adding a phase means adding it here, on purpose.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./repo-root";

/**
 * Phase modules that make up the Direct route, in pipeline order.
 *
 * Deliberately not auto-discovered. See the module note above.
 */
export const DIRECT_ROUTE_MODULES = [
  "validate-and-resolve.ts",
  "assemble-run.ts",
] as const;

export type DirectRouteModule = (typeof DIRECT_ROUTE_MODULES)[number];

/** The route entry file itself, which stays in `src/routes/`. */
export const DIRECT_ROUTE_ENTRY = "src/routes/chat.ts";

/**
 * Concatenate the route entry with the named phase modules.
 *
 * Throws if a named module does not exist rather than silently reading fewer
 * files than the caller asked for — a missing module would otherwise turn a
 * "must appear exactly once" assertion into a vacuous pass.
 *
 * @param modules Phase modules to include, beyond the entry file.
 * @returns The combined source text.
 * @throws If a named module does not exist.
 */
export function readDirectRouteSource(modules: readonly string[] = []): string {
  const parts = [readFileSync(path.join(REPO_ROOT, DIRECT_ROUTE_ENTRY), "utf8")];
  for (const name of modules) {
    const file = path.join(REPO_ROOT, "src/routes/chat", name);
    try {
      parts.push(readFileSync(file, "utf8"));
    } catch {
      throw new Error(
        `readDirectRouteSource: ${file} does not exist. The Direct route's phase ` +
          `modules changed - add the module that owns this invariant.`,
      );
    }
  }
  return parts.join("\n");
}