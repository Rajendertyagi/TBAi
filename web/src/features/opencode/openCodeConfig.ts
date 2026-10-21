/**
 * Reading and writing the OpenCode configuration the managed V2 server
 * actually consumes, as a typed boundary for the settings page.
 *
 * ## Why the backend is asked and not the file
 *
 * TBAi spawns `opencode serve` with its cwd inside TBAi's own data directory,
 * which makes `data/opencode-home/opencode.json` look authoritative. It is not:
 * the live server reports the permissions document as living in the user's
 * XDG-resolved config directory. This module therefore never computes a path —
 * it reads the document the server names, and every write goes back through the
 * server's own REST boundary.
 *
 * ## What is deliberately absent
 *
 * No permission defaults, no rule ordering policy, no merge logic. OpenCode
 * owns what a rule means; this owns how the bytes get there. A rule the user
 * has not set is shown as "not configured", never as a value TBAi invented.
 */

import { apiFetch } from "@/lib/platform";

/** The three effects OpenCode's V2 schema accepts for a permission rule. */
export type OpenCodePermissionEffect = "allow" | "ask" | "deny";

/** One rule, exactly as OpenCode's `PermissionRule` declares it. */
export interface OpenCodePermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: OpenCodePermissionEffect;
}

/**
 * One rule **as it sits in the configuration file**, with the position it
 * holds there.
 *
 * The position is not the row number on screen: rules the page cannot read
 * are dropped from the list, so the screen's row N is not necessarily the
 * file's rule N. A write has to name the FILE's position, or it addresses a
 * different rule than the one the user clicked.
 */
export interface OpenCodePermissionRow {
  readonly rule: OpenCodePermissionRule;
  /** The rule's index in the configuration file's own `permissions` array. */
  readonly index: number;
}

/** The server's answer for `GET /api/opencode/config`. */
export interface OpenCodeConfigSnapshot {
  /** The document TBAi reads and edits. */
  readonly path: string;
  /** Every config source the server reported, in precedence order. */
  readonly discoveredPaths: readonly string[];
  /** The file's raw text, for the native-JSON view. */
  readonly raw: string;
  /** True when the text is not a JSON object. Nothing may be written. */
  readonly malformed: boolean;
  /** The document's `permissions` value, or null when the key is absent. */
  readonly permissions: readonly unknown[] | null;
  /** Whether a write is permitted at all. */
  readonly editable: boolean;
}

/** Raised when the config boundary refuses or fails, carrying its message. */
export class OpenCodeConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OpenCodeConfigError";
  }
}

function isEffect(value: unknown): value is OpenCodePermissionEffect {
  return value === "allow" || value === "ask" || value === "deny";
}

/**
 * Narrows one untrusted rule to the shape the UI renders.
 *
 * A rule missing an action or resource, or carrying an effect outside the
 * three OpenCode accepts, is DROPPED rather than coerced — the page must not
 * show an effect the server would not honour. The count of dropped rules is
 * reported so the UI can say the list is incomplete instead of quietly
 * presenting a partial policy as the whole one.
 */
export function toPermissionRules(value: unknown): {
  rules: OpenCodePermissionRow[];
  skipped: number;
} {
  if (value === null || value === undefined) return { rules: [], skipped: 0 };
  if (!Array.isArray(value)) return { rules: [], skipped: 1 };
  const rules: OpenCodePermissionRow[] = [];
  let skipped = 0;
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      skipped += 1;
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.action !== "string" ||
      candidate.action.length === 0 ||
      typeof candidate.resource !== "string" ||
      candidate.resource.length === 0 ||
      !isEffect(candidate.effect)
    ) {
      skipped += 1;
      continue;
    }
    rules.push({
      rule: {
        action: candidate.action,
        resource: candidate.resource,
        effect: candidate.effect,
      },
      // The position in the FILE, not in the filtered list: a rule the page
      // cannot read still occupies its place in the array.
      index,
    });
  }
  return { rules, skipped };
}

/**
 * Fetches the live OpenCode configuration.
 *
 * @returns The snapshot, with `permissions` already narrowed to renderable rules.
 * @throws {OpenCodeConfigError} When the request fails or the server refuses.
 */
export async function fetchOpenCodeConfig(): Promise<OpenCodeConfigSnapshot> {
  const response = await apiFetch("/api/opencode/config");
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body !== null &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Failed to read OpenCode configuration (${response.status})`;
    throw new OpenCodeConfigError(message);
  }
  if (body === null || typeof body !== "object") {
    throw new OpenCodeConfigError("OpenCode returned an unreadable configuration");
  }
  const record = body as Record<string, unknown>;
  return {
    path: typeof record.path === "string" ? record.path : "",
    discoveredPaths: Array.isArray(record.discoveredPaths)
      ? (record.discoveredPaths as string[])
      : [],
    raw: typeof record.raw === "string" ? record.raw : "",
    malformed: record.malformed === true,
    // The RAW array, deliberately not narrowed here: narrowing it here would
    // drop the rules the page cannot read, and the page's own parse needs
    // them to know each rule's POSITION in the file. The page narrows them,
    // with the file index attached.
    permissions: Array.isArray(record.permissions) ? record.permissions : null,
    editable: record.editable === true,
  };
}

/** What a successful or refused permission write reports back. */
export interface OpenCodePermissionWriteResult {
  readonly path: string;
  /** False when the change was a no-op; nothing was written. */
  readonly changed: boolean;
}

/**
 * Adds one rule to the END of the array.
 *
 * End means highest precedence, because OpenCode resolves the array
 * last-match-wins. The page says so on the button rather than hiding it — a
 * rule whose position silently decides what it overrides is not something to
 * discover afterwards.
 *
 * @param rule - The action, resource and effect to append.
 * @returns Whether the file was rewritten.
 * @throws {OpenCodeConfigError} When the rule is a duplicate or the write is refused.
 */
export async function addOpenCodePermissionRule(
  rule: OpenCodePermissionRule,
): Promise<OpenCodePermissionWriteResult> {
  return postPermissionChange("/api/opencode/config/permissions", { ...rule });
}

/**
 * Removes one rule, addressed by the position the page rendered it at AND its
 * identity. The backend re-checks both against the file, so a rule that moved
 * or changed on disk is refused rather than deleted by position alone.
 *
 * @param index - The position the page rendered the rule at.
 * @param rule - The rule as rendered, used to detect a stale position.
 * @returns Whether the file was rewritten.
 * @throws {OpenCodeConfigError} When the rule moved or the write is refused.
 */
export async function removeOpenCodePermissionRule(
  index: number,
  rule: OpenCodePermissionRule,
): Promise<OpenCodePermissionWriteResult> {
  return postPermissionChange("/api/opencode/config/permissions", { ...rule, index }, "DELETE");
}

/** Shared request helper for the add/remove routes. */
async function postPermissionChange(
  url: string,
  body: Record<string, unknown>,
  method: "POST" | "DELETE" = "POST",
): Promise<OpenCodePermissionWriteResult> {
  const response = await apiFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `Request failed (${response.status})`;
    throw new OpenCodeConfigError(message);
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  return {
    path: typeof record.path === "string" ? record.path : "",
    changed: record.changed === true,
  };
}

/**
 * Changes ONE rule's effect in the real OpenCode configuration.
 *
 * The request carries the rule's **position in the file**, its identity, and
 * the new effect — never a document. That is the preservation guarantee: the
 * backend re-reads the file and edits one entry, so unrelated rules, their
 * order, and any config field TBAi does not model are untouched by
 * construction rather than by care.
 *
 * The position is what makes a rule that appears TWICE editable: with two
 * identical `(action, resource)` pairs the identity alone names both of them,
 * and the backend would have to guess which one the user meant. The backend
 * re-checks the identity at that position before writing, so a rule that moved
 * or changed since the page read it is refused instead of edited.
 *
 * @param index - The rule's position in the configuration file's array.
 * @param rule - The rule as the page read it, used to detect a stale position.
 * @param effect - The effect to write.
 * @returns Whether the document was actually rewritten.
 * @throws {OpenCodeConfigError} When the write is refused or the request fails.
 */
export async function saveOpenCodePermissionEffect(
  index: number,
  rule: OpenCodePermissionRule,
  effect: OpenCodePermissionEffect,
): Promise<OpenCodePermissionWriteResult> {
  const response = await apiFetch("/api/opencode/config/permissions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      index,
      action: rule.action,
      resource: rule.resource,
      effect,
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body !== null &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Failed to save (${response.status})`;
    throw new OpenCodeConfigError(message);
  }
  const record = (body ?? {}) as Record<string, unknown>;
  return {
    path: typeof record.path === "string" ? record.path : "",
    changed: record.changed === true,
  };
}
