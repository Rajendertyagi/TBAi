/**
 * Which permission rule a LATER rule overrides.
 *
 * ## The upstream's rule (verified live, not inferred)
 *
 * OpenCode resolves a permission request with `findLast` over the rules that
 * MATCH it, and the match is a wildcard:
 *
 * ```ts
 * rulesets.flat().findLast(
 *   (rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource),
 * )
 * ```
 *
 * That was confirmed against a live managed `opencode serve` (2.0.32) with an
 * isolated configuration, driving a real `shell` tool call through the
 * repository's own stub provider:
 *
 * | ruleset (same action)                        | observed                                     |
 * |-----------------------------------------------|----------------------------------------------|
 * | `*` allow                                     | the call RAN                                 |
 * | `*` ask                                       | the server ASKED (`permission.asked`)          |
 * | `*` deny                                      | the tool was not even offered to the model   |
 * | `*` allow, then `*` deny                      | not offered — the LAST rule won               |
 * | `*` deny, then `*` allow                      | offered and RAN — the LAST rule won           |
 * | `*` allow, then `git *` deny (command `git status`) | refused: "Permission denied: shell"     |
 * | `*` allow, then `git *` deny (command `echo hi`)   | RAN                                  |
 * | `git *` ask (command `git status`)            | ASKED, with the resource `["git status"]`     |
 * | `git *` ask (command `echo hi`)               | not asked — the rule did not match            |
 * | `write` deny (command `echo hi` via `shell`)  | the `shell` call RAN — the action is the tool name |
 *
 * So: the **last** matching rule wins, the **action** is matched against the
 * tool's name, the **resource** is matched against the command string, and a
 * `deny` rule also removes the tool from the list the model is offered.
 *
 * ## What this module computes — and what it deliberately does not
 *
 * This is NOT the upstream's evaluation. TBAi does not evaluate permissions;
 * OpenCode does, and re-implementing that here is forbidden by the plan.
 *
 * What TBAi owns is a **display** question: *is this row the one that wins?*
 * A row is overridden when a LATER rule matches everything it matches, because
 * then the later rule is always selected in its place.
 *
 * The relation is computed with **exact string comparisons and one fact about
 * the upstream's wildcard** — that `*` matches every string (the upstream
 * compiles it to `.*` under the `s` flag, so it matches any input). That is
 * enough to answer the question soundly:
 *
 * - a later rule with the SAME action and resource overrides the earlier one
 *   completely: it matches exactly the same requests, and it is later;
 * - a later rule whose action or resource is `*` overrides the earlier one
 *   completely when the OTHER dimension is the same or also `*`;
 * - a later rule that is NARROWER than the earlier one overrides it only for
 *   the resources it matches — the earlier rule still applies to the rest.
 *
 * Every claim this module makes is therefore **sound**: it never reports an
 * override that OpenCode would not act on. It is deliberately incomplete: two
 * overlapping patterns whose relation cannot be decided from equality and `*`
 * alone are reported as *not* overridden, because guessing would be worse than
 * saying nothing.
 */

/** One permission rule, as it appears in the configuration file. */
export interface PermissionRuleLike {
  readonly action: string;
  readonly resource: string;
}

/** How a later rule overrides the rule at a given index. */
export type PermissionOverride =
  /** Nothing later overrides this rule. */
  | { readonly kind: "none" }
  /**
   * A later rule matches everything this rule matches, so this rule is never
   * the one that wins.
   */
  | { readonly kind: "full"; readonly byIndex: number }
  /**
   * A later, narrower rule wins for the resources it matches; this rule still
   * applies to the rest.
   */
  | { readonly kind: "partial"; readonly byIndex: number };

/**
 * Whether `pattern` matches every string `other` matches.
 *
 * Sound by construction: equal patterns match the same strings, and `*` is the
 * upstream's everything-pattern.
 */
function coversEvery(pattern: string, other: string): boolean {
  return pattern === "*" || pattern === other;
}

/**
 * Whether `rule` matches every request `other` matches.
 *
 * Both dimensions must be covered — a rule that matches every action but only
 * one resource does not shadow a rule that matches one action and every
 * resource.
 */
function coversEveryRequest(rule: PermissionRuleLike, other: PermissionRuleLike): boolean {
  return coversEvery(rule.action, other.action) && coversEvery(rule.resource, other.resource);
}

/**
 * Whether `rule` matches a strict superset of the requests `other` matches.
 *
 * Used to recognise the "a later, narrower rule shadows this one for part of
 * its range" case.
 */
function isStrictlyBroader(rule: PermissionRuleLike, other: PermissionRuleLike): boolean {
  if (!coversEveryRequest(rule, other)) return false;
  return !(rule.action === other.action && rule.resource === other.resource);
}

/**
 * The rule that overrides the one at `index`, if any.
 *
 * ## The index space
 *
 * `rules` is indexed by the rule's position **in the configuration file**,
 * not by its position in a filtered list. A rule the page cannot read still
 * occupies its place in the file, and OpenCode resolves the file's array —
 * so the relation must be computed over the file's own order. A hole in the
 * array is a rule the page could not read: it is skipped, because an
 * unreadable rule cannot be shown to override anything.
 *
 * @param rules - The ruleset in the file's order, indexed by file position.
 * @param index - The file position of the rule being asked about.
 * @returns Which later rule overrides it, and how completely. `byIndex` is a
 *   file position, so the row number it names is the file's row number.
 */
export function findPermissionOverride(
  rules: readonly (PermissionRuleLike | undefined)[],
  index: number,
): PermissionOverride {
  const rule = rules[index];
  if (!rule) return { kind: "none" };

  let partial: PermissionOverride = { kind: "none" };
  for (let later = index + 1; later < rules.length; later += 1) {
    const candidate = rules[later];
    if (!candidate) continue;
    // A later rule that matches everything this rule matches always wins in
    // its place, so this rule can never be the one selected.
    if (coversEveryRequest(candidate, rule)) {
      return { kind: "full", byIndex: later };
    }
    // A later rule that is narrower wins only for what it matches.
    if (partial.kind === "none" && isStrictlyBroader(rule, candidate)) {
      partial = { kind: "partial", byIndex: later };
    }
  }
  return partial;
}
