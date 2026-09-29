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

/** The three effects OpenCode's V2 schema accepts for a permission rule. */
export type OpenCodePermissionEffect = "allow" | "ask" | "deny";

/** One rule, exactly as OpenCode's `PermissionRule` declares it. */
export interface OpenCodePermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: OpenCodePermissionEffect;
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
  readonly permissions: readonly OpenCodePermissionRule[] | null;
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
  rules: OpenCodePermissionRule[];
  skipped: number;
} {
  if (value === null || value === undefined) return { rules: [], skipped: 0 };
  if (!Array.isArray(value)) return { rules: [], skipped: 1 };
  const rules: OpenCodePermissionRule[] = [];
  let skipped = 0;
  for (const entry of value) {
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
      action: candidate.action,
      resource: candidate.resource,
      effect: candidate.effect,
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
  const response = await fetch("/api/opencode/config");
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
  const { rules } = toPermissionRules(record.permissions);
  return {
    path: typeof record.path === "string" ? record.path : "",
    discoveredPaths: Array.isArray(record.discoveredPaths)
      ? (record.discoveredPaths as string[])
      : [],
    raw: typeof record.raw === "string" ? record.raw : "",
    malformed: record.malformed === true,
    permissions: Array.isArray(record.permissions) ? rules : null,
    editable: record.editable === true,
  };
}

/** What a successful or refused permission write reports back. */
export interface OpenCodePermissionWriteResult {
  readonly path: string;
  /** False when the rule was already at that effect; nothing was written. */
  readonly changed: boolean;
}

/**
 * Changes ONE rule's effect in the real OpenCode configuration.
 *
 * The request carries only the rule's identity and the new effect — never a
 * document. That is the preservation guarantee: the backend re-reads the file
 * and edits one entry, so unrelated rules, their order, and any config field
 * TBAi does not model are untouched by construction rather than by care.
 *
 * @param rule - The rule to change, identified by action + resource.
 * @param effect - The effect to write.
 * @returns Whether the document was actually rewritten.
 * @throws {OpenCodeConfigError} When the write is refused or the request fails.
 */
export async function saveOpenCodePermissionEffect(
  rule: OpenCodePermissionRule,
  effect: OpenCodePermissionEffect,
): Promise<OpenCodePermissionWriteResult> {
  const response = await fetch("/api/opencode/config/permissions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
