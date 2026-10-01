/**
 * Phase 5 — deterministic memory safety screening.
 *
 * ## What this is, and what it is not
 *
 * A **derived, recomputable, deterministic** screen that decides whether a memory
 * is offered to the model. It is a floor, not a wall: regexes cannot catch a
 * rephrased or encoded attack, and nothing here should ever be described as a
 * security guarantee. It exists so that plainly instruction-shaped or
 * credential-bearing text does not ride along with every future request.
 *
 * Explicitly **not** implemented, by decision: semantic contradiction detection,
 * an LLM classifier, PII/privacy filtering, relevance filtering, and
 * `identity_reassignment`.
 *
 * ## Why a screen is justified at all
 *
 * Phase 5 memory is user-authored today, so the remote-injection threat is not
 * currently live. The screen is here because the *provider contract admits
 * candidates TBAi does not author* — today the local store, later an external
 * provider. The screen therefore never trusts a candidate's origin and evaluates
 * every candidate the same way.
 *
 * ## Why the verdict is derived and never persisted
 *
 * A stored verdict can disagree with the content it describes. Deriving it here
 * makes that state unrepresentable, makes an edit take effect immediately, and
 * costs one pass over at most {@link MEMORY_MAX_CHARS} characters.
 */

import { SECRET_PATTERNS } from "../../lib/redact";

/** The four approved classes. The reason token is what surfaces in diagnostics. */
export type MemorySafetyReason =
  | "instruction_displacement"
  | "turn_structure"
  | "credential_request"
  | "secret_material";

export interface MemorySafetyVerdict {
  /** True when the content must not be offered to the model. */
  readonly unsafe: boolean;
  /** Which class fired. Absent when safe. */
  readonly reason?: MemorySafetyReason;
}

/**
 * `instruction_displacement` — text trying to displace instructions already in play.
 *
 * Narrow on purpose: the object noun must be an instruction-like word, so an
 * ordinary memory such as "ignore previous formatting advice" does not match.
 */
const INSTRUCTION_DISPLACEMENT: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+)?(?:previous|prior|earlier|above|preceding|foregoing)\s+(?:instructions?|prompts?|rules?|directives?|context)\b/i,
  /\bforget\s+(?:everything|all)\s+(?:you|that|above|before)\b/i,
  /\boverrid(?:e|ing)\s+(?:your\s+|the\s+)?(?:system\s+)?(?:prompt|instructions?|rules?)\b/i,
];

/**
 * `turn_structure` — text forging who is speaking.
 *
 * The highest-value class here. Memory is injected into a structured message
 * stream, so a payload shaped like a role header or a chat-template control token
 * attacks message integrity directly rather than merely persuading.
 */
const TURN_STRUCTURE: readonly RegExp[] = [
  // A role header at the start of any line, so a wrapped payload still matches.
  /^\s*(?:system|assistant|developer)\s*:/im,
  /<\|(?:im_start|im_end|system|endoftext|im_start)\|>/i,
  /\[\/?(?:INST|SYS)\]/,
];

/**
 * `credential_request` — text asking the model for secrets.
 *
 * Backs AGENTS.md's rule that credentials stay backend-only and encrypted at
 * rest. A memory that asks the model to print a key would, once injected, apply
 * steady pressure toward exactly the failure that rule exists to prevent.
 */
const CREDENTIAL_REQUEST: readonly RegExp[] = [
  /\b(?:print|reveal|repeat|output|show|echo|dump)\s+(?:me\s+)?(?:us\s+)?(?:your|the)\s+(?:system\s+prompt|system\s+message|initial\s+prompt|instructions|api[\s_-]?keys?|credentials?|secrets?|access\s+tokens?)\b/i,
  /\b(?:send|post|upload|exfiltrate|forward|leak|share)\s+(?:me\s+)?(?:the\s+|your\s+|all\s+)?(?:api[\s_-]?keys?|access\s+tokens?|credentials?|secrets?|env(?:ironment)?\s+(?:vars?|variables)?)\b/i,
];

/**
 * `secret_material` — credential shapes, sourced from `redact.ts`.
 *
 * Reusing that list is the point: `SECRET_PATTERNS` is the project's existing
 * definition of "this looks like a credential", and declaring a third list here
 * would guarantee the drift the two existing copies already show.
 *
 * ## Why these are cloned
 *
 * The shared patterns carry the `g` flag, which makes them **stateful**:
 * `RegExp.prototype.test` advances `lastIndex` and leaves it set, so testing
 * these objects directly would corrupt `redact()`'s use of the same instances.
 * Each is therefore rebuilt without `g` (and without `y`) so matching here cannot
 * touch shared state. The pattern *source* is still the single shared list.
 */
const SECRET_MATERIAL: readonly RegExp[] = SECRET_PATTERNS.map(
  (pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")),
);

function firstMatch(patterns: readonly RegExp[], content: string): boolean {
  // `String.prototype.search`, not `RegExp.prototype.test`: search saves and
  // restores `lastIndex` around the match, so even a future stateful pattern
  // cannot leak match state out of this module or into `redact()`.
  return patterns.some((pattern) => content.search(pattern) !== -1);
}

/**
 * Screen one memory's content.
 *
 * Pure and total: the same content always yields the same verdict, and an empty
 * or non-string input is safe rather than an exception. Classes are evaluated in
 * a fixed order so a content matching two classes always reports the same one.
 */
export function evaluateMemorySafety(content: string): MemorySafetyVerdict {
  if (typeof content !== "string" || content.length === 0) return { unsafe: false };

  if (firstMatch(INSTRUCTION_DISPLACEMENT, content)) {
    return { unsafe: true, reason: "instruction_displacement" };
  }
  if (firstMatch(TURN_STRUCTURE, content)) {
    return { unsafe: true, reason: "turn_structure" };
  }
  if (firstMatch(CREDENTIAL_REQUEST, content)) {
    return { unsafe: true, reason: "credential_request" };
  }
  if (firstMatch(SECRET_MATERIAL, content)) {
    return { unsafe: true, reason: "secret_material" };
  }
  return { unsafe: false };
}