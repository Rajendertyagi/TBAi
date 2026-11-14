import { parse, type ParseError } from "jsonc-parser";

/** Result of parsing OpenCode configuration source text for read-only inspection. */
export type ParsedOpenCodeConfigText =
  | { readonly kind: "empty"; readonly doc: Readonly<Record<string, unknown>> }
  | { readonly kind: "valid"; readonly doc: Readonly<Record<string, unknown>> }
  | { readonly kind: "invalid" };

/**
 * Parses configuration text with the shared JSON/JSONC reader used for
 * inspection and redaction. Comments and trailing commas are accepted; parser
 * errors, non-object roots, arrays, scalars, and partially recovered values are
 * rejected so callers never observe an invalid document as valid.
 *
 * @param raw - Original configuration source text.
 * @returns Parsed document state without mutating or exposing the source text.
 */
export function parseOpenCodeConfigText(raw: string): ParsedOpenCodeConfigText {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "empty", doc: {} };
  }
  const errors: ParseError[] = [];
  const parsed = parse(trimmed, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  }) as unknown;
  if (errors.length > 0) {
    return { kind: "invalid" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid" };
  }
  return { kind: "valid", doc: parsed as Record<string, unknown> };
}
