import { describe, it, expect } from "bun:test";
import { disableIdleTimeout } from "../../src/routes/shared";

function fakeContext(env: unknown) {
  return { req: { raw: new Request("http://localhost:3000/api/logs/stream") }, env };
}

describe("disableIdleTimeout", () => {
  it("disables the timeout for the exact request", () => {
    const calls: Array<{ req: Request; seconds: number }> = [];
    const ctx = fakeContext({
      timeout: (req: Request, seconds: number) => {
        calls.push({ req, seconds });
      },
    });
    disableIdleTimeout(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].req).toBe(ctx.req.raw);
    expect(calls[0].seconds).toBe(0);
  });

  it("is a no-op without a server (tests, other runtimes, missing env)", () => {
    expect(() => disableIdleTimeout(fakeContext(undefined))).not.toThrow();
    expect(() => disableIdleTimeout(fakeContext(null))).not.toThrow();
    expect(() => disableIdleTimeout(fakeContext({}))).not.toThrow();
    expect(() => disableIdleTimeout(fakeContext({ timeout: "yes" }))).not.toThrow();
  });

  it("survives a throwing timeout implementation", () => {
    const ctx = fakeContext({
      timeout: () => {
        throw new Error("gone");
      },
    });
    expect(() => disableIdleTimeout(ctx)).not.toThrow();
  });
});
