import { describe, expect, it } from "bun:test";
import {
  authorizeOpenCodeProxyRequest,
  OpenCodeProxyRefusalError,
} from "../../../src/services/opencode/proxyAuthorization";
import type { OpenCodeProxyRoute } from "../../../src/services/opencode/proxyRoutes";
import { conversationService } from "../../../src/services/storage/conversations";

describe("authorizeOpenCodeProxyRequest", () => {
  const globalRoute: OpenCodeProxyRoute = {
    operation: "server.info",
    method: "GET",
    path: "/api/info",
    scope: "global",
  };

  const sessionRoute: OpenCodeProxyRoute = {
    operation: "session.get",
    method: "GET",
    path: "/api/session/:sessionID",
    scope: "session",
  };

  const eventStreamRoute: OpenCodeProxyRoute = {
    operation: "event.subscribe",
    method: "GET",
    path: "/api/event",
    scope: "location",
  };

  it("authorizes global routes without session or directory", async () => {
    const auth = await authorizeOpenCodeProxyRequest({
      route: globalRoute,
      parameters: {},
      sessionHeader: null,
      serviceOwner: "managed",
    });
    expect(auth.directory).toBeNull();
    expect(auth.sessionId).toBeNull();
  });

  it("refuses requests missing session identification", async () => {
    await expect(
      authorizeOpenCodeProxyRequest({
        route: sessionRoute,
        parameters: {},
        sessionHeader: null,
      }),
    ).rejects.toThrow(OpenCodeProxyRefusalError);
  });

  it("refuses requests where path parameter and session header disagree", async () => {
    await expect(
      authorizeOpenCodeProxyRequest({
        route: sessionRoute,
        parameters: { sessionID: "ses_path" },
        sessionHeader: "ses_header",
      }),
    ).rejects.toThrow(OpenCodeProxyRefusalError);
  });

  it("enforces service owner isolation (managed session not authorized on adopted owner)", async () => {
    await conversationService.create({
      title: "Managed Only Conv",
      providerId: null,
      workspaceMode: "simple",
      opencodeSessionId: "ses_owner_iso",
      opencodeServiceOwner: "managed",
      opencodeDirectory: "/var/managed/dir",
      opencodeImported: true,
      engine: "opencode",
    });

    // Authorizing against adopted owner must refuse with 403
    await expect(
      authorizeOpenCodeProxyRequest({
        route: sessionRoute,
        parameters: { sessionID: "ses_owner_iso" },
        sessionHeader: null,
        serviceOwner: "adopted:http://remote:4096",
      }),
    ).rejects.toThrow(OpenCodeProxyRefusalError);

    // Authorizing against managed owner succeeds
    const auth = await authorizeOpenCodeProxyRequest({
      route: sessionRoute,
      parameters: { sessionID: "ses_owner_iso" },
      sessionHeader: null,
      serviceOwner: "managed",
    });
    expect(auth.sessionId).toBe("ses_owner_iso");
    expect(auth.directory).toBe("/var/managed/dir");
  });

  it("authorizes location-scoped routes via x-tbai-session header", async () => {
    await conversationService.create({
      title: "Header Authorized Conv",
      providerId: null,
      workspaceMode: "simple",
      opencodeSessionId: "ses_header_test",
      opencodeServiceOwner: "managed",
      opencodeDirectory: "/workspace/location/path",
      opencodeImported: true,
      engine: "opencode",
    });

    const auth = await authorizeOpenCodeProxyRequest({
      route: eventStreamRoute,
      parameters: {},
      sessionHeader: "ses_header_test",
      serviceOwner: "managed",
    });
    expect(auth.sessionId).toBe("ses_header_test");
    expect(auth.directory).toBe("/workspace/location/path");
  });

  it("refuses authorization when imported session directory cannot be resolved", async () => {
    await conversationService.create({
      title: "Missing Dir Conv",
      providerId: null,
      workspaceMode: "simple",
      opencodeSessionId: "ses_missing_dir",
      opencodeServiceOwner: "managed",
      opencodeDirectory: null,
      opencodeImported: true,
      engine: "opencode",
    });

    await expect(
      authorizeOpenCodeProxyRequest({
        route: sessionRoute,
        parameters: { sessionID: "ses_missing_dir" },
        sessionHeader: null,
        serviceOwner: "managed",
      }),
    ).rejects.toThrow(OpenCodeProxyRefusalError);
  });
});
