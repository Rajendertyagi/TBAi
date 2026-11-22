/**
 * Operation-scoped correlation: id stability, nesting, and the decision that
 * decides whether a request carries the operation id.
 *
 * The header decision is tested through the pure `operationInitFor` /
 * `isCorrelatableRequest` helpers rather than by mutating the global `fetch`:
 * test files share one process, so replacing `fetch` globally makes this file
 * race any other file that stubs it.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  startOperation,
  currentOperationId,
  currentOperationName,
  operationHeaders,
  operationInitFor,
  isCorrelatableRequest,
  resolveRequestUrl,
  resetOperationsForTests,
  newOperationId,
  OPERATION_ID_HEADER,
  operationThreadKey,
  UNKNOWN_THREAD_KEY,
  endOperation,
} from "@web/lib/operation";

const ORIGIN = "http://localhost:5173";

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

beforeEach(() => {
  resetOperationsForTests();
});

describe("canonical thread scope key", () => {
  it("prefers remoteId, then id, then one shared fallback", () => {
    expect(operationThreadKey({ remoteId: "remote-1", id: "local-1" })).toBe("remote-1");
    expect(operationThreadKey({ id: "local-1" })).toBe("local-1");
    expect(operationThreadKey(undefined)).toBe(UNKNOWN_THREAD_KEY);
    expect(operationThreadKey({})).toBe(UNKNOWN_THREAD_KEY);
  });
});

describe("scoped operation registry", () => {
  it("keeps two scopes independent", () => {
    const a = startOperation("chat.send", "conv-A");
    const b = startOperation("chat.send", "conv-B");
    expect(a.id).not.toBe(b.id);
    expect(currentOperationId("conv-A")).toBe(a.id);
    expect(currentOperationId("conv-B")).toBe(b.id);
    // Scoped operations never touch the unscoped global slot.
    expect(currentOperationId()).toBeUndefined();
  });

  it("endOperation ends only the named scope and honors expectedId", () => {
    const a = startOperation("chat.send", "conv-A");
    const b = startOperation("chat.send", "conv-B");
    // Wrong id for A: nothing ends.
    expect(endOperation("conv-A", "finish", b.id)).toBeUndefined();
    expect(currentOperationId("conv-A")).toBe(a.id);
    // Correct id: only A ends.
    expect(endOperation("conv-A", "finish", a.id)).toBe(a.id);
    expect(currentOperationId("conv-A")).toBeUndefined();
    expect(currentOperationId("conv-B")).toBe(b.id);
  });

  it("a stale handle cannot end a newer operation in the same scope", () => {
    const old = startOperation("chat.send", "conv-A");
    const fresh = startOperation("chat.send", "conv-A");
    old.end("late");
    expect(currentOperationId("conv-A")).toBe(fresh.id);
  });
});

describe("operation identity", () => {
  it("mints an opaque id and keeps it stable for the operation's lifetime", () => {
    const op = startOperation("chat.send");
    expect(currentOperationId()).toBe(op.id);
    expect(op.id).toMatch(/^op_[A-Za-z0-9_-]{1,60}$/);
    for (let i = 0; i < 25; i++) expect(currentOperationId()).toBe(op.id);
    expect(currentOperationName()).toBe("chat.send");
    op.end("done");
    expect(currentOperationId()).toBeUndefined();
  });

  it("restores the enclosing operation when a nested one ends", () => {
    const outer = startOperation("chat.send");
    const inner = startOperation("opencode.first_prompt");
    expect(currentOperationId()).toBe(inner.id);
    inner.end("sent");
    expect(currentOperationId()).toBe(outer.id);
    outer.end("done");
    expect(currentOperationId()).toBeUndefined();
  });

  it("ignores a stale handle ending after a newer operation started", () => {
    const stale = startOperation("first");
    const fresh = startOperation("second");
    stale.end("late");
    expect(currentOperationId()).toBe(fresh.id);
  });

  it("is idempotent on repeated end()", () => {
    const outer = startOperation("outer");
    const inner = startOperation("inner");
    inner.end();
    inner.end();
    expect(currentOperationId()).toBe(outer.id);
  });

  it("generates distinct ids", () => {
    expect(new Set(Array.from({ length: 200 }, () => newOperationId())).size).toBe(200);
  });

  it("exposes headers only while an operation is active", () => {
    expect(operationHeaders()).toEqual({});
    const op = startOperation("chat.send");
    expect(operationHeaders()).toEqual({ [OPERATION_ID_HEADER]: op.id });
    op.end();
    expect(operationHeaders()).toEqual({});
  });
});

describe("cleanup discipline on error paths", () => {
  it("clears the context when the scoped work throws", () => {
    expect(() => {
      const op = startOperation("chat.send");
      try {
        throw new Error("boom");
      } finally {
        op.end("threw");
      }
    }).toThrow("boom");
    expect(currentOperationId()).toBeUndefined();
  });

  it("clears the context when the scoped work rejects", async () => {
    const op = startOperation("chat.send");
    await expect(
      (async () => {
        try {
          await Promise.reject(new Error("rejected"));
        } finally {
          op.end("rejected");
        }
      })(),
    ).rejects.toThrow("rejected");
    expect(currentOperationId()).toBeUndefined();
  });

  it("clears the context when the scoped work is cancelled", async () => {
    const op = startOperation("chat.send");
    const controller = new AbortController();
    const work = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const wrapped = (async () => {
      try {
        await work;
      } finally {
        op.end("aborted");
      }
    })();
    controller.abort();
    await expect(wrapped).rejects.toThrow("aborted");
    expect(currentOperationId()).toBeUndefined();
  });

  it("leaves no operation for a later unrelated event to inherit", () => {
    const op = startOperation("chat.send");
    op.end("done");
    // A later browser error would attach nothing: there is no current operation
    // and none is minted for the error itself.
    expect(currentOperationId()).toBeUndefined();
  });
});

describe("the context stack cannot resurrect an ended operation", () => {
  it("does not restore a parent that already ended", () => {
    const parent = startOperation("opencode.first_prompt");
    const child = startOperation("chat.send");
    // Parent ends first (out of order): it must not come back as current when
    // the child finishes, or its stale id would leak into later events.
    parent.end("view-unmounted");
    child.end("done");
    expect(currentOperationId()).toBeUndefined();
  });

  it("still restores a parent that is genuinely live", () => {
    const parent = startOperation("opencode.first_prompt");
    const child = startOperation("chat.send");
    child.end("done");
    expect(currentOperationId()).toBe(parent.id);
    parent.end("view-unmounted");
    expect(currentOperationId()).toBeUndefined();
  });
});

describe("correlatable request decision", () => {
  it("resolves relative, absolute, and Request inputs", () => {
    expect(resolveRequestUrl("/api/chat", ORIGIN)?.pathname).toBe("/api/chat");
    expect(resolveRequestUrl(`${ORIGIN}/api/chat`, ORIGIN)?.pathname).toBe("/api/chat");
    expect(resolveRequestUrl(new URL(`${ORIGIN}/api/chat`), ORIGIN)?.pathname).toBe("/api/chat");
    expect(resolveRequestUrl(new Request(`${ORIGIN}/api/chat`), ORIGIN)?.pathname).toBe(
      "/api/chat",
    );
  });

  it("only correlates same-origin /api paths", () => {
    expect(isCorrelatableRequest(new URL(`${ORIGIN}/api/chat`), ORIGIN)).toBe(true);
    expect(isCorrelatableRequest(new URL(`${ORIGIN}/assets/x.js`), ORIGIN)).toBe(false);
    expect(isCorrelatableRequest(new URL("https://example.com/api/chat"), ORIGIN)).toBe(false);
  });

  it("correlates the verified backend origin (Tauri cross-origin API)", () => {
    const apiOrigin = "http://127.0.0.1:4321";
    expect(isCorrelatableRequest(new URL(`${apiOrigin}/api/chat`), ORIGIN, apiOrigin)).toBe(true);
    // Without the verified origin it is still rejected — only the explicit
    // apiOrigin argument opts a different origin in.
    expect(isCorrelatableRequest(new URL(`${apiOrigin}/api/chat`), ORIGIN)).toBe(false);
  });
});

describe("operation header injection", () => {
  it("adds the header to a same-origin API request", () => {
    const op = startOperation("chat.send");
    const init = operationInitFor("/api/chat", { method: "POST" }, op.id, ORIGIN);
    expect(headerOf(init, OPERATION_ID_HEADER)).toBe(op.id);
    expect(init?.method).toBe("POST");
  });

  it("changes nothing when there is no operation", () => {
    expect(operationInitFor("/api/chat", { method: "POST" }, undefined, ORIGIN)).toBeUndefined();
  });

  it("changes nothing for non-API or cross-origin requests", () => {
    const op = startOperation("chat.send");
    expect(operationInitFor("/assets/index-abc.js", undefined, op.id, ORIGIN)).toBeUndefined();
    expect(
      operationInitFor("https://example.com/api/chat", undefined, op.id, ORIGIN),
    ).toBeUndefined();
  });

  it("adds the header to the verified backend origin (Tauri)", () => {
    const op = startOperation("chat.send");
    const apiOrigin = "http://127.0.0.1:4321";
    const init = operationInitFor(
      `${apiOrigin}/api/chat`,
      { method: "POST" },
      op.id,
      ORIGIN,
      apiOrigin,
    );
    expect(headerOf(init, OPERATION_ID_HEADER)).toBe(op.id);
  });

  it("never overwrites a header the caller set explicitly", () => {
    const op = startOperation("chat.send");
    expect(
      operationInitFor(
        "/api/chat",
        { headers: { [OPERATION_ID_HEADER]: "op_explicit" } },
        op.id,
        ORIGIN,
      ),
    ).toBeUndefined();
  });

  it("preserves caller headers alongside the injected one", () => {
    const op = startOperation("chat.send");
    const init = operationInitFor(
      "/api/chat",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      op.id,
      ORIGIN,
    );
    expect(headerOf(init, "content-type")).toBe("application/json");
    expect(headerOf(init, OPERATION_ID_HEADER)).toBe(op.id);
  });
});
