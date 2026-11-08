/**
 * Sanitized copies of diagnostics, for artifacts that outlive the run.
 *
 * The origin-observation drivers upload a driver log and the application log.
 * A log tail can carry an `Authorization` header, a provider key echoed in an
 * upstream error body, or a token in a query string — and an uploaded artifact
 * cannot be un-published. Redaction here is deliberately over-broad: these are
 * diagnostics, so losing a token-shaped value costs nothing, while publishing
 * one cannot be undone.
 *
 * Truncation keeps the TAIL, because the interesting lines are the last ones
 * before a failure. The dropped prefix is reported, never silently discarded.
 */
import fs from "node:fs";
import path from "node:path";

/** Cap on the uploaded text. A log is evidence only if it can be read. */
export const MAX_UPLOAD_CHARS = 512 * 1024;

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

const RULES: readonly RedactionRule[] = [
  // `Authorization: Bearer <token>` — keep the header name, drop the credential.
  {
    pattern: /\b(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s"',;]{6,}/gi,
    replace: (_match, header) => `${header}[REDACTED]`,
  },
  // A bearer token anywhere else (a curl command pasted into a log, for example).
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
    replace: () => "Bearer [REDACTED]",
  },
  // `apiKey=…`, `"token": "…"`, `password: …` and the like. The optional quote
  // after the key name is what lets `"token": "…"` match; `&` is excluded from
  // the bare value so a query string keeps its later parameters.
  {
    pattern:
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|credentials?)\b("?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}&]+)/gi,
    replace: (_match, key, separator) => `${key}${separator}[REDACTED]`,
  },
  // Provider key shapes that appear without a key name in front of them.
  {
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replace: () => "[REDACTED]",
  },
  // Credentials carried in a query string.
  {
    pattern: /([?&](?:token|api[_-]?key|access_token|key|password)=)[^&\s]+/gi,
    replace: (_match, prefix) => `${prefix}[REDACTED]`,
  },
];

export interface SanitizedLog {
  readonly text: string;
  /** How many values were replaced. Recorded so a silent zero is visible. */
  readonly redactions: number;
  /** Characters dropped from the head to fit the cap; 0 when nothing was cut. */
  readonly truncatedChars: number;
}

/**
 * Redacts credential-shaped values and keeps at most `maxChars` characters.
 *
 * Pure and deterministic: the same input always produces the same output, so a
 * unit test can pin every rule.
 */
export function sanitizeLogText(text: string, maxChars: number = MAX_UPLOAD_CHARS): SanitizedLog {
  let truncatedChars = 0;
  let kept = text;
  if (text.length > maxChars) {
    truncatedChars = text.length - maxChars;
    kept = text.slice(truncatedChars);
  }

  let redactions = 0;
  for (const rule of RULES) {
    kept = kept.replace(rule.pattern, (match: string, ...groups: string[]) => {
      redactions += 1;
      return rule.replace(match, ...groups);
    });
  }

  if (truncatedChars > 0) {
    kept = `[sanitized] ${truncatedChars} characters omitted from the head\n${kept}`;
  }
  return { text: kept, redactions, truncatedChars };
}

export interface SanitizedLogFile extends SanitizedLog {
  readonly written: boolean;
  /** Whether there was a log to sanitize. An absent log is normal, not a failure. */
  readonly sourceExisted: boolean;
  readonly error: string | null;
}

/**
 * Writes the sanitized copy of `source` to `destination`.
 *
 * A missing source is reported, not created: an absent log is a fact the
 * evidence should show, not an empty file that reads like a clean one. The
 * caller can separate "there was nothing to upload" (`sourceExisted: false`)
 * from "the upload copy could not be produced" (`sourceExisted && !written`).
 */
export function sanitizeLogFile(
  source: string,
  destination: string,
  maxChars: number = MAX_UPLOAD_CHARS,
): SanitizedLogFile {
  try {
    if (!fs.existsSync(source)) {
      return {
        text: "",
        redactions: 0,
        truncatedChars: 0,
        written: false,
        sourceExisted: false,
        error: `no log at ${source}`,
      };
    }
    const sanitized = sanitizeLogText(fs.readFileSync(source, "utf8"), maxChars);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, sanitized.text, "utf8");
    return { ...sanitized, written: true, sourceExisted: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: "",
      redactions: 0,
      truncatedChars: 0,
      written: false,
      sourceExisted: true,
      error: `could not sanitize ${source}: ${message}`,
    };
  }
}
