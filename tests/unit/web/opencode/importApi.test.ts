import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  fetchImportableSessions,
  importOpenCodeSession,
} from "@web/features/opencode/opencodeImportApi";

describe("OpenCode frontend import API client", () => {
  let capturedUrls: string[] = [];
  let capturedInits: (RequestInit | undefined)[] = [];
  let fetchResponse: { status: number; body: any };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    capturedUrls = [];
    capturedInits = [];
    fetchResponse = { status: 200, body: { sessions: [] } };
    originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      capturedUrls.push(url);
      capturedInits.push(init);
      return new Response(JSON.stringify(fetchResponse.body), {
        status: fetchResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("fetchImportableSessions", () => {
    it("requests /api/opencode/importable with query parameters including cursor and includeChildren", async () => {
      fetchResponse = {
        status: 200,
        body: {
          sessions: [
            {
              sessionId: "ses_1",
              directory: "/projects/repo",
              title: "External Session",
              lastActivityAt: 1234567,
              sourceRef: "abc",
              projectName: "RepoProject",
              gitBranch: "feature/pagination",
              isChild: false,
            },
          ],
          nextCursor: "cur_next_123",
          hasMore: true,
        },
      };

      const result = await fetchImportableSessions({
        query: "repo",
        limit: 10,
        scanLimit: 50,
        cursor: "cur_prev_99",
        includeChildren: true,
      });

      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0].sessionId).toBe("ses_1");
      expect(result.sessions[0].projectName).toBe("RepoProject");
      expect(result.nextCursor).toBe("cur_next_123");
      expect(result.hasMore).toBe(true);

      expect(capturedUrls.length).toBe(1);
      expect(capturedUrls[0]).toContain("/api/opencode/importable");
      expect(capturedUrls[0]).toContain("query=repo");
      expect(capturedUrls[0]).toContain("limit=10");
      expect(capturedUrls[0]).toContain("scanLimit=50");
      expect(capturedUrls[0]).toContain("cursor=cur_prev_99");
      expect(capturedUrls[0]).toContain("includeChildren=true");
    });

    it("throws clear error on non-200 responses", async () => {
      fetchResponse = {
        status: 503,
        body: { error: "OpenCode server unavailable" },
      };

      await expect(fetchImportableSessions()).rejects.toThrow("OpenCode server unavailable");
    });
  });

  describe("importOpenCodeSession", () => {
    it("sends only sessionId and sourceRef in the request body", async () => {
      fetchResponse = {
        status: 201,
        body: { conversationId: "conv_123" },
      };

      const result = (await importOpenCodeSession("ses_ext", "token_ref")) as any;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.conversationId).toBe("conv_123");
      }

      expect(capturedUrls[0]).toContain("/api/opencode/import");
      expect(capturedInits[0]?.method).toBe("POST");

      const body = JSON.parse(capturedInits[0]?.body as string);
      expect(body).toEqual({
        sessionId: "ses_ext",
        sourceRef: "token_ref",
      });
      // Guarantees no browser-chosen directory or owner was sent
      expect(body.directory).toBeUndefined();
      expect(body.serviceOwner).toBeUndefined();
    });

    it("translates 409 duplicate conflict with conversationId", async () => {
      fetchResponse = {
        status: 409,
        body: {
          error: "Session already imported",
          conversationId: "conv_existing_999",
        },
      };

      const result = (await importOpenCodeSession("ses_ext", "token_ref")) as any;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorKind).toBe("already_imported");
        if (result.errorKind === "already_imported") {
          expect(result.conversationId).toBe("conv_existing_999");
          expect(result.message).toBe("Session already imported");
        }
      }
    });

    it("translates 409 stale target/source error", async () => {
      fetchResponse = {
        status: 409,
        body: { error: "Active runtime target instance has changed since discovery" },
      };

      const result = (await importOpenCodeSession("ses_ext", "token_stale")) as any;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorKind).toBe("stale_source");
        expect(result.message).toContain("Active runtime target");
      }
    });

    it("translates 404 missing session error", async () => {
      fetchResponse = {
        status: 404,
        body: { error: "OpenCode session not found" },
      };

      const result = (await importOpenCodeSession("ses_missing", "token_ref")) as any;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorKind).toBe("session_not_found");
        expect(result.message).toContain("OpenCode session not found");
      }
    });
  });
});
