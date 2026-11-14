import { afterEach, describe, expect, it, mock } from "bun:test";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const agentList = deferred<{ data: unknown[] }>();
const modelList = deferred<{ data: unknown[] }>();
const modelDefault = deferred<{ data: unknown }>();

mock.module("@/services/opencode/client", () => ({
  createOpenCodeClient: () => ({
    agent: { list: () => agentList.promise },
    model: {
      list: () => modelList.promise,
      default: () => modelDefault.promise,
    },
  }),
}));

const { installManagedTarget, resetConnectionStateForTests } = await import(
  "@/services/opencode/connectionState.ts"
);
const { getOpenCodeAuthPassword } = await import("@/services/opencode/runtime.ts");
const { getOpenCodeCapabilities } = await import("@/services/opencode/capabilities.ts");

afterEach(() => {
  resetConnectionStateForTests();
});

describe("getOpenCodeCapabilities target identity consistency", () => {
  it("rejects a read when the runtime target changes during retrieval instead of returning mixed identity", async () => {
    installManagedTarget({
      baseUrl: "http://127.0.0.1:4096",
      password: getOpenCodeAuthPassword(),
    });

    const pending = getOpenCodeCapabilities();
    // Allow the capability read to start against target revision 1.
    await Promise.resolve();

    // Replace the active target while the catalogue/default reads are in flight.
    installManagedTarget({
      baseUrl: "http://127.0.0.1:4097",
      password: getOpenCodeAuthPassword(),
    });

    agentList.resolve({ data: [] });
    modelList.resolve({ data: [] });
    modelDefault.resolve({ data: null });

    await expect(pending).rejects.toThrow();
  });
});
