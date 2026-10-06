/**
 * The smallest isolated OpenCode v2 configuration that registers a controllable
 * model.
 *
 * ## Why every field here is explicit
 *
 * OpenCode v2 fills gaps with fallbacks. A model absent from the models.dev
 * catalogue is ASSUMED to support tools and to have a 200,000-token context
 * (see the v2 Models guide). Those defaults are convenient and useless here:
 * a 200K window puts automatic compaction hundreds of thousands of tokens away,
 * and "assumed tool support" is not evidence that tool support works.
 *
 * So the test model declares its own `capabilities.tools` and `limit`, and the
 * compaction window is sized to that limit rather than to a default.
 *
 * ## v2, not v1
 *
 * The provider package is `@opencode/ai/providers/openai-compatible`. The
 * `aisdk:@ai-sdk/openai-compatible` spelling is v1 and is silently ignored by a
 * v2 binary, which presents as "my config parsed but no models appeared" -
 * exactly the failure that cost eight earlier attempts. Every other naming in
 * this file is v2 as well: `providers` (plural), `package`, and `settings`.
 *
 * ## Compaction values
 *
 * `keep.tokens` must sit well below the declared limit. OpenCode retains that
 * much recent conversation beside the summary, so a value at or above the whole
 * window leaves no room to compact into. `buffer` is the free space kept below
 * the limit; with automatic compaction triggering around 75% of the window, a
 * 2,048-token buffer on an 8,192 window brings that trigger down to roughly
 * 6.1K tokens - a couple of real turns.
 *
 * These values are chosen to make the behaviour reachable, not to make an
 * assertion pass. If OpenCode rejects them, the validation error is the finding.
 */

/** The v2 provider id; also the prefix in `provider/model` references. */
export const STUB_PROVIDER_ID = "stub";

/** The model id as OpenCode knows it (the `models` map key). */
export const STUB_MODEL_ID = "tiny";

/** The model id sent to the provider (`modelID`). */
export const STUB_UPSTREAM_MODEL_ID = "tiny";

/** Declared context window. Small enough that automatic compaction is reachable. */
export const STUB_CONTEXT_LIMIT = 8_192;

/** Declared output ceiling. */
export const STUB_OUTPUT_LIMIT = 1_024;

/** Recent conversation retained beside the summary. Must be below the limit. */
export const STUB_COMPACTION_KEEP_TOKENS = 1_000;

/** Free space kept below the limit; larger starts compaction earlier. */
export const STUB_COMPACTION_BUFFER = 2_048;

/** The v2 provider package. The `aisdk:` spelling is v1 and is ignored by v2. */
export const OPENCODE_V2_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";

/**
 * Builds the isolated `opencode.json` for a stub-backed session.
 *
 * @param baseURL The stub's `/v1` base URL.
 * @param apiKey Placeholder, because the openai-compatible provider requires the
 *   field to be present and the stub never checks it. Deliberately NOT shaped
 *   like a credential: an earlier value was `sk-stub-not-a-real-key`, which is
 *   fake but matches every `sk-` secret-scanner rule and would have to be
 *   allow-listed in each one. OpenCode authenticates the SERVER with HTTP Basic
 *   (`OPENCODE_PASSWORD`, set by the harness); this field never leaves the
 *   loopback stub, so an obviously non-secret value carries the same behaviour
 *   with none of the scanner noise.
 * @returns A config document OpenCode v2 accepts.
 */
export function buildStubOpenCodeConfig(
  baseURL: string,
  apiKey = "tbai-stub-no-auth-required",
): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${STUB_PROVIDER_ID}/${STUB_MODEL_ID}`,
    providers: {
      [STUB_PROVIDER_ID]: {
        name: "Stub",
        package: OPENCODE_V2_COMPATIBLE_PACKAGE,
        settings: { baseURL, apiKey },
        models: {
          [STUB_MODEL_ID]: {
            modelID: STUB_UPSTREAM_MODEL_ID,
            name: "Stub Tiny",
            // Declared, not assumed: OpenCode's fallback would claim tools on an
            // 8192 window is never what a test wants to rely on.
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: STUB_CONTEXT_LIMIT, output: STUB_OUTPUT_LIMIT },
          },
        },
      },
    },
    compaction: {
      auto: true,
      keep: { tokens: STUB_COMPACTION_KEEP_TOKENS },
      buffer: STUB_COMPACTION_BUFFER,
    },
  };
}
