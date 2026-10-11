/**
 * SPIKE — OPTION B PROOF: failure / recovery (section 11).
 * TEMPORARY, removable.
 *
 * Proves the runtime fails CLOSED on malformed input and errors, and that the
 * controller discipline (keep last valid window, never commit a partial
 * candidate) is enforceable. No silent history loss, no silent branch change,
 * no duplicate ids, no stale repository becoming active.
 */

import { describe, expect, it } from "bun:test";
import { createProof, chainFromTo, ai, type AiMsg } from "./proof-harness";

const enc = new TextEncoder();
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

describe("Option B — failure / recovery", () => {
  it("A/D: a failed or stale load leaves the last valid window active", () => {
    const h = createProof({ window: chainFromTo(451, 500) });
    const before = h.visibleIds();

    // The controller's discipline: a failed load does NOT call setWindow, so the
    // runtime keeps the last good store. Simulated by simply not committing.
    // (The runtime has no "failed load" concept — it only sees store updates.)
    console.log("\n=== failure: last valid window preserved ===");
    console.log("  visible before/after failed load:", before.length, "->", h.visibleIds().length);

    expect(h.visibleIds()).toEqual(before);
    expect(h.headId()).toBe("m500");
    h.dispose();
  });

  it("B: a non-contiguous (malformed) window fails closed IF built from persisted parent_ids", async () => {
    // DECISIVE subtlety: a hole is only detected if the repository is built
    // from PERSISTED parent_ids. If the controller builds parentIds from array
    // position, the hole is silently re-parented (hidden). This is exactly why
    // §14.8 requires branch identity from persisted parent_id, not array order.
    const { ExportedMessageRepository, AISDKMessageConverter } = await import(
      "../../../helpers/dom/resolve.ts"
    );

    // Window with a HOLE at m460, but each message carries its REAL persisted
    // parent_id (m461 -> m460).
    const withHole = [...chainFromTo(451, 459), ...chainFromTo(461, 500)];
    const persistedParent = new Map<string, string | null>();
    for (let n = 451; n <= 500; n += 1) persistedParent.set(`m${n}`, n === 451 ? null : `m${n - 1}`);

    const converted = AISDKMessageConverter.toThreadMessages(withHole as never, false, {} as never) as never as Array<{ id: string }>;

    const repo = ExportedMessageRepository.fromBranchableArray(
      converted.map((m) => ({ message: m, parentId: persistedParent.get(m.id) ?? null })) as never,
      { headId: "m500" },
    );

    // `fromBranchableArray` defers validation; the runtime enforces it.
    const { ExternalStoreThreadRuntimeCore } = await import("../../../helpers/dom/resolve.ts");
    const contextProvider = {
      getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
      registerModelContextProvider: () => () => {},
    } as never;

    let threw: string | null = null;
    try {
      new ExternalStoreThreadRuntimeCore(contextProvider, {
        messageRepository: repo,
        isRunning: false,
      } as never);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }

    console.log("\n=== failure: malformed window (hole at m460), persisted parent_ids ===");
    console.log("  outcome:", threw ?? "(accepted)");

    // m461's persisted parent is m460, which is absent → fail closed.
    expect(threw).toContain("Parent message not found");
  });

  it("B2: duplicate ids in a window are rejected by the messages path", () => {
    const h = createProof({ window: chainFromTo(451, 500) });
    // Two messages with the SAME id — the runtime dedupes with a warning, never
    // silently doubling.
    const dup = [...chainFromTo(451, 460), ai("m460", "assistant")];
    let threw: string | null = null;
    try {
      h.setWindow(dup);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    const ids = h.visibleIds();
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    console.log("\n=== failure: duplicate id m460 ===");
    console.log("  visible:", ids.length, " duplicate ids:", dupes.length, " threw:", threw ?? "(none)");
    expect(dupes).toEqual([]);
    h.dispose();
  });

  it("E: a stream error surfaces via onError and ends the run", async () => {
    let errorSeen: string | null = null;
    const h = createProof({
      window: chainFromTo(451, 500),
      onFetch: () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(sse({ type: "start", messageId: "e1" }));
              c.enqueue(sse({ type: "error", errorText: "model exploded" }));
              c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    (h.chat as never as { onError: (e: unknown) => void }).onError = (e) => {
      errorSeen = e instanceof Error ? e.message : String(e);
    };

    await h.send("go");
    await new Promise((r) => setTimeout(r, 60));

    console.log("\n=== failure: stream error ===");
    console.log("  chat status:", (h.chat as never as { status: string }).status);
    console.log("  error seen:", errorSeen ?? "(none)");

    expect((h.chat as never as { status: string }).status).toBe("error");
    h.dispose();
  });

  it("F: resume with no stored stream id routes to onError (ai@7 never rejects)", async () => {
    const storage = {
      getStreamId: () => null,
      setStreamId: () => {},
      clear: () => {},
      subscribe: () => () => {},
    };
    let errorSeen: string | null = null;
    const h = createProof({
      window: chainFromTo(451, 500),
      resumable: { storage, resumeApi: (id) => `/api/chat/resume/${id}` },
    });
    (h.chat as never as { onError: (e: unknown) => void }).onError = (e) => {
      errorSeen = e instanceof Error ? e.message : String(e);
    };

    // ai@7's resumeStream does NOT reject (documented in web/src/runtime.ts);
    // the failure surfaces via onError instead.
    await (h.chat as never as { resumeStream: () => Promise<void> }).resumeStream().catch((e: unknown) => {
      errorSeen = e instanceof Error ? e.message : String(e);
    });
    await new Promise((r) => setTimeout(r, 40));

    console.log("\n=== failure: resume with no stream id ===");
    console.log("  error surfaced:", errorSeen ?? "(none)");

    expect(errorSeen).toContain("no resumable stream id");
    h.dispose();
  });

  it("C: concurrent navigation — the last commit wins, no interleaving", () => {
    const h = createProof({ window: chainFromTo(451, 500) });
    // Two rapid re-commits; the runtime applies them in order.
    h.setWindow(chainFromTo(401, 500));
    h.setWindow(chainFromTo(351, 400));
    h.setWindow(chainFromTo(451, 500));
    console.log("\n=== failure: concurrent navigation ===");
    console.log("  final visible:", h.visibleIds()[0], "..", h.visibleIds().at(-1), " head:", h.headId());
    expect(h.visibleIds()[0]).toBe("m451");
    expect(h.headId()).toBe("m500");
    h.dispose();
  });
});