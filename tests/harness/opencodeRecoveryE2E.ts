/**
 * Shared helpers for the interrupted-turn recovery E2E specs.
 *
 * These drive the real TBAi HTTP API and the real OpenCode session history.
 * Nothing here mutates application state directly — the point is to exercise
 * the production recovery path, not to simulate it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { APIRequestContext, APIResponse } from "@playwright/test";

export const SERVER_TIMEOUT_MS = 120_000;
export const RECOVERY_TIMEOUT_MS = 180_000;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for this recovery acceptance test`);
  return value;
}

export async function waitFor(
  cond: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string,
  interval = 250,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await cond()) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timeout waiting for ${label}`);
}

export async function fetchJson(
  request: APIRequestContext,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; data?: unknown },
): Promise<{ status: number; ok: boolean; body: any; text: string }> {
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

/** Fetch the full OpenCode session message history (newest-first pages, reversed to chronological). */
export async function fetchAllMessages(
  request: APIRequestContext,
  sessionId: string,
): Promise<{ messages: any[]; pageCount: number }> {
  const pages: any[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "?order=desc&limit=100";
    const r = await fetchJson(
      request,
      `/api/opencode/session/${encodeURIComponent(sessionId)}/message${qs}`,
      { headers: { "x-tbai-session": sessionId } },
    );
    if (!r.ok) throw new Error(`message fetch failed: ${r.status} ${r.text}`);
    pages.push(r.body);
    const next = r.body?.cursor?.next ?? undefined;
    if (next !== undefined) {
      if (seen.has(next)) throw new Error("repeated cursor in OpenCode message pagination");
      seen.add(next);
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
  return { messages: [...byId.values()].reverse(), pageCount: pages.length };
}

export interface RecoverySetup {
  readonly conversationId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly prompt: string;
  readonly expectedResponse: string;
}

/** Create an OpenCode conversation + session and submit one prompt by a stable ID. */
export async function createConversationAndSubmit(
  request: APIRequestContext,
  marker: string,
): Promise<RecoverySetup> {
  const expectedResponse = `OK ${marker}`;
  const prompt = `Reply with exactly: ${expectedResponse}`;
  const promptId = `msg_pending_${marker.replace(/[^A-Za-z0-9_-]/g, "_")}`;

  const created = await fetchJson(request, "/api/conversations", {
    method: "POST",
    data: { engine: "opencode", title: `recovery-${marker}` },
  });
  if (!created.ok) throw new Error(`conversation create failed: ${created.status} ${created.text}`);
  const conversationId = created.body.id as string;
  if (!conversationId) throw new Error("conversation create returned no id");

  const session = await fetchJson(request, "/api/opencode/session", {
    method: "POST",
    data: { conversationId },
  });
  if (!session.ok) throw new Error(`session create failed: ${session.status} ${session.text}`);
  const sessionId = session.body.sessionId as string;
  if (!sessionId) throw new Error("session create returned no sessionId");

  const promptRes = await fetchJson(
    request,
    `/api/opencode/api/session/${encodeURIComponent(sessionId)}/prompt`,
    {
      method: "POST",
      headers: { "x-tbai-session": sessionId },
      data: {
        id: promptId,
        text: prompt,
        files: [],
        agents: [],
        skills: [],
        delivery: "steer",
      },
    },
  );
  if (!promptRes.ok) throw new Error(`prompt failed: ${promptRes.status} ${promptRes.text}`);

  return { conversationId, sessionId, promptId, prompt, expectedResponse };
}

/** Wait until the session has a durable execution start (time.busy present). */
export async function waitForExecutionStarted(
  request: APIRequestContext,
  sessionId: string,
): Promise<void> {
  let last: any = null;
  await waitFor(
    async () => {
      const r = await fetchJson(
        request,
        `/api/opencode/api/session/${encodeURIComponent(sessionId)}`,
        { headers: { "x-tbai-session": sessionId } },
      );
      last = { status: r.status, body: r.body };
      const evidenceDir = process.env.TBAI_RESTART_EVIDENCE_DIR;
      if (evidenceDir) {
        try {
          fs.writeFileSync(
            path.join(evidenceDir, "session-poll.json"),
            JSON.stringify(last, null, 2),
            "utf8",
          );
        } catch {
          /* ignore */
        }
      }
      const time = r.body?.data?.time ?? r.body?.time;
      return r.ok && (typeof time?.busy === "number" || typeof time?.busy === "string");
    },
    SERVER_TIMEOUT_MS,
    "execution started (time.busy present)",
  );
}

/** Assert the turn is genuinely unfinished: user present, no assistant, no idle. */
export function assertUnfinished(messages: any[], promptId: string): void {
  const user = messages.find((m) => (m?.id ?? m?.info?.id) === promptId);
  if (!user) throw new Error(`original user message ${promptId} not present in history`);
  const assistant = messages.filter(
    (m) => m?.type === "assistant" || m?.info?.type === "assistant",
  );
  const idle = messages.filter((m) => m?.type === "idle" || m?.info?.type === "idle");
  if (assistant.length > 0)
    throw new Error(`turn unexpectedly has ${assistant.length} assistant message(s)`);
  if (idle.length > 0) throw new Error(`turn unexpectedly has ${idle.length} idle marker(s)`);
}

/** All assistant messages containing the expected response (must be exactly one). */
export function findAssistantResponses(messages: any[], expectedResponse: string): any[] {
  return messages.filter((m) => {
    if (m?.type !== "assistant" && m?.info?.type !== "assistant") return false;
    const content = m?.content ?? m?.info?.content;
    const text = m?.text ?? m?.info?.text;
    const blob = JSON.stringify(content ?? text ?? "");
    return blob.includes(expectedResponse);
  });
}

/** Find a distinct assistant message containing the expected response. */
export function findAssistantResponse(messages: any[], expectedResponse: string): any | undefined {
  return findAssistantResponses(messages, expectedResponse)[0];
}

/** Count logical user messages with the original prompt id (must stay exactly 1). */
export function countOriginalUser(messages: any[], promptId: string): number {
  return messages.filter((m) => (m?.id ?? m?.info?.id) === promptId).length;
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

export function getProcessIdentity(pid: number): any {
  const cmd = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if($p){ [pscustomobject]@{Pid=[int]$p.ProcessId;PPid=[int]$p.ParentProcessId;Name=$p.Name;Exe=$p.ExecutablePath;Cmd=$p.CommandLine;CreationDate=$p.CreationDate.ToString('o')} | ConvertTo-Json -Compress }`;
  return psJson(cmd);
}

export function pidAlive(pid: number): boolean {
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

/** Verify a process's identity and kill it in one PowerShell invocation (TOCTOU-safe). */
export function verifyAndKillProcess(expected: {
  pid: number;
  creationDate?: string;
  exe?: string;
  cmd?: string;
  ppid?: number;
}): { verified: any; killed: boolean } {
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
