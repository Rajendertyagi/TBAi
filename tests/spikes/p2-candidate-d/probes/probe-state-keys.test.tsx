/**
 * SPIKE — probe: what does the thread state actually expose?
 * TEMPORARY, removable.
 */
import { expect, it } from "bun:test";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  AssistantRuntimeProvider,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useChat } from "../resolve.ts";

it("dumps thread state keys", async () => {
  function Probe() {
    const keys = useAuiState((s) => Object.keys(s.thread).sort().join(","));
    const threadKeys = useAuiState((s) => Object.keys(s).sort().join(","));
    return (
      <div>
        <span data-testid="threadKeys">{keys}</span>
        <span data-testid="rootKeys">{threadKeys}</span>
      </div>
    );
  }

  function Candidate() {
    const chat = useChat({
      id: "probe",
      transport: useMemo(
        () =>
          ({
            sendMessages: async () =>
              new ReadableStream({ start: (c) => c.close() }) as never,
          }) as never,
        [],
      ),
      messages: [] as never,
    });
    const runtime = useExternalStoreRuntime({
      messages: [] as never,
      hasEarlier: true,
      onLoadEarlier: async () => {
        (globalThis as Record<string, unknown>).__called = true;
      },
    } as never);
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <Probe />
      </AssistantRuntimeProvider>
    );
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Candidate />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

  const threadKeys = container.querySelector('[data-testid="threadKeys"]')?.textContent ?? "";
  const rootKeys = container.querySelector('[data-testid="rootKeys"]')?.textContent ?? "";
  console.log("=== PROBE: thread state keys ===");
  console.log(threadKeys);
  console.log("=== PROBE: root state keys ===");
  console.log(rootKeys);

  expect(threadKeys.length).toBeGreaterThan(0);

  await act(async () => root.unmount());
});