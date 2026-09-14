import { generateId } from "../lib/utils";
import type { WorkspaceGrant } from "./tools";

/**
 * One-shot outside-workspace authorizations.
 *
 * A grant admits exactly one operation on one canonical target for one
 * conversation: `{ conversationId, tool, resolvedTarget }` + single-use
 * (`consumed`) + 10-minute TTL. Grants never widen the workspace root — they
 * are checked inside `resolveSafe` against the freshly re-resolved target, so
 * a symlink/junction swapped between approval and execution fails closed.
 *
 * Process-local like `chatRuns` (same lifetime reasoning): a restart wipes
 * pending grants and any replay must re-prompt. Sweeping is lazy — every
 * mutation prunes expired/consumed records, so no background loop.
 */

const GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_GRANTS = 500;

const grants = new Map<string, WorkspaceGrant>();

function sweep(now = Date.now()): void {
  for (const [id, g] of grants) {
    if (g.consumed || now > g.expiresAt) grants.delete(id);
  }
  if (grants.size > MAX_GRANTS) {
    const ordered = [...grants.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const g of ordered.slice(0, grants.size - MAX_GRANTS)) {
      grants.delete(g.id);
    }
  }
}

const sameTarget = (a: string, b: string): boolean =>
  process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;

export function mintGrant(opts: {
  conversationId: string;
  tool: string;
  resolvedTarget: string;
  ttlMs?: number;
}): WorkspaceGrant {
  sweep();
  const now = Date.now();
  const grant: WorkspaceGrant = {
    id: generateId(),
    conversationId: opts.conversationId,
    tool: opts.tool,
    resolvedTarget: opts.resolvedTarget,
    createdAt: now,
    expiresAt: now + (opts.ttlMs ?? GRANT_TTL_MS),
    consumed: false,
  };
  grants.set(grant.id, grant);
  return grant;
}

/**
 * Consume a live grant matching conversation + tool + canonical target.
 * Returns the grant on first match, null otherwise (unknown, expired,
 * already consumed, or different target — all fail closed at the caller).
 */
export function consumeGrant(
  conversationId: string,
  tool: string,
  resolvedTarget: string,
): WorkspaceGrant | null {
  sweep();
  for (const g of grants.values()) {
    if (
      !g.consumed &&
      g.conversationId === conversationId &&
      g.tool === tool &&
      sameTarget(g.resolvedTarget, resolvedTarget)
    ) {
      g.consumed = true;
      return g;
    }
  }
  return null;
}

/** For tests and diagnostics. */
export function grantCounts(): { live: number; total: number } {
  sweep();
  let live = 0;
  for (const g of grants.values()) if (!g.consumed) live += 1;
  return { live, total: grants.size };
}
