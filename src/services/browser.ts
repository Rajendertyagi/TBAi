import path from "path";
import { ToolError } from "./tools";
import type { BrowserReadArgs, BrowserActionArgs } from "../lib/validation";

/** Executable that fronts the persistent agent-browser daemon (Chromium). */
export const AGENT_BROWSER_BIN = "agent-browser";

/** Hard ceiling for a single browser command; mirrors the shell-tool timeout. */
export const BROWSER_TIMEOUT_MS = 120_000;

/** Bound on captured stdout/stderr, matching the existing tool output limit. */
export const BROWSER_MAX_OUTPUT_BYTES = 200_000;

/**
 * Bounded wait for pipe drain + process exit after a kill before settling
 * anyway. This is the settlement guarantee: the executor never awaits the
 * child unboundedly once timeout/abort has fired.
 */
export const BROWSER_SETTLE_GRACE_MS = 5_000;

/** Vendor env var that isolates daemon sockets + restore state per namespace. */
export const BROWSER_NAMESPACE_ENV = "AGENT_BROWSER_NAMESPACE";

/** Prefix for derived namespaces; the suffix is a hash of the data dir. */
export const BROWSER_NAMESPACE_PREFIX = "tbai";

/**
 * Short deterministic hash (djb2, hex) so distinct installs map to distinct
 * namespaces without embedding long paths in socket/namespace names.
 */
export function hashNamespaceSeed(seed: string): string {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Daemon namespace for browser children. An operator-set
 * `AGENT_BROWSER_NAMESPACE` always wins; otherwise it derives from the
 * install's data dir (same `DATA_DIR || ./data` rule as db/workspace), so two
 * servers (e.g. portable + workspace) never share the `default` daemon and
 * trip the "different daemon configuration" conflict.
 */
export function resolveBrowserNamespace(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[BROWSER_NAMESPACE_ENV]?.trim();
  if (explicit) return explicit;
  const dir = path.resolve(env.DATA_DIR || path.join(process.cwd(), "data"));
  return `${BROWSER_NAMESPACE_PREFIX}-${hashNamespaceSeed(dir)}`;
}

/** Child env for browser spawns: parent env plus the owned namespace. */
export function browserChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) child[key] = value;
  }
  child[BROWSER_NAMESPACE_ENV] ??= resolveBrowserNamespace(env);
  return child;
}

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

/**
 * Execution options for the browser CLI. Accepts both `abortSignal` (AI SDK
 * `ToolExecutionOptions`) and `signal` (internal callers) so neither call
 * shape can silently drop cancellation.
 */
export interface BrowserExecuteOptions {
  signal?: AbortSignal;
  abortSignal?: AbortSignal;
}

function resolveBrowserSignal(opts?: BrowserExecuteOptions): AbortSignal | undefined {
  return opts?.abortSignal ?? opts?.signal;
}

/** Sleep without a signal; used only to bound post-kill settling. */
function settleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runAgentBrowser(
  subcommand: string[],
  opts?: BrowserExecuteOptions,
): Promise<BrowserResult> {
  const action = subcommand[0] ?? "unknown";
  const signal = resolveBrowserSignal(opts);
  if (signal?.aborted) {
    throw new ToolError(`browser ${action} aborted`);
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([AGENT_BROWSER_BIN, ...subcommand], {
      stdout: "pipe",
      stderr: "pipe",
      env: browserChildEnv(),
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

  // Settlement state: exactly one of completion / timeout / abort wins.
  let timedOut = false;
  let abortFired = false;
  const readers: Array<{ cancel(): unknown }> = [];
  const killProc = (): void => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited or kill unsupported — settling below still bounds */
    }
  };
  const cancelReaders = (): void => {
    for (const reader of readers) {
      try {
        void reader.cancel();
      } catch {
        /* already closed */
      }
    }
  };

  let abortReject: (err: unknown) => void = () => {};
  const abortPromise = new Promise<never>((_, reject) => {
    abortReject = reject;
  });
  // Attach a no-op catch immediately so the abort race never surfaces as an
  // unhandled rejection when completion or timeout wins instead.
  abortPromise.catch(() => {});
  const onAbort = (): void => {
    if (abortFired) return;
    abortFired = true;
    killProc();
    cancelReaders();
    abortReject(new ToolError(`browser ${action} aborted`));
  };
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    killProc();
    cancelReaders();
  }, BROWSER_TIMEOUT_MS);

  // Pump one piped stream into `append`, returning on done/cancel/error with
  // whatever arrived so far. Never throws: a hung or cancelled pipe must not
  // become a second hung promise.
  const pump = async (
    stream: ReadableStream<Uint8Array> | null,
    append: (text: string) => void,
  ): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    try {
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          read = await reader.read();
        } catch {
          break;
        }
        if (read.done) break;
        const text = decoder.decode(read.value, { stream: true });
        if (text) append(text);
      }
      try {
        const tail = decoder.decode();
        if (tail) append(tail);
      } catch {
        /* decoder flush is best-effort */
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already closed */
      }
    }
  };

  const complete = (async (): Promise<BrowserResult> => {
    let stdout = "";
    let stderr = "";
    await Promise.all([
      pump(
        proc.stdout && typeof proc.stdout !== "number" ? proc.stdout : null,
        (t) => {
          stdout += t;
        },
      ),
      pump(
        proc.stderr && typeof proc.stderr !== "number" ? proc.stderr : null,
        (t) => {
          stderr += t;
        },
      ),
    ]);

    // Grace-bounded exit wait: after a kill the pipes may never close (the
    // CLI fronts a persistent daemon), so never await `exited` unboundedly.
    const exitCode = await Promise.race([
      proc.exited.catch(() => (timedOut || abortFired ? null : 1)),
      settleSleep(BROWSER_SETTLE_GRACE_MS).then(() => null),
    ]);

    if (timedOut) {
      const note = `browser ${action} timed out after ${BROWSER_TIMEOUT_MS}ms`;
      const result: BrowserResult = {
        action,
        ok: false,
        exitCode,
        stdout: stdout.slice(0, BROWSER_MAX_OUTPUT_BYTES),
        stderr: `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${note}`.slice(
          0,
          BROWSER_MAX_OUTPUT_BYTES,
        ),
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

    const result: BrowserResult = {
      action,
      ok: exitCode === 0,
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
  })();

  try {
    // Abort rejects (tool.error/cancelled); timeout resolves via `complete`
    // with ok:false; normal completion resolves via `complete`.
    return await Promise.race([complete, abortPromise]);
  } finally {
    clearTimeout(timer);
    try {
      signal?.removeEventListener("abort", onAbort);
    } catch {
      /* listener removal is best-effort */
    }
    // A settled race leaves the loser running briefly; its pumps already
    // tolerate cancel/close, and the grace-bounded exit wait above caps it.
    complete.catch(() => {});
  }
}

/** Read/navigation operations — executed without approval. */
export function runBrowserRead(
  args: BrowserReadArgs,
  opts?: BrowserExecuteOptions,
): Promise<BrowserResult> {
  return runAgentBrowser(buildReadCommand(args), opts);
}

/** Interactive operations — gated by the server toolApproval mechanism. */
export function runBrowserAction(
  args: BrowserActionArgs,
  opts?: BrowserExecuteOptions,
): Promise<BrowserResult> {
  return runAgentBrowser(buildActionCommand(args), opts);
}
