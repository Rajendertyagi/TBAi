import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROUTE_TIMEOUT_MS = 30_000;
const SERVER_TIMEOUT_MS = 120_000;
const RESTART_TIMEOUT_MS = 120_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for this acceptance test`);
  return value;
}

const EVIDENCE_DIR = requireEnv("TBAI_RESTART_EVIDENCE_DIR");
const TEMP_ROOT = requireEnv("TBAI_RESTART_TEMP_ROOT");
const REGISTRATION_PATH = path.join(TEMP_ROOT, "xdg-state", "opencode", "service.json");

function writeEvidence(name: string, data: unknown): void {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), JSON.stringify(data, null, 2), "utf8");
}

function redactRegistration(reg: any): any {
  if (!reg || typeof reg !== "object") return reg;
  const { password, ...rest } = reg;
  return { ...rest, password: password ? "<redacted>" : password };
}

function psJson(command: string): any {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return { raw: r.stdout.trim() };
  }
}

function getProcessIdentity(pid: number): any {
  const cmd = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if($p){ [pscustomobject]@{Pid=[int]$p.ProcessId;PPid=[int]$p.ParentProcessId;Name=$p.Name;Exe=$p.ExecutablePath;Cmd=$p.CommandLine;CreationDate=$p.CreationDate.ToString('o')} | ConvertTo-Json -Compress }`;
  return psJson(cmd);
}

function pidAlive(pid: number): boolean {
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -First 1 Id`,
    ],
    { encoding: "utf8" },
  );
  return (r.stdout || "").includes(String(pid));
}

async function waitFor(
  cond: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string,
  interval = 250,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await cond()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function verifyAndKillProcess(expected: {
  pid: number;
  creationDate?: string;
  exe?: string;
  cmd?: string;
  ppid?: number;
}): { verified: any; killed: boolean } {
  // Verify and terminate in one PowerShell invocation to minimize TOCTOU; retains process object in-script.
  const script = `
$ErrorActionPreference='Stop'
$targetPid=${expected.pid}
$p=Get-Process -Id $targetPid -ErrorAction Stop
$c=Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction Stop
$info=[pscustomobject]@{Pid=[int]$c.ProcessId;PPid=[int]$c.ParentProcessId;Name=$c.Name;Exe=$c.ExecutablePath;Cmd=$c.CommandLine;CreationDate=$c.CreationDate.ToString('o')}
$ok=$true
if('${(expected.exe ?? "").replace(/'/g, "''")}' -ne '' -and $info.Exe -ne '${(expected.exe ?? "").replace(/'/g, "''")}'){ $ok=$false }
if('${(expected.cmd ?? "").replace(/'/g, "''")}' -ne '' -and $info.Cmd -ne '${(expected.cmd ?? "").replace(/'/g, "''")}'){ $ok=$false }
if('${expected.creationDate ?? ""}' -ne '' -and $info.CreationDate -ne '${expected.creationDate ?? ""}'){ $ok=$false }
if(${expected.ppid ?? -1} -ge 0 -and $info.PPid -ne ${expected.ppid ?? -1}){ $ok=$false }
if(-not $ok){ [pscustomobject]@{verified=$false;info=$info} | ConvertTo-Json -Compress -Depth 5; exit 2 }
$p.Kill()
[pscustomobject]@{verified=$true;killed=$true;info=$info} | ConvertTo-Json -Compress -Depth 5
`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  const out = (r.stdout || "").trim();
  let parsed: any = null;
  try {
    parsed = out ? JSON.parse(out) : null;
  } catch {
    parsed = { raw: out, stderr: r.stderr };
  }
  if (r.status !== 0 || !parsed?.verified) {
    throw new Error(
      `process identity mismatch or kill failed: ${JSON.stringify(parsed)} stderr=${r.stderr}`,
    );
  }
  return { verified: parsed.info, killed: true };
}

async function fetchJson(
  request: APIRequestContext,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; data?: any },
) {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = init?.headers ?? {};
  let res: APIResponse;
  if (method === "GET") res = await request.get(url, { headers });
  else if (method === "POST") res = await request.post(url, { headers, data: init?.data });
  else if (method === "DELETE") res = await request.delete(url, { headers });
  else throw new Error(`unsupported method ${method}`);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status(), ok: res.ok(), body, text };
}

async function fetchAllOpenCodeMessages(request: APIRequestContext, sessionId: string) {
  const pages: any[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "?order=desc&limit=100";
    const r = await fetchJson(
      request,
      `/api/opencode/session/${encodeURIComponent(sessionId)}/message${qs}`,
      {
        headers: { "x-tbai-session": sessionId },
      },
    );
    if (!r.ok) throw new Error(`message fetch failed: ${r.status} ${r.text}`);
    pages.push(r.body);
    pageCount += 1;
    const next = r.body?.cursor?.next ?? undefined;
    if (next !== undefined) {
      if (seenCursors.has(next)) throw new Error("repeated cursor in OpenCode message pagination");
      seenCursors.add(next);
    }
    cursor = next;
  } while (cursor !== undefined);

  const byId = new Map<string, any>();
  for (const page of pages) {
    const data = Array.isArray(page?.data) ? page.data : Array.isArray(page) ? page : [];
    for (const msg of data) {
      const id = msg?.id ?? msg?.info?.id;
      if (id) byId.set(id, msg);
    }
  }
  // API returns desc pages; reverse to chronological for stable comparison.
  const messages = [...byId.values()].reverse();
  return { pages, pageCount, messages };
}

async function waitForDistinctAssistantResponse(
  request: APIRequestContext,
  sessionId: string,
  marker: string,
  prompt: string,
  expectedResponse: string,
  timeoutMs = 120_000,
) {
  let last: any = null;
  await waitFor(
    async () => {
      const transcript = await fetchAllOpenCodeMessages(request, sessionId);
      const analysis = analyzeTranscript(transcript.messages, marker, prompt, expectedResponse);
      last = { transcript, analysis };
      // Wait for the SETTLED transcript, not merely the first streamed text.
      // The assistant message gains `finish`/`completed`/`tokens` and an `idle`
      // marker after the turn ends. Snapshotting before that makes the
      // before/after comparison race: the `before` copy is mid-stream while the
      // `after` copy is settled, so they differ even though recovery preserved
      // the transcript. Requiring the settled state is deterministic and proves
      // the response was fully persisted before the restart.
      return (
        analysis.assistantResponseComplete &&
        analysis.distinctAssistantIds.length > 0 &&
        analysis.assistantResponseSettled &&
        analysis.idlePresent
      );
    },
    timeoutMs,
    "distinct assistant response persisted in OpenCode session history",
    500,
  );
  return last as {
    transcript: Awaited<ReturnType<typeof fetchAllOpenCodeMessages>>;
    analysis: ReturnType<typeof analyzeTranscript>;
  };
}

function normalizeMessage(msg: any): any {
  // Normalize for comparison: stable identity/order/content fields; ignore volatile transport wrappers.
  return {
    id: msg?.id ?? msg?.info?.id ?? null,
    type: msg?.type ?? msg?.info?.type ?? null,
    role: msg?.role ?? msg?.info?.role ?? null,
    text: msg?.text ?? msg?.info?.text ?? null,
    content: msg?.content ?? msg?.info?.content ?? null,
    parts: msg?.parts ?? null,
    time: msg?.time ?? msg?.info?.time ?? null,
    finish: msg?.finish ?? msg?.info?.finish ?? null,
    rawFinish: msg?.rawFinish ?? msg?.info?.rawFinish ?? null,
    agent: msg?.agent ?? msg?.info?.agent ?? null,
    model: msg?.model ?? msg?.info?.model ?? null,
    outcome: msg?.outcome ?? msg?.info?.outcome ?? null,
    cost: msg?.cost ?? msg?.info?.cost ?? null,
    tokens: msg?.tokens ?? msg?.info?.tokens ?? null,
    error: msg?.error ?? msg?.info?.error ?? null,
  };
}

function compareTranscripts(before: { messages: any[] }, after: { messages: any[] }) {
  const bIds = before.messages.map((m) => m?.id ?? m?.info?.id ?? null);
  const aIds = after.messages.map((m) => m?.id ?? m?.info?.id ?? null);
  const bNorm = before.messages.map(normalizeMessage);
  const aNorm = after.messages.map(normalizeMessage);
  return {
    equal:
      JSON.stringify(bIds) === JSON.stringify(aIds) &&
      JSON.stringify(bNorm) === JSON.stringify(aNorm),
    beforeIds: bIds,
    afterIds: aIds,
    beforeCount: before.messages.length,
    afterCount: after.messages.length,
  };
}

function messageContainsText(msg: any, text: string): boolean {
  if (!msg || !text) return false;
  if (typeof msg.text === "string" && msg.text.includes(text)) return true;
  if (typeof msg.content === "string" && msg.content.includes(text)) return true;
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (typeof part === "string" && part.includes(text)) return true;
      if (part && typeof part === "object") {
        if (typeof part.text === "string" && part.text.includes(text)) return true;
        if (typeof part.content === "string" && part.content.includes(text)) return true;
      }
    }
  }
  if (Array.isArray(msg.parts)) {
    for (const part of msg.parts) {
      if (typeof part === "string" && part.includes(text)) return true;
      if (part && typeof part === "object") {
        if (typeof part.text === "string" && part.text.includes(text)) return true;
        if (typeof part.value === "string" && part.value.includes(text)) return true;
        if (typeof part.content === "string" && part.content.includes(text)) return true;
      }
    }
  }
  return false;
}

function analyzeTranscript(
  messages: any[],
  marker: string,
  prompt: string,
  expectedResponse: string,
) {
  const normalized = messages.map(normalizeMessage);
  const userMessages = normalized.filter((m) => m.type === "user" || m.role === "user");
  const assistantMessages = normalized.filter(
    (m) => m.type === "assistant" || m.role === "assistant",
  );
  const markerInUserPrompt = userMessages.some((m) => messageContainsText(m, marker));
  const markerInAssistantResponse = assistantMessages.some((m) => messageContainsText(m, marker));
  const expectedResponseInAssistant = assistantMessages.some((m) =>
    messageContainsText(m, expectedResponse),
  );
  const promptPresent = userMessages.some(
    (m) => m.text === prompt || messageContainsText(m, prompt),
  );
  const distinctAssistantWithResponse = assistantMessages.filter((m) =>
    messageContainsText(m, expectedResponse),
  );
  return {
    messageCount: messages.length,
    ids: normalized.map((m) => m.id),
    types: normalized.map((m) => m.type),
    roles: normalized.map((m) => m.role),
    userCount: userMessages.length,
    assistantCount: assistantMessages.length,
    promptPresent,
    markerInUserPrompt,
    markerInAssistantResponse,
    expectedResponseInAssistant,
    assistantResponseComplete: expectedResponseInAssistant,
    // Settled = the distinct assistant message has a terminal finish reason and
    // a completion timestamp, i.e. the turn fully persisted rather than only
    // streaming its first text delta.
    assistantResponseSettled:
      distinctAssistantWithResponse.length > 0 &&
      distinctAssistantWithResponse.every((m) => m.finish != null && m.time?.completed != null),
    // The `idle` marker is published when the session finishes the turn. Its
    // presence means the transcript will not gain more messages from this turn.
    idlePresent: normalized.some((m) => m.type === "idle"),
    distinctAssistantIds: distinctAssistantWithResponse.map((m) => m.id),
    distinctAssistantMessages: distinctAssistantWithResponse,
  };
}

async function openCodeDraft(page: Page): Promise<void> {
  await page.goto("/#/code");
  await expect(page).toHaveURL(/#\/chat\/new$/, { timeout: ROUTE_TIMEOUT_MS });
  const engine = page.getByRole("group", { name: "Engine" });
  await expect(engine).toBeVisible({ timeout: ROUTE_TIMEOUT_MS });
  const openCode = engine.getByRole("button", { name: "OpenCode" });
  if ((await openCode.getAttribute("aria-pressed")) !== "true") {
    await openCode.click();
  }
  await expect(openCode).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: /Send a message/ })).toBeVisible({
    timeout: ROUTE_TIMEOUT_MS,
  });
}

test("Code UI recovers same OpenCode transcript after managed child restart and reload", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const marker =
    process.env.TBAI_RESTART_FIXED_MARKER ||
    `UI-RESTART-MARKER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const expectedResponse = `OK ${marker}`;
  const prompt = `Reply with exactly: ${expectedResponse}`;
  let conversationId: string | null = null;
  let sessionId: string | null = null;

  try {
    await openCodeDraft(page);

    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/conversations",
      { timeout: SERVER_TIMEOUT_MS },
    );
    const sessionResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/opencode/session",
      { timeout: SERVER_TIMEOUT_MS },
    );
    const promptResponsePromise = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          /^\/api\/opencode\/(?:api\/)?session\/[^/]+\/prompt$/.test(url.pathname)
        );
      },
      { timeout: SERVER_TIMEOUT_MS },
    );

    const composer = page.getByRole("textbox", { name: /Send a message/ });
    await expect(composer).toBeVisible({ timeout: SERVER_TIMEOUT_MS });
    const send = page.getByRole("button", { name: "Send message" });
    // The composer disables Send until the Code session is ready to accept a
    // prompt. Clicking before then drops the text and never issues the prompt
    // POST, which made this acceptance test flaky. Wait for a sendable state.
    await composer.fill(prompt);
    await expect(send).toBeEnabled({ timeout: SERVER_TIMEOUT_MS });
    await expect(composer).toHaveValue(prompt);
    await send.click();

    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBe(true);
    const created = (await createResponse.json()) as { id: string; engine?: string };
    conversationId = created.id;
    expect(created.engine).toBe("opencode");

    await expect(page).toHaveURL(new RegExp(`#\\/code\\/${created.id}$`), {
      timeout: SERVER_TIMEOUT_MS,
    });
    const sessionResponse = await sessionResponsePromise;
    expect(sessionResponse.ok()).toBe(true);
    const sessionBody = (await sessionResponse.json()) as {
      sessionId?: string;
      directory?: string;
    };
    sessionId = sessionBody.sessionId ?? null;
    expect(sessionId).toBeTruthy();

    const promptResponse = await promptResponsePromise;
    expect(promptResponse.ok()).toBe(true);
    const promptResponseBody = await promptResponse.json().catch(async () => {
      const t = await promptResponse.text().catch(() => "");
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    });
    writeEvidence("prompt-response.json", promptResponseBody);

    await expect(page.getByText(prompt, { exact: true })).toBeVisible({
      timeout: SERVER_TIMEOUT_MS,
    });
    await expect(page.getByRole("button", { name: "OpenCode status: Connected" })).toBeVisible({
      timeout: SERVER_TIMEOUT_MS,
    });

    // Wait for a distinct assistant response to be persisted in OpenCode session history
    // before restart. UI visibility alone is insufficient (prompt text contains the marker).
    const before = await waitForDistinctAssistantResponse(
      page.request,
      sessionId!,
      marker,
      prompt,
      expectedResponse,
      SERVER_TIMEOUT_MS,
    );
    const transcriptBefore = before.transcript;
    const transcriptAnalysisBefore = before.analysis;
    writeEvidence("transcript-before.json", {
      ...transcriptBefore,
      analysis: transcriptAnalysisBefore,
    });
    expect(transcriptBefore.messages.length).toBeGreaterThan(0);
    expect(transcriptAnalysisBefore.promptPresent).toBe(true);
    expect(transcriptAnalysisBefore.userCount).toBeGreaterThanOrEqual(1);
    expect(transcriptAnalysisBefore.assistantCount).toBeGreaterThanOrEqual(1);
    expect(transcriptAnalysisBefore.distinctAssistantIds.length).toBeGreaterThanOrEqual(1);
    expect(transcriptAnalysisBefore.expectedResponseInAssistant).toBe(true);
    expect(transcriptAnalysisBefore.markerInAssistantResponse).toBe(true);
    // The assistant response must be a separate assistant record, never matched inside the user prompt.
    expect(
      transcriptAnalysisBefore.distinctAssistantMessages.every(
        (m: any) => m.type === "assistant" || m.role === "assistant",
      ),
    ).toBe(true);

    // UI should show the assistant response as rendered content (separate from prompt text).
    await expect(page.getByText(expectedResponse, { exact: false }).first()).toBeVisible({
      timeout: SERVER_TIMEOUT_MS,
    });

    writeEvidence(
      "ui-before-restart.txt",
      await page
        .locator("main, body")
        .first()
        .innerText()
        .catch(() => ""),
    );

    const statusBefore = await fetchJson(page.request, "/api/opencode/status");
    expect(statusBefore.ok).toBe(true);
    writeEvidence("runtime-status-before.json", statusBefore.body);

    const regBefore = JSON.parse(fs.readFileSync(REGISTRATION_PATH, "utf8"));
    writeEvidence("registration-before.json", redactRegistration(regBefore));
    const childPidBefore = regBefore?.pid;
    expect(typeof childPidBefore).toBe("number");
    const childIdentityBefore = getProcessIdentity(childPidBefore);
    expect(childIdentityBefore?.Pid).toBe(childPidBefore);
    writeEvidence("child-identity-before.json", childIdentityBefore);

    // Verify and terminate only the verified managed child.
    const killResult = verifyAndKillProcess({
      pid: childPidBefore,
      creationDate: childIdentityBefore?.CreationDate,
      exe: childIdentityBefore?.Exe,
      cmd: childIdentityBefore?.Cmd,
      ppid: childIdentityBefore?.PPid,
    });
    writeEvidence("child-kill.json", killResult);
    await waitFor(async () => !pidAlive(childPidBefore), 30000, "managed child dead");

    // Wait for managed restart and new runtime target.
    await waitFor(
      async () => {
        const st = await fetchJson(page.request, "/api/opencode/status");
        if (!st.ok || st.body?.mode !== "managed") return false;
        if (!fs.existsSync(REGISTRATION_PATH)) return false;
        const reg = JSON.parse(fs.readFileSync(REGISTRATION_PATH, "utf8"));
        return reg?.pid && reg.pid !== childPidBefore && pidAlive(reg.pid);
      },
      RESTART_TIMEOUT_MS,
      "managed restart",
    );

    const statusAfter = await fetchJson(page.request, "/api/opencode/status");
    expect(statusAfter.ok).toBe(true);
    writeEvidence("runtime-status-after.json", statusAfter.body);
    expect(statusAfter.body?.mode).toBe("managed");
    expect(statusAfter.body?.targetRevision).not.toBe(statusBefore.body?.targetRevision);

    const regAfter = JSON.parse(fs.readFileSync(REGISTRATION_PATH, "utf8"));
    writeEvidence("registration-after.json", redactRegistration(regAfter));
    const childPidAfter = regAfter?.pid;
    expect(childPidAfter).toBeTruthy();
    expect(childPidAfter).not.toBe(childPidBefore);
    const childIdentityAfter = getProcessIdentity(childPidAfter);
    writeEvidence("child-identity-after.json", childIdentityAfter);

    // Verify original conversation still uses original session ID.
    const sessionAfter = await fetchJson(page.request, "/api/opencode/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      data: { conversationId },
    });
    expect(sessionAfter.ok).toBe(true);
    writeEvidence("session-after.json", sessionAfter.body);
    expect(sessionAfter.body?.sessionId).toBe(sessionId);

    // UI should reconnect and display original prompt/response without duplicates.
    await expect(page.getByRole("button", { name: "OpenCode status: Connected" })).toBeVisible({
      timeout: SERVER_TIMEOUT_MS,
    });
    await expect(page.getByText(prompt, { exact: true })).toHaveCount(1, {
      timeout: SERVER_TIMEOUT_MS,
    });
    // Prompt text contains the expected response substring; require at least the assistant response to be visible.
    await expect(page.getByText(expectedResponse, { exact: false }).first()).toBeVisible({
      timeout: SERVER_TIMEOUT_MS,
    });
    writeEvidence(
      "ui-after-restart.txt",
      await page
        .locator("main, body")
        .first()
        .innerText()
        .catch(() => ""),
    );

    // Reload and verify reconstruction from persisted OpenCode history.
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`#\\/code\\/${conversationId}$`), {
      timeout: SERVER_TIMEOUT_MS,
    });
    await expect(page.getByRole("button", { name: "OpenCode status: Connected" })).toBeVisible({
      timeout: SERVER_TIMEOUT_MS,
    });
    await expect(page.getByText(prompt, { exact: true })).toHaveCount(1, {
      timeout: SERVER_TIMEOUT_MS,
    });
    await expect(page.getByText(expectedResponse, { exact: false }).first()).toBeVisible({
      timeout: SERVER_TIMEOUT_MS,
    });
    writeEvidence(
      "ui-after-reload.txt",
      await page
        .locator("main, body")
        .first()
        .innerText()
        .catch(() => ""),
    );

    const transcriptAfter = await fetchAllOpenCodeMessages(page.request, sessionId!);
    const transcriptAnalysisAfter = analyzeTranscript(
      transcriptAfter.messages,
      marker,
      prompt,
      expectedResponse,
    );
    writeEvidence("transcript-after.json", {
      ...transcriptAfter,
      analysis: transcriptAnalysisAfter,
    });
    const comparison = compareTranscripts(transcriptBefore, transcriptAfter);
    writeEvidence("transcript-comparison.json", {
      ...comparison,
      beforeAnalysis: transcriptAnalysisBefore,
      afterAnalysis: transcriptAnalysisAfter,
      allCursorsConsumed: {
        before: transcriptBefore.pages.every((p: any) => p?.cursor?.next == null),
        after: transcriptAfter.pages.every((p: any) => p?.cursor?.next == null),
      },
    });
    expect(comparison.equal).toBe(true);
    expect(comparison.beforeCount).toBe(comparison.afterCount);
    expect(transcriptAfter.pageCount).toBeGreaterThanOrEqual(1);
    expect(transcriptAnalysisAfter.promptPresent).toBe(true);
    expect(transcriptAnalysisAfter.assistantCount).toBeGreaterThanOrEqual(1);
    expect(transcriptAnalysisAfter.distinctAssistantIds.length).toBeGreaterThanOrEqual(1);
    expect(transcriptAnalysisAfter.expectedResponseInAssistant).toBe(true);
    expect(transcriptAnalysisAfter.markerInAssistantResponse).toBe(true);
    expect(
      transcriptAnalysisAfter.distinctAssistantMessages.every(
        (m: any) => m.type === "assistant" || m.role === "assistant",
      ),
    ).toBe(true);

    writeEvidence("summary.json", {
      marker,
      expectedResponse,
      prompt,
      conversationId,
      sessionId,
      childPidBefore,
      childPidAfter,
      statusBefore: statusBefore.body,
      statusAfter: statusAfter.body,
      transcript: {
        beforePages: transcriptBefore.pageCount,
        afterPages: transcriptAfter.pageCount,
        beforeCount: transcriptBefore.messages.length,
        afterCount: transcriptAfter.messages.length,
        beforeIds: comparison.beforeIds,
        afterIds: comparison.afterIds,
        beforeTypes: transcriptAnalysisBefore.types,
        afterTypes: transcriptAnalysisAfter.types,
        beforeRoles: transcriptAnalysisBefore.roles,
        afterRoles: transcriptAnalysisAfter.roles,
        promptPresent: transcriptAnalysisAfter.promptPresent,
        markerInUserPrompt: transcriptAnalysisAfter.markerInUserPrompt,
        markerInAssistantResponse: transcriptAnalysisAfter.markerInAssistantResponse,
        expectedResponseInAssistant: transcriptAnalysisAfter.expectedResponseInAssistant,
        distinctAssistantIds: transcriptAnalysisAfter.distinctAssistantIds,
        assistantResponseComplete: transcriptAnalysisAfter.assistantResponseComplete,
        equal: comparison.equal,
      },
    });
  } finally {
    if (conversationId) {
      await page.request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
    }
  }
});
