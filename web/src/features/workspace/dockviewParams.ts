/**
 * Serializable panel identity at the TBAi ↔ Dockview boundary.
 *
 * Dockview types panel `Parameters` as `{ [key: string]: any }`
 * (`panel/types.d.ts:6-8`), so serializability is NOT type-enforced. A panel's
 * params are written verbatim into `toJSON()` and replayed by `fromJSON()`; a
 * function, symbol, `undefined`, `Date`, `NaN` or cycle would corrupt that
 * round-trip. This module is the single boundary that turns the untyped bag
 * into a closed, validated, JSON-safe value.
 *
 * Params carry IDENTITY ONLY — never message text, drafts, credentials, paths
 * or runtime instances.
 */
import { parseTabKey } from "../chat/state/chatTabs";

/** The only two fields a TBAi Dockview panel may carry. */
export type PanelParams = {
  tabKey: string;
  contentType: "direct" | "opencode";
};

/** Registered Dockview component ids (stable across save/restore). */
export const DIRECT_COMPONENT = "tbai-direct";
export const OPENCODE_COMPONENT = "tbai-opencode";

const PARAM_KEYS = ["contentType", "tabKey"] as const;

/** Map a canonical tab key to its content type, or null if it is not canonical. */
export function contentTypeForTabKey(tabKey: string): PanelParams["contentType"] | null {
  const parsed = parseTabKey(tabKey);
  if (!parsed || parsed.ref.length === 0) return null;
  return parsed.kind === "agent" ? "opencode" : "direct";
}

/** Map a content type to its stable Dockview component id. */
export function componentForContentType(contentType: PanelParams["contentType"]): string {
  return contentType === "opencode" ? OPENCODE_COMPONENT : DIRECT_COMPONENT;
}

/** Build validated params for a canonical tab key, or null if the key is invalid. */
export function createPanelParams(tabKey: string): PanelParams | null {
  const contentType = contentTypeForTabKey(tabKey);
  if (!contentType) return null;
  return { tabKey, contentType };
}

/**
 * True only when `value` survives a JSON round-trip unchanged. Rejects
 * functions, symbols, `undefined`, `Date`, `NaN`/`Infinity`, cycles and
 * non-plain objects — exactly the values that break layout persistence.
 */
export function isJsonSerializable(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return false;
    return deepEqual(value, JSON.parse(json) as unknown);
  } catch {
    return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Validate an untyped Dockview params bag into the closed TBAi contract.
 * Returns null for any missing/extra field, wrong type, non-canonical tab key,
 * mismatched content type, or non-serializable value.
 */
export function parsePanelParams(raw: unknown): PanelParams | null {
  if (!isPlainObject(raw)) return null;
  const keys = Object.keys(raw).sort();
  if (keys.length !== PARAM_KEYS.length || keys.some((k, i) => k !== PARAM_KEYS[i])) return null;
  if (!isJsonSerializable(raw)) return null;

  const tabKey = raw.tabKey;
  const contentType = raw.contentType;
  if (typeof tabKey !== "string" || typeof contentType !== "string") return null;
  if (contentType !== "direct" && contentType !== "opencode") return null;
  if (contentTypeForTabKey(tabKey) !== contentType) return null;

  return { tabKey, contentType };
}
