import { describe, expect, it, mock, beforeEach } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The provider dialog's test → discover request sequence.
 *
 * "Test connection" already runs a full model discovery server-side. The
 * dialog used to fire a SECOND discovery request after a successful test —
 * for Ollama that means N extra /api/show round-trips per click. The test
 * endpoint now returns the discovered models and the dialog reuses them.
 *
 * This test pins the request sequence: one /api/providers/test call, ZERO
 * /api/providers/discover calls, and the discovered models rendered from the
 * test response.
 */

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const recorded: Recorded[] = [];

const TEST_MODELS = [
  { id: "gpt-test-alpha", provider: "openai" },
  { id: "gpt-test-beta", provider: "openai" },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

mock.module("@web/lib/platform", () => ({
  apiFetch: async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" && init.body.length > 0
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    recorded.push({ method, path: input, body });
    if (input === "/api/providers/test") {
      return json({ ok: true, modelCount: TEST_MODELS.length, models: TEST_MODELS });
    }
    if (input === "/api/providers/discover") {
      return json({ ok: true, models: TEST_MODELS });
    }
    return json({ error: "unhandled" }, 404);
  },
  isTauri: () => false,
  updateVerifiedPort: async () => {},
}));

mock.module("@web/features/providers/state/providersStore", () => ({
  useSettingsStore: () => ({ loadProviders: async () => {} }),
}));

mock.module("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
}));

const { AddProviderDialog } = await import("@web/features/providers/ProviderDialog.tsx");

function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found as HTMLButtonElement;
}

describe("provider dialog — test connection request sequence", () => {
  beforeEach(() => {
    recorded.length = 0;
    document.body.innerHTML = "";
  });

  it("reuses the test response's models and never calls /api/providers/discover", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(<AddProviderDialog open={true} onOpenChange={() => {}} onSaved={() => {}} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    try {
      const nameInput = document.querySelector<HTMLInputElement>("#add-mp-name");
      if (!nameInput) throw new Error("name input not rendered");
      typeInto(nameInput, "Test provider");

      await click(button("Test connection"));

      const testCalls = recorded.filter((r) => r.path === "/api/providers/test");
      const discoverCalls = recorded.filter((r) => r.path === "/api/providers/discover");
      expect(testCalls).toHaveLength(1);
      expect(discoverCalls).toHaveLength(0);

      // The discovered models from the test response are rendered for picking.
      expect(document.body.textContent).toContain("gpt-test-alpha");
      expect(document.body.textContent).toContain("gpt-test-beta");
      // The success message is precise about what was verified.
      expect(document.body.textContent).toContain("Model list reachable (2 models found)");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
