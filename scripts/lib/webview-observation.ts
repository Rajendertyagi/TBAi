/**
 * Shared pieces of the two WebView origin observations (G1 packaged, G2 dev).
 *
 * Both drivers answer the same shape of question — what origin did the running
 * WebView actually use, and could it read TBAi's own API from there — so both
 * need a bounded HTTP request, an origin comparison, a log tail for the failure
 * record, and an evidence file written on EVERY path. Keeping them here means
 * the two drivers cannot disagree about what "evidenced" means.
 *
 * The CDP runner and the WebDriver session live in the drivers themselves:
 * those protocols differ, and sharing a layer over them would hide which one
 * produced a value.
 */
import fs from "node:fs";
import path from "node:path";

export interface StageResult<TStage extends string> {
  readonly stage: TStage;
  readonly failures: readonly string[];
}

export interface StageSummary<TStage extends string> {
  readonly ok: boolean;
  /** The FIRST stage that failed, or null when every stage passed. */
  readonly stage: TStage | null;
  readonly failures: readonly string[];
}

/**
 * Folds per-stage findings into the one verdict the evidence records.
 *
 * A stage is only asked when every earlier one passed. Without that, an app
 * that never launched would also report "the WebView reported no origin" and
 * "the in-origin fetch returned no status" — consequences dressed up as
 * independent observations. Stopping at the first failure keeps every line in
 * `failures` a reason the run is not evidence, and `stage` is the single place
 * it stopped. Values recorded by stages that never ran stay visible in the
 * evidence itself, which is where a reader looks for them.
 */
export function sequentialStages<TStage extends string>(
  results: readonly StageResult<TStage>[],
): StageSummary<TStage> {
  const attempted: StageResult<TStage>[] = [];
  for (const result of results) {
    attempted.push(result);
    if (result.failures.length > 0) break;
  }
  const failures = attempted.flatMap((result) => result.failures);
  return {
    ok: failures.length === 0,
    stage: attempted.find((result) => result.failures.length > 0)?.stage ?? null,
    failures,
  };
}

/**
 * The origin of `url`, or null when it is absent or not a usable origin.
 *
 * A non-special scheme such as the packaged app's `app://localhost` reports the
 * opaque origin `"null"`; that is not an origin the CORS policy could match, so
 * it is reported as unparseable rather than as a value.
 */
export function originOf(url: string | null): string | null {
  if (url === null || url.length === 0) return null;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** The last `maxChars` characters of `text`; the whole text when it is shorter. */
export function tailText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

export interface EvidenceWrite {
  readonly written: boolean;
  readonly error: string | null;
}

/** Writes `value` as indented JSON. Never throws: the caller records the failure. */
export function writeEvidenceFile(filePath: string, value: unknown): EvidenceWrite {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return { written: true, error: null };
  } catch (error) {
    return {
      written: false,
      error: `could not write ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface HttpJsonResult {
  readonly status: number | null;
  readonly text: string | null;
  readonly error: string | null;
}

/**
 * A bounded request to a driver, CDP or API endpoint.
 *
 * Status and body are returned separately from transport failure so a 500 from
 * the app is evidence, while an unreachable port is a failed stage. The body is
 * capped: a driver error page is not worth unbounded memory.
 */
export async function httpJson(
  url: string,
  init: { readonly method?: string; readonly body?: unknown; readonly timeoutMs?: number } = {},
): Promise<HttpJsonResult> {
  const timeoutMs = init.timeoutMs ?? 30_000;
  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = (await response.text()).slice(0, 100_000);
    return { status: response.status, text, error: null };
  } catch (error) {
    return {
      status: null,
      text: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
