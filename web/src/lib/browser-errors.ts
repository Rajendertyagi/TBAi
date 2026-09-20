/**
 * Browser-generated error classification.
 *
 * The browser reports a small number of diagnostics that are NOT application
 * exceptions. The one this app actually sees is the ResizeObserver delivery
 * notice:
 *
 *   "ResizeObserver loop completed with undelivered notifications."
 *
 * It means a resize triggered from inside an observer callback was delivered in
 * the same frame. It is a *timing* notice about the observer delivery cycle, not
 * a thrown exception and not evidence of broken layout.
 *
 * Why a narrow classifier instead of ignoring it:
 * - The global hook must keep capturing genuine `window.error` events; a real
 *   uncaught exception is the thing we can least afford to lose.
 * - A blanket "ignore ResizeObserver" rule would also swallow a REAL feedback
 *   loop introduced later. So the match is EXACT: the normalized message must
 *   equal a known browser diagnostic string. Anything longer, prefixed,
 *   suffixed, or differently worded stays a real error.
 * - Metadata (message, source, line, column, route) is still recorded, so an
 *   unexpected layout problem remains diagnosable.
 *
 * Pure and dependency-free so the boundary is directly unit-testable.
 */

export type BrowserErrorKind = "layout_diagnostic" | "uncaught";

/**
 * Known browser diagnostics, matched EXACTLY after trimming a trailing period.
 * Adding an entry here is a deliberate decision that the message is a browser
 * notice rather than an application failure.
 */
const LAYOUT_DIAGNOSTIC_MESSAGES: readonly string[] = [
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
];

/** Normalize for comparison only: trim, and drop one trailing period. */
function normalize(message: string): string {
  const trimmed = message.trim();
  return trimmed.endsWith(".") ? trimmed.slice(0, -1).trim() : trimmed;
}

/**
 * True only for an exact known browser layout diagnostic. Deliberately not a
 * substring test: "Uncaught Error: ResizeObserver loop completed with
 * undelivered notifications" or any longer app-authored message must remain a
 * real error.
 */
export function isBrowserLayoutDiagnostic(message: string): boolean {
  const normalized = normalize(message);
  return LAYOUT_DIAGNOSTIC_MESSAGES.includes(normalized);
}

/** Classify a browser error/rejection reason. */
export function classifyBrowserError(input: {
  message: string;
  errorName?: string;
}): BrowserErrorKind {
  return isBrowserLayoutDiagnostic(input.message) ? "layout_diagnostic" : "uncaught";
}

/**
 * Bound a stack for logging. The client transport already truncates strings to
 * 500 chars; doing it here makes the intent explicit rather than incidental.
 */
export function boundedStack(err: unknown, max = 500): string | undefined {
  if (!(err instanceof Error) || typeof err.stack !== "string") return undefined;
  const stack = err.stack;
  return stack.length > max ? stack.slice(0, max) : stack;
}
