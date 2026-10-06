/**
 * Limits a provider has stated about itself, held in memory for this process.
 *
 * ## What this is for
 *
 * Some providers publish no context-window metadata, so limit resolution has nothing
 * to read and falls to a conservative stand-in that refuses part of a window the model
 * actually has. The provider does state the real figure — in the rejection it sends when
 * a request is too long. This module remembers that figure so the NEXT assembly can
 * plan against reality instead of the stand-in.
 *
 * ## Why in memory, and why that is the safe first step
 *
 * The durable home would be `provider_configs.models[].contextWindow`, and that was
 * rejected for now for a concrete reason: `PUT /api/providers/:id` replaces the WHOLE
 * `models` JSON whenever `models` is supplied, and model discovery returns a set the
 * client re-sends on save. A learned value stored there is therefore erased by an
 * unrelated provider edit — a silent regression with no error anywhere.
 *
 * In memory has the opposite failure profile: it is lost on restart, which costs one
 * conversation's worth of the stand-in and cannot corrupt anything.
 *
 * ## Scope — the part that matters
 *
 * A context window is a property of a MODEL **on an ENDPOINT under an ACCOUNT**, and
 * all three can differ for the same model id. `provider_configs.id` is the table's
 * primary key and its row carries the endpoint and the credential, so it already
 * identifies the endpoint and the account. Endpoint and protocol are still part of the
 * key, so editing either on that row retires the observation instead of silently
 * applying a figure learned from a different endpoint.
 *
 * Nothing here is keyed by anything a caller can pass loosely: every field is required
 * except the two endpoint fields, and the key cannot collide because each part is
 * length-prefixed rather than merely concatenated.
 */

/**
 * Ceiling on remembered observations.
 *
 * A conversation switches models rarely, so real usage is a handful of entries. The
 * bound exists so a pathological caller cannot grow this without limit; eviction is
 * oldest-first, which is the right victim because the least recently learned limit is
 * the least likely to be the one in use.
 */
export const MAX_OBSERVED_LIMIT_ENTRIES = 256;

/** One provider's stated limit for one model on one endpoint. */
export interface ObservedContextWindow {
  /** The stated window, in tokens. */
  readonly limitTokens: number;
  /** `Date.now()` when it was observed. Diagnostics only; never read as authority. */
  readonly observedAt: number;
}

export interface ObservedLimitKey {
  /** `provider_configs.id` — identifies the configuration, endpoint and account. */
  readonly providerId: string;
  /** Model id exactly as the conversation is bound to it. */
  readonly modelId: string;
  /** Endpoint of that configuration, when the resolver had one. */
  readonly endpoint?: string | undefined;
  /** Wire protocol of that configuration, when the resolver had one. */
  readonly protocol?: string | undefined;
}

const observations = new Map<string, ObservedContextWindow>();

/**
 * Length-prefixed key.
 *
 * Plain concatenation would let `("ab", "c")` and `("a", "bc")` collide, which would be
 * a cross-model leak — the one failure this module exists to make impossible. Each part
 * is prefixed with its length, so distinct inputs cannot produce one key.
 */
function keyOf(key: ObservedLimitKey): string {
  const part = (value: string): string => `${value.length}:${value}`;
  return [part(key.providerId), part(key.modelId), part(key.endpoint ?? ""), part(key.protocol ?? "")].join("|");
}

/**
 * Record a limit a provider stated for itself.
 *
 * Overwrites any previous observation for the same key, so a provider that changes its
 * window supersedes the old figure instead of both being consulted.
 *
 * Nothing is validated here beyond finiteness: the extractor already bounds the value,
 * and this module is the storage half, deliberately holding no parsing policy.
 */
export function observeContextWindow(
  key: ObservedLimitKey,
  limitTokens: number,
  now: number = Date.now(),
): void {
  if (!Number.isSafeInteger(limitTokens) || limitTokens <= 0) return;
  const id = keyOf(key);
  // Re-insert so Map's insertion order becomes least-recently-written first.
  observations.delete(id);
  observations.set(id, { limitTokens, observedAt: now });
  while (observations.size > MAX_OBSERVED_LIMIT_ENTRIES) {
    const oldest = observations.keys().next();
    if (oldest.done === true) break;
    observations.delete(oldest.value);
  }
}

/**
 * The limit previously observed for exactly this provider, model and endpoint.
 *
 * `undefined` for anything not previously observed, including the same model under a
 * different provider, a different endpoint, or a different protocol. There is no
 * "closest match" fallback: a near-miss here is a wrong window, which is worse than no
 * window.
 */
export function readObservedContextWindow(key: ObservedLimitKey): ObservedContextWindow | undefined {
  return observations.get(keyOf(key));
}

/** Forget everything. Exists for tests and for an explicit operator reset. */
export function clearObservedContextWindows(): void {
  observations.clear();
}

/** How many observations are held. Diagnostics and tests. */
export function observedContextWindowCount(): number {
  return observations.size;
}