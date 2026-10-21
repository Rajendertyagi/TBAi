/**
 * Credential redaction for the OpenCode configuration projection.
 *
 * ## WHY
 *
 * `GET /api/opencode/config` returned the user's OpenCode configuration
 * **verbatim**, including every provider credential, MCP header, OAuth client
 * secret and plugin environment variable the file carried. Any origin that
 * could reach the API could read them.
 *
 * This module produces the **projection** the API is allowed to return. It
 * never touches what is written back to disk: the write path reads the real
 * file, so the preservation guarantee (every unrelated key survives a rule
 * edit, byte for byte) is unaffected.
 *
 * ## WHERE THE LIST COMES FROM
 *
 * The locations below are derived from the **published schema**
 * (`https://opencode.ai/config.json`), not from a guess:
 *
 * - `providers.<id>.settings` is declared with an `allOf` that permits
 *   arbitrary extra keys, so an `apiKey` there is *allowed but undeclared* —
 *   which is why the whole object is masked rather than a named key.
 * - `providers.<id>.headers` and `.body` carry request headers and body
 *   overrides, which routinely carry `Authorization`.
 * - `providers.<id>.models.<model>` has the same `settings` / `headers` / `body`
 *   shape, and so does each of its `variants`.
 * - `agents.<name>.request.headers` / `.body` are the V2 agent request
 *   overrides; the V1 `agent.<name>.options` / `mode.<name>.options` objects
 *   are the provider-options objects.
 * - `mcp` carries `environment` (local servers), `headers` and `oauth` (remote
 *   servers). The V2 shape nests servers under `mcp.servers`; the deprecated
 *   V1 shape puts them directly under `mcp`. The OAuth secret is spelled
 *   `client_secret` in the V2 encoded form and `clientSecret` in the V1 form,
 *   so both are masked.
 * - `plugins[].env` / `.options`, `lsp.<name>.env` and
 *   `formatter.<name>.environment` carry process environment values.
 *
 * On top of that, a **key-name** rule masks a value whose key names a
 * credential wherever it appears. That is defence in depth for the same
 * reason `providers.*.settings` is masked whole: the schema permits
 * undeclared keys, so a secret can sit somewhere the schema does not model.
 *
 * ## SUBSTITUTION-AWARE
 *
 * A secret is not always a literal. OpenCode accepts `{"env": "VAR"}` and
 * `{"file": "path"}` references, and both are masked: the first names a
 * secret-bearing variable, the second discloses a path to a secret file.
 * The referenced value is **never** substituted into the response — that
 * would be worse than the original.
 *
 * ## WHAT SURVIVES
 *
 * Structure, key names, and every non-credential value. That is the
 * diagnostic value the native-JSON view exists for.
 */

/** The marker that replaces every redacted value. */
export const REDACTED_CONFIG_VALUE = "[redacted]";

/**
 * How much of a matched location is secret.
 *
 * `leaves` means every value in the matched subtree is secret; `value` means
 * the matched node itself is the secret. Both are satisfied by masking the
 * node's leaves, so they differ only in intent, not in behaviour.
 */
type RedactionScope = "leaves" | "value";

/** One secret-bearing location, as a path of document keys. */
interface SecretLocation {
  /** The path. A segment starting with `:` matches any single key. */
  readonly path: readonly string[];
  readonly scope: RedactionScope;
}

/**
 * Every secret-bearing location, derived from the published schema.
 *
 * Order does not matter: the patterns have distinct lengths and shapes, and
 * a matched location is always secret.
 */
const SECRET_LOCATIONS: readonly SecretLocation[] = [
  // V2 providers.
  { path: ["providers", ":id", "settings"], scope: "leaves" },
  { path: ["providers", ":id", "headers"], scope: "leaves" },
  { path: ["providers", ":id", "body"], scope: "leaves" },
  { path: ["providers", ":id", "models", ":model", "settings"], scope: "leaves" },
  { path: ["providers", ":id", "models", ":model", "headers"], scope: "leaves" },
  { path: ["providers", ":id", "models", ":model", "body"], scope: "leaves" },
  {
    path: ["providers", ":id", "models", ":model", "variants", ":index", "settings"],
    scope: "leaves",
  },
  {
    path: ["providers", ":id", "models", ":model", "variants", ":index", "headers"],
    scope: "leaves",
  },
  { path: ["providers", ":id", "models", ":model", "variants", ":index", "body"], scope: "leaves" },
  // V2 agents: the request overrides carry headers and body values.
  { path: ["agents", ":name", "request", "headers"], scope: "leaves" },
  { path: ["agents", ":name", "request", "body"], scope: "leaves" },
  // V1 agents: the provider-options object.
  { path: ["agent", ":name", "options"], scope: "leaves" },
  { path: ["mode", ":name", "options"], scope: "leaves" },
  // V2 MCP servers.
  { path: ["mcp", "servers", ":name", "environment"], scope: "leaves" },
  { path: ["mcp", "servers", ":name", "headers"], scope: "leaves" },
  { path: ["mcp", "servers", ":name", "oauth", "clientSecret"], scope: "value" },
  { path: ["mcp", "servers", ":name", "oauth", "client_secret"], scope: "value" },
  // Deprecated V1 MCP map.
  { path: ["mcp", ":name", "environment"], scope: "leaves" },
  { path: ["mcp", ":name", "headers"], scope: "leaves" },
  { path: ["mcp", ":name", "oauth", "clientSecret"], scope: "value" },
  { path: ["mcp", ":name", "oauth", "client_secret"], scope: "value" },
  // Plugins, LSP servers and formatters carry process environment values.
  { path: ["plugins", ":index", "env"], scope: "leaves" },
  { path: ["plugins", ":index", "options"], scope: "leaves" },
  { path: ["lsp", ":name", "env"], scope: "leaves" },
  { path: ["formatter", ":name", "environment"], scope: "leaves" },
  // The V1 legacy provider block names its key explicitly.
  { path: ["provider", ":id", "options", "apiKey"], scope: "value" },
  { path: ["provider", ":id", "models", ":model", "options"], scope: "leaves" },
  { path: ["provider", ":id", "models", ":model", "headers"], scope: "leaves" },
];

/**
 * Key names that name a credential wherever they appear.
 *
 * Defence in depth for the undeclared-key case the schema permits. Matching is
 * case-insensitive and on the whole key, so `apiKey` and `api_key` are both
 * caught while `maxTokens` is not.
 */
const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  "apikey",
  "api_key",
  "secret",
  "secrets",
  "clientsecret",
  "client_secret",
  "password",
  "passwd",
  "authorization",
  "privatekey",
  "private_key",
  "accesskey",
  "access_key",
  "accesstoken",
  "access_token",
  "authtoken",
  "auth_token",
  "bearertoken",
  "bearer_token",
  "refreshtoken",
  "refresh_token",
  "sessiontoken",
  "session_token",
  "credential",
  "credentials",
]);

/** Whether a path segment pattern matches a document key. */
function segmentMatches(pattern: string, key: string): boolean {
  return pattern.startsWith(":") || pattern === key;
}

/** Whether a secret location covers exactly this path. */
function locationCovers(location: SecretLocation, path: readonly string[]): boolean {
  if (location.path.length !== path.length) return false;
  return location.path.every((segment, index) => segmentMatches(segment, path[index] ?? ""));
}

/** The scope of the secret location covering `path`, if any. */
function scopeAt(path: readonly string[]): RedactionScope | null {
  for (const location of SECRET_LOCATIONS) {
    if (locationCovers(location, path)) return location.scope;
  }
  return null;
}

/** Whether a key name names a credential on its own. */
function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_NAMES.has(key.toLowerCase());
}

/**
 * Whether a value is an OpenCode **substitution reference** — `{"env": "VAR"}`
 * or `{"file": "path"}`.
 *
 * The reference itself is the secret-bearing thing: it names the variable
 * that holds a credential, or the file that holds one. Masking only its inner
 * value would leave the name in the response, so the whole reference is
 * replaced.
 */
function isSubstitutionReference(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    ([key, inner]) => (key === "env" || key === "file") && typeof inner === "string",
  );
}

/**
 * Redacts one value.
 *
 * @param value - The value at this position.
 * @param path - The document path of `value`, used to locate secret locations.
 * @param inherited - The scope inherited from an ancestor that is secret.
 * @returns The redacted value. Structure and key names are preserved.
 */
function redactValue(
  value: unknown,
  path: readonly string[],
  inherited: RedactionScope | null,
): unknown {
  // A substitution reference inside a secret location is masked whole: the
  // reference names the credential, so masking its inner value would still
  // disclose it.
  if (inherited !== null && isSubstitutionReference(value)) {
    return REDACTED_CONFIG_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, [...path, String(index)], inherited));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      const childScope = scopeAt(childPath) ?? inherited;
      // `defineProperty` rather than assignment: a document key named
      // `__proto__` must become an own property, not a prototype change.
      Object.defineProperty(out, key, {
        value: redactValue(child, childPath, childScope),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  if (inherited !== null) return REDACTED_CONFIG_VALUE;
  const key = path[path.length - 1] ?? "";
  if (isSecretKeyName(key)) return REDACTED_CONFIG_VALUE;
  return value;
}

/**
 * Produces the redacted projection of an OpenCode configuration document.
 *
 * @param doc - The parsed document.
 * @returns A copy with every credential-bearing value masked. The input is
 *   not modified.
 */
export function redactOpenCodeConfigDocument(
  doc: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return redactValue(doc, [], null) as Record<string, unknown>;
}

/**
 * Produces the redacted projection of the configuration file's **text**.
 *
 * The text is parsed, redacted and re-serialized, so the result is a valid
 * JSON document with the same shape and the same key names — with the
 * credentials masked.
 *
 * A file whose text is not a JSON object **cannot** be redacted: there is no
 * structure to walk, and a textual scan would be a guess that could leak the
 * very value it was meant to hide. Such text is withheld, which the caller
 * signals with the document's own `malformed` flag.
 *
 * @param raw - The file's text.
 * @returns The redacted text, or an empty string when the text cannot be
 *   parsed into an object (including an empty file, which stays empty).
 */
export function redactOpenCodeConfigText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  return `${JSON.stringify(redactOpenCodeConfigDocument(parsed as Record<string, unknown>), null, 2)}\n`;
}
