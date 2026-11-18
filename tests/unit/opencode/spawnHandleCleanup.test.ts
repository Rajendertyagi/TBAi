import { describe, expect, it } from "bun:test";
import { createHandleGuard, type NativeHandle } from "@/services/process-ownership.ts";

/**
 * M4 / §3-E: exactly-once native handle cleanup.
 *
 * The spawn path's failure branches all funnel through a single `finally` that
 * uses this guard. These tests pin the guard's semantics deterministically
 * without any real Win32 calls: every acquired handle is closed at most once,
 * released handles are never closed, and closeAll is idempotent. The guard is
 * the mechanism the spawn function uses on every path, so these tests cover
 * the cleanup contract that all failure branches rely on.
 */

describe("createHandleGuard — exactly-once native handle cleanup (M4)", () => {
  it("closes each owned handle exactly once", () => {
    const closed: NativeHandle[] = [];
    const guard = createHandleGuard((h) => closed.push(h));
    const a = 1n as NativeHandle;
    const b = 2n as NativeHandle;
    guard.add(a);
    guard.add(b);
    guard.closeOnce(a);
    guard.closeOnce(a); // second call is a no-op
    guard.closeOnce(b);
    expect(closed).toEqual([a, b]);
    expect(guard.size).toBe(0);
  });

  it("closeAll closes every remaining handle once and is idempotent", () => {
    const closed: NativeHandle[] = [];
    const guard = createHandleGuard((h) => closed.push(h));
    const a = 1n as NativeHandle;
    const b = 2n as NativeHandle;
    guard.add(a);
    guard.add(b);
    guard.closeAll();
    guard.closeAll(); // no-op the second time
    expect(closed).toEqual([a, b]);
  });

  it("released handles are never closed (ownership transferred to caller)", () => {
    const closed: NativeHandle[] = [];
    const guard = createHandleGuard((h) => closed.push(h));
    const proc = 1n as NativeHandle;
    const read = 2n as NativeHandle;
    const write = 3n as NativeHandle;
    guard.add(proc);
    guard.add(read);
    guard.add(write);
    // Success path: proc + read end transferred, write end closed in parent.
    guard.release(proc);
    guard.release(read);
    guard.closeOnce(write);
    guard.closeAll(); // finally block on success
    expect(closed).toEqual([write]);
    expect(closed).not.toContain(proc);
    expect(closed).not.toContain(read);
  });

  it("a handle closed then released is not closed again", () => {
    const closed: NativeHandle[] = [];
    const guard = createHandleGuard((h) => closed.push(h));
    const h = 1n as NativeHandle;
    guard.add(h);
    guard.closeOnce(h);
    guard.release(h);
    guard.closeAll();
    expect(closed).toEqual([h]);
  });

  it("simulates the CreateProcessW-failure path: all 5 handles closed once", () => {
    // NUL + 4 pipe handles are registered before CreateProcessW; on failure the
    // finally block closes all of them exactly once (the double-delete of the
    // attribute list is a separate concern handled by the single delete call).
    const closed: NativeHandle[] = [];
    const guard = createHandleGuard((h) => closed.push(h));
    const handles = [1n, 2n, 3n, 4n, 5n].map((n) => n as NativeHandle);
    for (const h of handles) guard.add(h);
    // CreateProcessW fails → finally closes all owned handles.
    guard.closeAll();
    expect(closed).toEqual(handles);
    expect(new Set(closed).size).toBe(5); // no double-close
  });
});
