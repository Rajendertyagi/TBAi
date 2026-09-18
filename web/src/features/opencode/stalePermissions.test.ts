import { describe, it, expect } from "bun:test";
import { fetchLivePermissionIds } from "./stalePermissions";
import { openCodePermissionPath } from "@/config/opencode";

/**
 * The stale-permission reconcile must read the **directory-scoped** list.
 *
 * OpenCode's pending-permission store is directory-scoped: an unscoped read
 * answers `[]` for a request that genuinely exists, so reconciling against it
 * would retire every live card. These tests pin the scope and the best-effort
 * failure behaviour (a failed read must mean "unknown", never "all gone").
 */

const DIRECTORY = "D:\\Temp\\ai-chat-app\\workspace\\chats\\conv-a";
const PERMISSION_ID = "per_aaaa";

function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as Request).url);
    calls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("stale-permission reconcile — directory scope", () => {
  it("reads the directory-scoped route and returns the live ids", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json([{ id: PERMISSION_ID }]));

    const live = await fetchLivePermissionIds(DIRECTORY, fetchImpl);

    expect([...(live ?? [])]).toEqual([PERMISSION_ID]);
    expect(calls).toEqual([openCodePermissionPath(DIRECTORY)]);
    expect(calls[0]).toContain(encodeURIComponent(DIRECTORY));
  });

  it("reports 'unknown' (null) without an authoritative directory, and never asks", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json([{ id: PERMISSION_ID }]));

    expect(await fetchLivePermissionIds(null, fetchImpl)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("reports 'unknown' (null) when the read fails or is unparseable", async () => {
    const failing = fakeFetch(() => json({ error: "boom" }, 500));
    expect(await fetchLivePermissionIds(DIRECTORY, failing.fetchImpl)).toBeNull();

    const html = fakeFetch(() => new Response("<html></html>", { status: 200 }));
    expect(await fetchLivePermissionIds(DIRECTORY, html.fetchImpl)).toBeNull();

    const throwing = fakeFetch(() => {
      throw new Error("network");
    });
    expect(await fetchLivePermissionIds(DIRECTORY, throwing.fetchImpl)).toBeNull();
  });

  it("returns an empty set only when the scoped server really holds nothing", async () => {
    const { fetchImpl } = fakeFetch(() => json([]));
    expect(await fetchLivePermissionIds(DIRECTORY, fetchImpl)).toEqual(new Set());
  });
});
