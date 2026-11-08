import { createOpenCodeClient, type OpenCodeClient } from "./client";
import {
  OpenCodeImportStaleSourceError,
  OpenCodeSessionAlreadyImportedError,
  OpenCodeImportSessionEligibilityError,
  OpenCodeImportedSessionMissingError,
  toOpenCodeError,
} from "./errors";
import {
  historyOwnerFromTarget,
  serializeHistoryOwner,
  LOCAL_HISTORY_OWNER,
} from "./historyBoundary";
import type { OpenCodeTransport } from "./http";
import { resolveOpenCodeRuntimeTarget } from "./runtimeTarget";
import { conversationService } from "../storage/conversations";

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

export interface ListImportableSessionsResult {
  readonly sessions: ImportableSessionSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ImportOpenCodeSessionInput {
  readonly sessionId: string;
  readonly sourceRef: string;
}

export interface SourceRefPayload {
  readonly mode: "managed" | "adopted";
  readonly targetId?: number;
  readonly origin: string;
}

export function encodeSourceRef(payload: SourceRefPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeSourceRef(ref: string): SourceRefPayload | null {
  try {
    const raw = Buffer.from(ref, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      (parsed.mode === "managed" || parsed.mode === "adopted") &&
      typeof parsed.origin === "string"
    ) {
      return parsed as SourceRefPayload;
    }
    return null;
  } catch {
    return null;
  }
}

interface ProjectMetadata {
  readonly name?: string;
  readonly canonical?: string;
}

/**
 * Bounded parallel fetch for the first user message prompt in each session.
 * Batched in groups of `concurrency` (default 5) to prevent overwhelming the server.
 */
async function fetchFirstPromptPreviews(
  client: OpenCodeClient,
  sessionIds: string[],
  concurrency = 5,
): Promise<Map<string, string>> {
  const previews = new Map<string, string>();
  if (typeof client.message?.list !== "function" || sessionIds.length === 0) {
    return previews;
  }

  for (let i = 0; i < sessionIds.length; i += concurrency) {
    const batch = sessionIds.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (sessionId) => {
        try {
          const res = await client.message.list({
            sessionID: sessionId,
            limit: 1,
            order: "asc",
            type: "user",
          });
          const firstMsg = res.data?.[0];
          if (firstMsg && "text" in firstMsg && typeof firstMsg.text === "string") {
            const trimmed = firstMsg.text.trim();
            if (trimmed) {
              previews.set(sessionId, trimmed.slice(0, 120));
            }
          }
        } catch {
          // Graceful fallback: preview is optional and must not fail session discovery
        }
      }),
    );
  }

  return previews;
}

/**
 * Authoritative directory-scoped VCS branch retrieval.
 * Deduplicates directories for sessions sharing a directory, bounds concurrency,
 * and handles missing Git repositories or errors gracefully without failing session discovery.
 */
async function fetchDirectoryVcsBranches(
  baseUrl: string,
  transport: OpenCodeTransport,
  directories: readonly string[],
  concurrency = 5,
): Promise<Map<string, string>> {
  const branches = new Map<string, string>();
  const uniqueDirs = Array.from(new Set(directories.filter((d) => Boolean(d?.trim()))));
  if (uniqueDirs.length === 0) return branches;

  for (let i = 0; i < uniqueDirs.length; i += concurrency) {
    const batch = uniqueDirs.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (dir) => {
        try {
          const dirClient = createOpenCodeClient(baseUrl, { directory: dir, transport });
          if (typeof dirClient.vcs?.get === "function") {
            const res = await dirClient.vcs.get();
            const current = (res as any)?.data?.branch?.current;
            if (typeof current === "string" && current.trim().length > 0) {
              branches.set(dir, current.trim());
            }
          }
        } catch {
          // Graceful fallback: non-git directories, permission issues, or missing VCS endpoints return null
        }
      }),
    );
  }

  return branches;
}

/**
 * Discovers existing OpenCode sessions available for import from the active runtime target.
 *
 * Excludes archived sessions and sessions that are already imported in TBAi for the active service owner.
 * Supports cursor-based pagination, single-call project resolution, directory-scoped VCS branch resolution,
 * and bounded message previews.
 */
export async function listImportableOpenCodeSessions(
  options: ListImportableSessionsOptions = {},
): Promise<ListImportableSessionsResult> {
  const target = await resolveOpenCodeRuntimeTarget();
  const historyOwner = historyOwnerFromTarget(target);
  const serviceOwner = historyOwner ? serializeHistoryOwner(historyOwner) : LOCAL_HISTORY_OWNER;

  const sourceRef = encodeSourceRef({
    mode: target.mode,
    targetId: target.targetId,
    origin: target.baseUrl,
  });

  const existingSessionIds = await conversationService.listImportedOpenCodeSessionIds(serviceOwner);
  const client = createOpenCodeClient(target.baseUrl, { transport: target.transport });

  // Resolve projects once in O(1) query for project display names
  const projectMap = new Map<string, ProjectMetadata>();
  try {
    if (typeof client.project?.list === "function") {
      const projects = await client.project.list();
      if (Array.isArray(projects)) {
        for (const p of projects) {
          if (p?.id) {
            projectMap.set(p.id, {
              name: p.name || undefined,
              canonical: p.canonical || undefined,
            });
          }
        }
      }
    }
  } catch {
    // Project metadata is best-effort
  }

  const pageSize = Math.min(Math.max(options.limit ?? 30, 1), 100);

  const page = await client.session.list({
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.query?.trim() ? { search: options.query.trim() } : {}),
    limit: pageSize,
  });

  const rawItems = page.data ?? [];
  const candidateItems = rawItems.filter((info) => {
    if (info.time?.archived) return false;
    if (existingSessionIds.has(info.id)) return false;
    if (options.includeChildren === false && info.parentID) return false;
    return true;
  });

  // Fetch previews for the candidate sessions on this page
  const candidateIds = candidateItems.map((item) => item.id);
  const previews = await fetchFirstPromptPreviews(client, candidateIds, 5);

  // Fetch authoritative VCS branch names for distinct directories on this page
  const candidateDirs = candidateItems.map(
    (item) => item.location?.directory ?? (item as any).directory ?? "",
  );
  const branchMap = await fetchDirectoryVcsBranches(
    target.baseUrl,
    target.transport,
    candidateDirs,
    5,
  );

  const sessions: ImportableSessionSummary[] = candidateItems.map((info) => {
    const dir = info.location?.directory ?? (info as any).directory ?? "";
    const proj = info.projectID ? projectMap.get(info.projectID) : undefined;
    const projByDir =
      !proj && dir ? Array.from(projectMap.values()).find((p) => p.canonical === dir) : undefined;

    const projectName = proj?.name ?? projByDir?.name ?? null;
    const gitBranch = dir ? (branchMap.get(dir) ?? null) : null;
    const isChild = Boolean(info.parentID);
    const preview = previews.get(info.id) ?? null;

    return {
      sessionId: info.id,
      directory: dir,
      title: info.title ?? null,
      firstPromptPreview: preview,
      lastPromptPreview: null,
      lastActivityAt: typeof info.time?.updated === "number" ? info.time.updated : Date.now(),
      sourceRef,
      parentID: info.parentID ?? null,
      isChild,
      projectName,
      gitBranch,
    };
  });

  const nextCursor = page.cursor?.next ?? null;
  const hasMore = Boolean(nextCursor);

  return {
    sessions,
    nextCursor,
    hasMore,
  };
}

/**
 * Imports an external OpenCode session into TBAi as a native attached conversation.
 *
 * Verifies freshness of the target using sourceRef, fetches authoritative session metadata,
 * ensures eligibility, and safely binds the session without copying message history.
 * In OpenCode 2.2.0, child sessions are independent rows in session_v2 with their own message history
 * and can safely be imported into TBAi.
 */
export async function importOpenCodeSession(
  input: ImportOpenCodeSessionInput,
): Promise<{ conversationId: string }> {
  const target = await resolveOpenCodeRuntimeTarget();

  const decoded = decodeSourceRef(input.sourceRef);
  if (!decoded) {
    throw new OpenCodeImportStaleSourceError("Invalid or unparseable source reference");
  }
  if (decoded.mode !== target.mode || decoded.origin !== target.baseUrl) {
    throw new OpenCodeImportStaleSourceError("Active runtime target has changed since discovery");
  }
  if (
    target.targetId !== undefined &&
    decoded.targetId !== undefined &&
    decoded.targetId !== target.targetId
  ) {
    throw new OpenCodeImportStaleSourceError(
      "Active runtime target instance has changed since discovery",
    );
  }

  const historyOwner = historyOwnerFromTarget(target);
  const serviceOwner = historyOwner ? serializeHistoryOwner(historyOwner) : LOCAL_HISTORY_OWNER;

  const existing = await conversationService.findByOpenCodeSession(serviceOwner, input.sessionId);
  if (existing) {
    throw new OpenCodeSessionAlreadyImportedError(
      existing.id,
      "This OpenCode session has already been imported",
    );
  }

  const client = createOpenCodeClient(target.baseUrl, { transport: target.transport });
  let sessionInfo: Awaited<ReturnType<OpenCodeClient["session"]["get"]>> | undefined;
  try {
    sessionInfo = await client.session.get({ sessionID: input.sessionId });
  } catch (err) {
    const normalized = toOpenCodeError(err);
    if (normalized.kind === "session_not_found" || normalized.statusCode === 404) {
      throw new OpenCodeImportedSessionMissingError("", input.sessionId);
    }
    throw normalized;
  }

  if (!sessionInfo) {
    throw new OpenCodeImportedSessionMissingError("", input.sessionId);
  }

  if (sessionInfo.time?.archived) {
    throw new OpenCodeImportSessionEligibilityError("Archived sessions cannot be imported");
  }

  const directory = sessionInfo.location?.directory ?? "";
  const title = sessionInfo.title?.trim() || "Imported Session";
  const agent = sessionInfo.agent ?? null;
  const model =
    typeof sessionInfo.model === "string" ? sessionInfo.model : (sessionInfo.model?.id ?? null);

  try {
    const conversation = await conversationService.create({
      title,
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
      opencodeSessionId: input.sessionId,
      opencodeServiceOwner: serviceOwner,
      opencodeDirectory: directory,
      opencodeImported: true,
      opencodeAgent: agent,
      opencodeModel: model,
    });
    return { conversationId: conversation.id };
  } catch (err) {
    const isUniqueViolation =
      err instanceof Error &&
      (err.message.includes("UNIQUE constraint failed") ||
        err.message.includes("idx_conversations_opencode_owner_session"));
    if (isUniqueViolation) {
      const winner = await conversationService.findByOpenCodeSession(serviceOwner, input.sessionId);
      if (winner) {
        throw new OpenCodeSessionAlreadyImportedError(winner.id);
      }
    }
    throw err;
  }
}
