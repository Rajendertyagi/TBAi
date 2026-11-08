import { buildOpenCodeBasicAuthHeader } from "./runtime";

/**
 * The request mechanism every credential-bearing OpenCode call goes through.
 *
 * This module is a leaf: it imports no connection state. It owns the origin
 * check, the header derivation, the redirect refusal and the error vocabulary.
 * The state-owning module (`connectionState.ts`) composes these with its own
 * initiation gate, so the dependency runs one way:
 * `connectionState → http → runtime`.
 *
 * Enforcing the dependency this way is not cosmetic. This repository treats an
 * import cycle as a load-bearing defect (`docs/decisions.md`, 2026-09-19), and a
 * transport that reached back into the state owner would close
 * `http ↔ connectionState`.
 */

/**
 * The fetch-compatible function every credential-bearing OpenCode request goes
 * through. It is `typeof globalThis.fetch`, including `preconnect`, so it can be
 * handed to the official client as `options.fetch` unchanged.
 */
export type OpenCodeTransport = typeof globalThis.fetch;

/** Thrown when a request would send the bound credential to a different origin. */
export class OpenCodeOriginMismatchError extends Error {
  readonly code = "OPENCODE_ORIGIN_MISMATCH";

  constructor(
    readonly expectedOrigin: string,
    readonly targetOrigin: string,
  ) {
    super(
      `OpenCode request targets ${targetOrigin}, but this context is bound to ${expectedOrigin}`,
    );
    this.name = "OpenCodeOriginMismatchError";
  }
}

/** Thrown when a binding pairs a credential with an origin it does not belong to. */
export class OpenCodeAuthScopeError extends Error {
  readonly code = "OPENCODE_AUTH_SCOPE";

  constructor(
    readonly origin: string,
    readonly credentialOrigin: string,
  ) {
    super(`OpenCode credential is scoped to ${credentialOrigin}, not ${origin}`);
    this.name = "OpenCodeAuthScopeError";
  }
}

/**
 * Thrown for every 3xx. Carries only the status: the `Location` header is never
 * read, so a redirect target cannot reach an error message, a log or a response.
 */
export class OpenCodeRedirectRefusedError extends Error {
  readonly code = "OPENCODE_REDIRECT_REFUSED";

  constructor(readonly status: number) {
    super(`OpenCode refused a redirect (HTTP ${status})`);
    this.name = "OpenCodeRedirectRefusedError";
  }
}

/**
 * A credential as the transport sees it: only the password is used, and it is
 * non-empty by construction. The transport deliberately does not need to know
 * whether the password belongs to the managed child or an adopted service.
 */
export type TransportCredential = Readonly<{ readonly password: string }>;

/** The already-validated data one gated transport is bound to. */
export interface GatedTransportBinding {
  /** Canonical origin; the composition point validates and canonicalizes it. */
  readonly origin: string;
  /** The frozen credential instance the caller owns; retained, never copied. */
  readonly credential: TransportCredential;
}

/** Thrown to refuse an initiation. Runs before any header is built or fetch called. */
export type OpenCodeInitiationGate = () => void;

const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX_EXCLUSIVE = 400;
const AUTHORIZATION_HEADER = "authorization";

/** Derives the request's origin from either input shape, lower-cased. */
function originOfRequest(input: Parameters<OpenCodeTransport>[0]): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(url).origin.toLowerCase();
}

/**
 * Builds the effective header set: the `Request`'s own headers, overlaid by
 * `init.headers`, with every `authorization` entry removed from either source
 * and replaced by the one the binding's credential produces (§1.9.4).
 */
function buildEffectiveHeaders(
  credential: TransportCredential,
  input: Parameters<OpenCodeTransport>[0],
  init: Parameters<OpenCodeTransport>[1],
): Headers {
  const headers = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  }
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase() === AUTHORIZATION_HEADER) headers.delete(key);
  }
  for (const [key, value] of Object.entries(buildOpenCodeBasicAuthHeader(credential.password))) {
    headers.set(key, value);
  }
  return headers;
}

/**
 * Wraps `fetch` with the origin check, the injected credential and the redirect
 * refusal. `gate` is supplied by the composition point: the request-context
 * transport and the discovery-probe transport have different initiation rules.
 *
 * `method` and `body` are never rewritten; fetch derives them from the `Request`
 * when `init` omits them. On a 3xx the body is cancelled and a typed error is
 * thrown; the `Location` header is not read.
 */
export function createGatedTransport(
  binding: GatedTransportBinding,
  gate: OpenCodeInitiationGate,
): OpenCodeTransport {
  const transport = async (
    input: Parameters<OpenCodeTransport>[0],
    init?: Parameters<OpenCodeTransport>[1],
  ): Promise<Response> => {
    const targetOrigin = originOfRequest(input);
    if (targetOrigin !== binding.origin) {
      throw new OpenCodeOriginMismatchError(binding.origin, targetOrigin);
    }
    gate();
    const headers = buildEffectiveHeaders(binding.credential, input, init);
    // Resolved per invocation so the real implementation is used and a test can
    // substitute one without reaching into module internals.
    const response = await globalThis.fetch(input, { ...init, headers, redirect: "manual" });
    if (response.status >= REDIRECT_STATUS_MIN && response.status < REDIRECT_STATUS_MAX_EXCLUSIVE) {
      // Cancelling the body is best effort: a cancel failure must not replace
      // the refusal this call is reporting.
      try {
        await response.body?.cancel();
      } catch {
        // The refusal below is the outcome; the body is discarded either way.
      }
      throw new OpenCodeRedirectRefusedError(response.status);
    }
    return response;
  };
  return Object.assign(transport, { preconnect: globalThis.fetch.preconnect });
}
