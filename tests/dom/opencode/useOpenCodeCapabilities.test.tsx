/**
 * T20 - a failed capabilities read is an ERROR, and it leaves the previously
 * loaded catalogue INTACT.
 *
 * ## THE GAP THIS CLOSES
 *
 * The plan's T20 says: *"a 503 surfaces an error and leaves the previously
 * loaded picker intact"*. The first half was asserted - the pure reader
 * turns a non-2xx into an error, so a 503 is never parsed as an authoritative
 * empty catalogue. The second half was not: nothing asserted that the HOOK
 * keeps the lists it already had.
 *
 * That is the difference that matters to a reader. A failed refetch that
 * REPLACED the list would empty the picker: the reader's model choices vanish,
 * the picker looks authoritative, and nothing says the server failed. The
 * honest outcome is an error with the previous lists still there.
 *
 * ## WHY IT NEEDS A DOM
 *
 * The behaviour is a React state transition across two fetches - a success
 * then a failure - and the hook is the only place that state lives. The pure
 * reader is already covered; this covers the HOOK.
 */

import { describe, expect, it, mock } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/** The responses the stubbed `apiFetch` hands back, in order. */
const responses: Response[] = [];

/**
 * The stubbed `apiFetch`.
 *
 * Registered with `mock.module` BEFORE the hook is imported, because a static
 * import would be hoisted and evaluated first, bypassing the mock (the same
 * convention `tests/dom/mcp/McpPanel.test.tsx` uses).
 *
 * The module's OTHER exports are carried over from the real one: the mock
 * REPLACES the module, so a stub that only declares `apiFetch` would leave
 * every other importer of `platform.ts` without the names they use.
 */
const platform = await import("@web/lib/platform.ts");
mock.module("@web/lib/platform.ts", () => ({
  ...platform,
  apiFetch: async () => {
    const next = responses.shift();
    if (!next) throw new Error("no stubbed response left");
    return next;
  },
}));

const { useOpenCodeCapabilities } = await import(
  "@web/features/opencode/useOpenCodeCapabilities.ts"
);
const { useAvailabilityStore } = await import("@web/features/availability/availabilityStore.ts");

/** A capabilities payload with one model and one agent. */
function capabilitiesResponse(): Response {
  return new Response(
    JSON.stringify({
      agents: [{ id: "build", name: "build" }],
      models: [{ id: "model-a", name: "Model A", providerID: "prov", variants: ["high"] }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A failing capabilities response. */
function failingResponse(): Response {
  return new Response(JSON.stringify({ error: "the server went away" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

/** What the hook reported at its latest render. */
interface HookState {
  agents: readonly { id: string }[];
  models: readonly { id: string }[];
  error: string | null;
  isLoading: boolean;
}

let latest: HookState = { agents: [], models: [], error: null, isLoading: false };

/** Renders the hook and records what it reported. */
function Harness() {
  const state = useOpenCodeCapabilities(true);
  latest = {
    agents: state.agents,
    models: state.models,
    error: state.error,
    isLoading: state.isLoading,
  };
  return null;
}

describe("T20 - a failed capabilities read leaves the loaded catalogue intact", () => {
  it("keeps the previous models and reports the error", async () => {
    responses.length = 0;
    responses.push(capabilitiesResponse());
    responses.push(failingResponse());

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      // The first fetch succeeds: the catalogue is loaded.
      await act(async () => {
        root.render(createElement(Harness));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(latest.models.map((model) => model.id)).toEqual(["model-a"]);
      expect(latest.error).toBeNull();

      // The second fetch FAILS. The refetch is triggered by the availability
      // store's recovery epoch - that is what the hook keys its effect on, so
      // bumping it is what a recovery looks like to the hook.
      await act(async () => {
        useAvailabilityStore.setState((state) => ({ recoveryEpoch: state.recoveryEpoch + 1 }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(latest.error).toBe("the server went away");

      // ...and the catalogue the reader was choosing from is STILL THERE. The
      // failure did not replace the list with an authoritative-looking empty
      // one.
      expect(latest.models.map((model) => model.id)).toEqual(["model-a"]);
      expect(latest.agents.map((agent) => agent.id)).toEqual(["build"]);
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });
});
