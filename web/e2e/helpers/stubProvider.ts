import type { APIRequestContext } from "@playwright/test";

/**
 * Control handle for the suite's shared stub provider.
 *
 * The stub is started by `scripts/start-e2e-server.ts` and seeded as the app's
 * baseline provider, so every spec has a model without borrowing anyone's
 * credentials. This handle only controls it.
 *
 * Specs that need a run to stay IN FLIGHT used to fake it by intercepting the
 * /api/chat request in the browser and holding it. That delivers zero bytes, so
 * the thread never enters a running state and anything asserting on a running
 * run is asserting on a state its own setup prevented. Holding the PROVIDER's
 * stream instead is a real, observable in-flight run.
 */
const STUB_PORT = process.env.TBAI_E2E_STUB_PORT ?? "3199";
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;

export const stubProviderBase = STUB_BASE;

async function control(request: APIRequestContext, path: string, data?: unknown) {
  const res = await request.post(`${STUB_BASE}${path}`, { data });
  if (!res.ok()) throw new Error(`stub ${path} failed: ${res.status()}`);
}

/** Hold every subsequent response open, so the run stays in flight. */
export async function holdStubStream(request: APIRequestContext): Promise<void> {
  await control(request, "/__e2e/hold");
}

/** Release every held response and let those runs finish normally. */
export async function releaseStubStream(request: APIRequestContext): Promise<void> {
  await control(request, "/__e2e/release");
}

/** Set the text a completed stub reply streams back. */
export async function setStubText(request: APIRequestContext, text: string): Promise<void> {
  await control(request, "/__e2e/text", { text });
}

export interface StubState {
  requests: number;
  hold: boolean;
  held: number;
  text: string;
}

export async function readStubState(request: APIRequestContext): Promise<StubState> {
  const res = await request.get(`${STUB_BASE}/__e2e/state`);
  if (!res.ok()) throw new Error(`stub state failed: ${res.status()}`);
  return (await res.json()) as StubState;
}
