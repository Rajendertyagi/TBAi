import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";
import { decodeSourceRef, encodeSourceRef } from "@/services/opencode/import";

/**
 * OpenCode Import Chat preservation (separate from Legacy Import Open Tabs).
 * Behavioral coverage is limited by OpenCode runtime/storage fixtures in this
 * environment; these tests verify pure contracts and critical preservation guards.
 */
describe("OpenCode import service contracts", () => {
  it("round-trips sourceRef payloads used for freshness/target binding", () => {
    const managed = { mode: "managed" as const, origin: "http://127.0.0.1:4096" };
    expect(decodeSourceRef(encodeSourceRef(managed))).toEqual(managed);

    const adopted = { mode: "adopted" as const, targetId: 42, origin: "http://localhost:5000" };
    expect(decodeSourceRef(encodeSourceRef(adopted))).toEqual(adopted);
  });

  it("rejects invalid sourceRef payloads", () => {
    expect(decodeSourceRef("not-base64url-json")).toBeNull();
    expect(
      decodeSourceRef(Buffer.from(JSON.stringify({ mode: "nope", origin: "x" }), "utf8").toString("base64url")),
    ).toBeNull();
  });

  it("preserves import service ownership/metadata behavior in source (no message-history copy)", () => {
    const src = readFileSync(path.join(REPO_ROOT, "src/services/opencode/import.ts"), "utf8");
    expect(src).toContain("listImportedOpenCodeSessionIds");
    expect(src).toContain("findByOpenCodeSession");
    expect(src).toContain("opencodeImported: true");
    expect(src).toContain("opencodeSessionId: input.sessionId");
    expect(src).toContain("opencodeServiceOwner: serviceOwner");
    expect(src).toContain("opencodeDirectory: directory");
    expect(src).toContain("safely binds the session without copying message history");
    expect(src).toContain("OpenCodeSessionAlreadyImportedError");
    expect(src).toContain("OpenCodeImportStaleSourceError");
  });

  it("preserves OpenCode import routes and dialog wiring", () => {
    const routes = readFileSync(path.join(REPO_ROOT, "src/routes/opencode.ts"), "utf8");
    expect(routes).toContain('app.get("/importable"');
    expect(routes).toContain('app.post("/import"');
    expect(routes).toContain("sessionId and sourceRef are required");

    const dialog = readFileSync(
      path.join(REPO_ROOT, "web/src/features/opencode/OpenCodeImportDialog.tsx"),
      "utf8",
    );
    expect(dialog).toContain("fetchImportableSessions");
    expect(dialog).toContain("importOpenCodeSession");
    expect(dialog).toContain("Import from OpenCode");
  });
});
