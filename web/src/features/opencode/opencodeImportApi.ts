import { apiFetch } from "@/lib/platform";

export interface ImportableSessionSummary {
  readonly sessionId: string;
  readonly directory: string;
  readonly title: string | null;
  readonly firstPromptPreview: string | null;
  readonly lastPromptPreview: string | null;
  readonly lastActivityAt: number;
  readonly sourceRef: string;
  readonly parentID?: string | null;
  readonly isChild?: boolean;
  readonly projectName?: string | null;
  readonly gitBranch?: string | null;
}

export interface ListImportableSessionsOptions {
  readonly query?: string;
  readonly limit?: number;
  readonly scanLimit?: number;
  readonly cursor?: string;
  readonly includeChildren?: boolean;
}

export interface FetchImportableSessionsResult {
  readonly sessions: ImportableSessionSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ImportOpenCodeSessionSuccess {
  readonly ok: true;
  readonly conversationId: string;
}

export interface ImportOpenCodeSessionDuplicate {
  readonly ok: false;
  readonly errorKind: "already_imported";
  readonly message: string;
  readonly conversationId: string;
}

export interface ImportOpenCodeSessionStaleSource {
  readonly ok: false;
  readonly errorKind: "stale_source";
  readonly message: string;
}

export interface ImportOpenCodeSessionNotFound {
  readonly ok: false;
  readonly errorKind: "session_not_found";
  readonly message: string;
}

export interface ImportOpenCodeSessionOtherError {
  readonly ok: false;
  readonly errorKind: "error";
  readonly message: string;
}

export type ImportOpenCodeSessionResult =
  | ImportOpenCodeSessionSuccess
  | ImportOpenCodeSessionDuplicate
  | ImportOpenCodeSessionStaleSource
  | ImportOpenCodeSessionNotFound
  | ImportOpenCodeSessionOtherError;

/**
 * Fetches a paginated list of OpenCode sessions available for import into TBAi.
 */
export async function fetchImportableSessions(
  options: ListImportableSessionsOptions = {},
): Promise<FetchImportableSessionsResult> {
  const params = new URLSearchParams();
  if (options.query?.trim()) params.set("query", options.query.trim());
  if (typeof options.limit === "number") params.set("limit", String(options.limit));
  if (typeof options.scanLimit === "number") params.set("scanLimit", String(options.scanLimit));
  if (options.cursor?.trim()) params.set("cursor", options.cursor.trim());
  if (typeof options.includeChildren === "boolean") {
    params.set("includeChildren", String(options.includeChildren));
  }

  const qs = params.toString();
  const basePath = "/api/opencode/importable";
  const url = qs ? `${basePath}?${qs}` : basePath;
  const response = await apiFetch(url);
  if (!response.ok) {
    let msg = `Failed to fetch importable sessions (${response.status})`;
    try {
      const errPayload = await response.json();
      if (errPayload?.error) msg = errPayload.error;
    } catch {
      // ignore non-json errors
    }
    throw new Error(msg);
  }

  const data = (await response.json()) as {
    sessions?: ImportableSessionSummary[];
    nextCursor?: string | null;
    hasMore?: boolean;
  };
  return {
    sessions: data.sessions ?? [],
    nextCursor: data.nextCursor ?? null,
    hasMore: Boolean(data.hasMore),
  };
}

/**
 * Imports an existing external OpenCode session into TBAi as a native attached conversation.
 * Sends only the sessionId and sourceRef. Never trusts browser-supplied owner or directory.
 */
export async function importOpenCodeSession(
  sessionId: string,
  sourceRef: string,
): Promise<ImportOpenCodeSessionResult> {
  const response = await apiFetch("/api/opencode/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, sourceRef }),
  });

  let payload: any = {};
  try {
    payload = await response.json();
  } catch {
    // ignore non-json errors
  }

  if (response.status === 201) {
    return { ok: true, conversationId: payload.conversationId };
  }

  if (response.status === 409) {
    if (typeof payload.conversationId === "string" && payload.conversationId.length > 0) {
      return {
        ok: false,
        errorKind: "already_imported",
        message: payload.error || "This OpenCode session has already been imported.",
        conversationId: payload.conversationId,
      };
    }
    return {
      ok: false,
      errorKind: "stale_source",
      message:
        payload.error ||
        "The active OpenCode runtime connection has changed. Please refresh the session list.",
    };
  }

  if (response.status === 404) {
    return {
      ok: false,
      errorKind: "session_not_found",
      message: payload.error || "The selected session no longer exists on the OpenCode server.",
    };
  }

  return {
    ok: false,
    errorKind: "error",
    message: payload.error || `Import failed with HTTP ${response.status}`,
  };
}
