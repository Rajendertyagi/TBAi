/**
 * M12 — a failed capabilities fetch is an error, never an empty catalogue.
 *
 * The hook's `.catch` keeps the previous agent/model lists, so the only way a
 * 5xx could silently wipe the picker is for the body to parse as a successful
 * catalogue. The proxied error envelope (`{ error }`) is exactly that shape,
 * which is why the response check has to happen before the parse.
 */

import { describe, expect, it } from "bun:test";
import { readOpenCodeCapabilities } from "@web/features/opencode/useOpenCodeCapabilities.ts";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("readOpenCodeCapabilities", () => {
  it("carries the server's message for a JSON error envelope", async () => {
    await expect(
      readOpenCodeCapabilities(json(503, { error: "opencode not ready" })),
    ).rejects.toThrow("opencode not ready");
  });

  it("reports the status when the error body is not a JSON envelope", async () => {
    await expect(
      readOpenCodeCapabilities(new Response("<html>gateway</html>", { status: 502 })),
    ).rejects.toThrow("HTTP 502");
  });

  it("treats an authoritatively empty catalogue as success", async () => {
    const capabilities = await readOpenCodeCapabilities(json(200, { agents: [], models: [] }));
    expect(capabilities.agents).toEqual([]);
    expect(capabilities.models).toEqual([]);
  });
});
