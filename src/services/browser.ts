import { ToolError } from "./tools";
import type { BrowserReadArgs, BrowserActionArgs } from "../lib/validation";

/** Executable that fronts the persistent agent-browser daemon (Chromium). */
export const AGENT_BROWSER_BIN = "agent-browser";

/** Hard ceiling for a single browser command; mirrors the shell-tool timeout. */
export const BROWSER_TIMEOUT_MS = 120_000;

/** Bound on captured stdout/stderr, matching the existing tool output limit. */
export const BROWSER_MAX_OUTPUT_BYTES = 200_000;

export type BrowserReadAction = BrowserReadArgs["action"];
export type BrowserActionAction = BrowserActionArgs["action"];

export type BrowserResult = {
  action: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  path?: string;
  mimeType?: string;
};

const MISSING_BINARY_MESSAGE =
  "agent-browser is not installed or not on PATH. Install it with: npm i -g agent-browser && agent-browser install";

// Best-effort detection of a screenshot file path in CLI output. The structured
// `path`/`mimeType` lets the frontend render the image later without changing
// the tool contract; we never parse free-form human text for semantics.
const IMAGE_PATH_RE = /(\S+\.(?:png|jpe?g|webp))(?:\s|$)/i;

/**
 * Explicit, typed command construction. Each supported operation maps to a fixed
 * argument list — no arbitrary `action + rest` passthrough to Bun.spawn. Required
 * fields are guaranteed present by the Zod schema before this runs, but each
 * builder re-checks defensively so the spawned CLI never receives an empty arg.
 */
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Ensure a navigation target has an explicit scheme. Bare hosts (e.g.
 * `127.0.0.1:3000`, `localhost:3000`) would otherwise be treated as HTTPS by
 * Chromium and fail with ERR_SSL_PROTOCOL_ERROR against plain-HTTP dev servers.
 * An already-schemed URL is left unchanged. Isolated to the `open` command.
 */
export function normalizeBrowserUrl(raw: string): string {
  return URL_SCHEME_RE.test(raw) ? raw : `http://${raw}`;
}

function buildReadCommand(args: BrowserReadArgs): string[] {
  switch (args.action) {
    case "open":
      if (!args.url) throw new ToolError("open requires a url");
      return ["open", normalizeBrowserUrl(args.url)];
    case "snapshot":
      return ["snapshot"];
    case "get":
      return ["get"];
    case "screenshot":
      return ["screenshot"];
    case "extract":
      if (!args.prompt) throw new ToolError("extract requires a prompt");
      return ["extract", args.prompt];
  }
}

function buildActionCommand(args: BrowserActionArgs): string[] {
  switch (args.action) {
    case "click":
      if (!args.ref) throw new ToolError("click requires a ref");
      return ["click", args.ref];
    case "fill":
      if (!args.ref) throw new ToolError("fill requires a ref");
      if (args.text === undefined) throw new ToolError("fill requires text");
      return ["fill", args.ref, args.text];
    case "press":
      if (!args.key) throw new ToolError("press requires a key");
      return ["press", args.key];
    case "act":
      if (!args.prompt) throw new ToolError("act requires a prompt");
      return ["act", args.prompt];
  }
}

async function runAgentBrowser(subcommand: string[]): Promise<BrowserResult> {
  const action = subcommand[0] ?? "unknown";

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([AGENT_BROWSER_BIN, ...subcommand], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
  } catch {
    return {
      action,
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: MISSING_BINARY_MESSAGE,
    };
  }

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill("SIGKILL");
  }, BROWSER_TIMEOUT_MS);

  let stdout = "";
  let stderr = "";
  try {
    const stdoutStream =
      proc.stdout && typeof proc.stdout !== "number" ? proc.stdout : null;
    const stderrStream =
      proc.stderr && typeof proc.stderr !== "number" ? proc.stderr : null;
    const [out, err] = await Promise.all([
      stdoutStream ? new Response(stdoutStream).text() : Promise.resolve(""),
      stderrStream ? new Response(stderrStream).text() : Promise.resolve(""),
    ]);
    stdout = out;
    stderr = err;
  } catch {
    // Stream read failure still yields whatever the process produced.
  }

  const exitCode = await proc.exited.catch(() => (killed ? null : 1));
  clearTimeout(timer);

  const result: BrowserResult = {
    action,
    ok: !killed && exitCode === 0,
    exitCode,
    stdout: stdout.slice(0, BROWSER_MAX_OUTPUT_BYTES),
    stderr: stderr.slice(0, BROWSER_MAX_OUTPUT_BYTES),
  };

  if (action === "screenshot") {
    const match = result.stdout.match(IMAGE_PATH_RE);
    if (match?.[1]) {
      result.path = match[1];
      result.mimeType = "image/png";
    }
  }

  return result;
}

/** Read/navigation operations — executed without approval. */
export function runBrowserRead(args: BrowserReadArgs): Promise<BrowserResult> {
  return runAgentBrowser(buildReadCommand(args));
}

/** Interactive operations — gated by the server toolApproval mechanism. */
export function runBrowserAction(args: BrowserActionArgs): Promise<BrowserResult> {
  return runAgentBrowser(buildActionCommand(args));
}
