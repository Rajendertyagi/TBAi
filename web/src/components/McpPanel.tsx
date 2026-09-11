import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Button, Input, Textarea } from "./ui";
import { useMcpStore } from "../stores/mcpStore";
import { useChatTabsStore, urlForTab } from "../features/chat/state/chatTabs";
import { cn } from "../lib/utils";
import { SettingsError, SettingsSection } from "./shared/settings";
import type {
  McpConnectionStatus,
  McpServerDraft,
  McpStatus,
  McpTransport,
  McpAuthType,
  McpPrompt,
  McpPromptGetResult,
} from "../types";
import {
  Plus,
  Trash2,
  Pencil,
  X,
  Check,
  Plug,
  RefreshCw,
  Play,
  Square,
  AlertCircle,
  Wrench,
  FileText,
  MessageSquare,
} from "lucide-react";

// Parse "KEY=VALUE" lines into an object (blank lines ignored).
function parseKV(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// Parse non-empty lines into a string array (used for STDIO args).
function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function formatKV(obj?: Record<string, string>): string {
  if (!obj) return "";
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

interface DraftState {
  id: string | null;
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  envText: string;
  headersText: string;
  authType: McpAuthType;
  authToken: string;
  rootsText: string;
  enabled: boolean;
  autoConnect: boolean;
  notes: string;
}

function emptyDraft(): DraftState {
  return {
    id: null,
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    url: "",
    envText: "",
    headersText: "",
    authType: "none",
    authToken: "",
    rootsText: "",
    enabled: true,
    autoConnect: true,
    notes: "",
  };
}

const STATUS_STYLES: Record<McpConnectionStatus, string> = {
  connected: "bg-success/15 text-success",
  connecting: "bg-warning/15 text-warning",
  error: "bg-destructive/15 text-destructive",
  disconnected: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: McpConnectionStatus }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium capitalize", STATUS_STYLES[status])}>
      {status}
    </span>
  );
}

export function McpPanel() {
  const { servers, loadServers, createServer, updateServer, deleteServer, setEnabled, connect, disconnect, refresh, test } =
    useMcpStore();
  const [isAdding, setIsAdding] = useState(false);
  const [draft, setDraft] = useState<DraftState>(emptyDraft());
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Load once and poll for live status while the panel is open.
  useEffect(() => {
    void loadServers();
    const t = setInterval(() => void loadServers(), 3000);
    return () => clearInterval(t);
  }, [loadServers]);

  const set = (patch: Partial<DraftState>) => setDraft((d) => ({ ...d, ...patch }));

  const startAdd = () => {
    setFormError(null);
    setTestResult(null);
    setDraft(emptyDraft());
    setIsAdding(true);
  };

  const startEdit = (s: McpStatus) => {
    setFormError(null);
    setTestResult(null);
    setDraft({
      id: s.id,
      name: s.name,
      transport: s.transport,
      command: s.command ?? "",
      argsText: s.args ? s.args.join("\n") : "",
      url: s.url ?? "",
      envText: formatKV(s.env),
      headersText: formatKV(s.headers),
      authType: s.authType ?? "none",
      authToken: "",
      rootsText: s.roots ? s.roots.join("\n") : "",
      enabled: s.enabled,
      autoConnect: s.autoConnect ?? true,
      notes: s.notes ?? "",
    });
    setIsAdding(true);
  };

  const cancel = () => {
    setIsAdding(false);
    setDraft(emptyDraft());
    setTestResult(null);
    setFormError(null);
  };

  const buildPayload = (): McpServerDraft => {
    const isStdio = draft.transport === "stdio";
    const payload: McpServerDraft = {
      name: draft.name.trim(),
      transport: draft.transport,
      authType: isStdio ? "none" : draft.authType,
      enabled: draft.enabled,
      autoConnect: draft.autoConnect,
      notes: draft.notes.trim() || undefined,
    };
    if (isStdio) {
      payload.command = draft.command.trim() || undefined;
      const args = parseLines(draft.argsText);
      if (args.length) payload.args = args;
      const env = parseKV(draft.envText);
      if (Object.keys(env).length) payload.env = env;
    } else {
      payload.url = draft.url.trim() || undefined;
      payload.authType = draft.authType;
      if (draft.authToken.trim()) payload.authToken = draft.authToken.trim();
      const headers = parseKV(draft.headersText);
      if (Object.keys(headers).length) payload.headers = headers;
    }
    const roots = parseLines(draft.rootsText);
    if (roots.length) payload.roots = roots;
    return payload;
  };

  const runTest = async () => {
    setFormError(null);
    setTestResult(null);
    if (!draft.name.trim()) {
      setFormError("Enter a server name first");
      return;
    }
    if (draft.transport === "stdio" && !draft.command.trim()) {
      setFormError("STDIO transport requires a command");
      return;
    }
    if (draft.transport !== "stdio" && !draft.url.trim()) {
      setFormError("HTTP/SSE transport requires a URL");
      return;
    }
    setTesting(true);
    try {
      const res = await test(buildPayload());
      if (res.ok) {
        setTestResult({
          ok: true,
          message: `Connection successful — ${res.toolCount} tool(s), ${res.resourceCount} resource(s), ${res.promptCount} prompt(s)`,
        });
      } else {
        setTestResult({ ok: false, message: res.error || "Connection failed" });
      }
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setFormError(null);
    const payload = buildPayload();
    if (!payload.name) {
      setFormError("Enter a server name");
      return;
    }
    setSaving(true);
    try {
      if (draft.id) {
        await updateServer(draft.id, payload);
      } else {
        await createServer(payload);
      }
      cancel();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this MCP server configuration?")) return;
    await deleteServer(id);
  };

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const isStdio = draft.transport === "stdio";

  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <Plug className="h-5 w-5" /> MCP Servers
        </h1>
        <p className="text-xs leading-5 text-muted-foreground">
          Connect TBAi to any Model Context Protocol server (tools, resources, prompts).
        </p>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={startAdd}>
          <Plus className="w-3 h-3 mr-1" />
          Add server
        </Button>
      </div>

      {(isAdding || draft.id !== null) && (
        <SettingsSection title={draft.id ? "Edit server" : "Add server"}>
        <div className="space-y-3">
          <Input
            placeholder="Server name (e.g. Desktop Commander)"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-20 shrink-0">Transport</span>
            <select
              value={draft.transport}
              onChange={(e) => set({ transport: e.target.value as McpTransport })}
              className="flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
            >
              <option value="stdio">STDIO (local process)</option>
              <option value="http">Streamable HTTP</option>
              <option value="sse">SSE (legacy)</option>
            </select>
          </div>

          {isStdio ? (
            <>
              <Input
                placeholder="Command (e.g. npx, bun, node)"
                value={draft.command}
                onChange={(e) => set({ command: e.target.value })}
              />
              <Textarea
                placeholder={"Arguments, one per line\n-y\n@wonderwhy-er/desktop-commander@latest"}
                value={draft.argsText}
                onChange={(e) => set({ argsText: e.target.value })}
              />
              <Textarea
                placeholder={"Environment variables (KEY=VALUE), one per line"}
                value={draft.envText}
                onChange={(e) => set({ envText: e.target.value })}
              />
            </>
          ) : (
            <>
              <Input
                placeholder="Server URL (https://...)"
                value={draft.url}
                onChange={(e) => set({ url: e.target.value })}
              />
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-20 shrink-0">Auth</span>
                <select
                  value={draft.authType}
                  onChange={(e) => set({ authType: e.target.value as McpAuthType })}
                  className="rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                >
                  <option value="none">None</option>
                  <option value="bearer">Bearer token</option>
                  <option value="basic">Basic (user:pass)</option>
                  <option value="oauth">OAuth</option>
                </select>
              </div>
              {draft.authType !== "none" && (
                <Input
                  type="password"
                  placeholder="Auth token / credentials"
                  value={draft.authToken}
                  onChange={(e) => set({ authToken: e.target.value })}
                />
              )}
              <Textarea
                placeholder={"Extra headers (KEY=VALUE), one per line"}
                value={draft.headersText}
                onChange={(e) => set({ headersText: e.target.value })}
              />
            </>
          )}

          <Textarea
            placeholder="Notes (optional)"
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />

          <Textarea
            placeholder={"Roots (optional) — file locations the server may access, one URI per line\nfile:///C:/Users/you"}
            value={draft.rootsText}
            onChange={(e) => set({ rootsText: e.target.value })}
          />

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={draft.autoConnect}
                onChange={(e) => set({ autoConnect: e.target.checked })}
              />
              Auto-connect on startup
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              <Check className="w-3 h-3 mr-1" />
              {draft.id ? "Update" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={runTest} disabled={testing}>
              {testing ? "Testing…" : "Test connection"}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              <X className="w-3 h-3 mr-1" />
              Cancel
            </Button>
          </div>

          {formError && <SettingsError>{formError}</SettingsError>}
          {testResult && (
            <p className={testResult.ok ? "text-xs text-success" : "text-xs text-destructive"}>
              {testResult.message}
            </p>
          )}
        </div>
        </SettingsSection>
      )}

      <SettingsSection
        title="Configured servers"
        icon={Plug}
        description={servers.length === 0 ? undefined : `${servers.length} configured`}
      >
      <div className="space-y-2">
        {servers.length === 0 && !isAdding && (
          <p className="text-xs text-muted-foreground">
            No MCP servers configured yet. Click “Add server” to connect one.
          </p>
        )}
        {servers.map((s) => (
          <ServerCard
            key={s.id}
            server={s}
            expanded={expanded.has(s.id)}
            onToggleExpand={() => toggleExpand(s.id)}
            onEdit={() => startEdit(s)}
            onDelete={() => remove(s.id)}
            onSetEnabled={(enabled) => setEnabled(s.id, enabled)}
            onConnect={() => connect(s.id)}
            onDisconnect={() => disconnect(s.id)}
            onRefresh={() => refresh(s.id)}
          />
        ))}
      </div>
      </SettingsSection>
    </div>
  );
}

function ServerCard({
  server,
  expanded,
  onToggleExpand,
  onEdit,
  onDelete,
  onSetEnabled,
  onConnect,
  onDisconnect,
  onRefresh,
}: {
  server: McpStatus;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
}) {
  const isConnected = server.status === "connected";
  return (
    <div
      className={cn(
        "rounded-md border p-3",
        server.status === "error" ? "border-destructive/40" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{server.name}</span>
            <StatusBadge status={server.status} />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
              {server.transport}
            </span>
            {server.enabled ? (
              <span className="text-[10px] text-success">enabled</span>
            ) : (
              <span className="text-[10px] text-muted-foreground">disabled</span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {server.toolCount} tool(s) · {server.resourceCount} resource(s) · {server.promptCount} prompt(s)
          </div>
          {server.status === "error" && server.error && (
            <div className="mt-1 flex items-start gap-1 text-xs text-destructive">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{server.error}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="ghost" onClick={onToggleExpand} title="Show capabilities">
            {expanded ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={onRefresh} title="Refresh capabilities">
            <RefreshCw className="w-3 h-3" />
          </Button>
          {isConnected ? (
            <Button size="sm" variant="ghost" onClick={onDisconnect} title="Disconnect">
              <Plug className="w-3 h-3" />
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onConnect} title="Connect">
              <Plug className="w-3 h-3" />
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onEdit} title="Edit">
            <Pencil className="w-3 h-3" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} title="Delete">
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5 text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={server.enabled}
            onChange={(e) => onSetEnabled(e.target.checked)}
          />
          Enabled
        </label>
      </div>

       {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <CapabilitySection
            icon={<Wrench className="w-3 h-3" />}
            title="Tools"
            items={server.tools.map((t) => ({ name: t.name, description: t.description }))}
          />
          <ResourceSection server={server} />
          <PromptSection server={server} />
          {server.events.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Recent events</div>
              <div className="space-y-0.5 max-h-40 overflow-y-auto">
                {[...server.events].reverse().map((ev, i) => (
                  <div key={i} className="text-xs text-muted-foreground flex gap-2">
                    <span className="text-[10px] uppercase text-border shrink-0 w-24 truncate">
                      {ev.kind}
                    </span>
                    <span className="truncate">{ev.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CapabilitySection({
  icon,
  title,
  items,
}: {
  icon: ReactNode;
  title: string;
  items: { name: string; description?: string }[];
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
        {icon}
        {title} ({items.length})
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">None discovered</p>
      ) : (
        <div className="space-y-0.5 max-h-44 overflow-y-auto">
          {items.map((it) => (
            <div key={it.name} className="text-xs">
              <span className="font-mono text-foreground">{it.name}</span>
              {it.description && (
                <span className="text-muted-foreground"> — {it.description}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Resources discovered on a server. Each resource can be read and its text inserted
 * into the chat composer so the model can use it as context.
 */
/** After inserting into the composer, return to the active chat tab. */
function useGoToChat() {
  const navigate = useNavigate();
  return () => {
    const state = useChatTabsStore.getState();
    const tab = [...state.tabs].reverse().find((t) => t.kind === "chat");
    navigate(tab ? urlForTab(tab) : "/chat/new");
  };
}

function ResourceSection({ server }: { server: McpStatus }) {
  const { readResource, setPendingInsert } = useMcpStore();
  const goToChat = useGoToChat();
  const [busyUri, setBusyUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const insert = async (uri: string) => {
    setError(null);
    setBusyUri(uri);
    try {
      const res = await readResource(server.id, uri);
      const text = res.contents
        .map((c) => c.text ?? (c.blob ? `[binary content: ${c.mimeType ?? "unknown"}]` : ""))
        .filter(Boolean)
        .join("\n\n");
      if (!text) {
        setError("Resource has no readable text content");
        return;
      }
      setPendingInsert(`[Resource ${uri}]\n\n${text}`);
      goToChat();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read resource");
    } finally {
      setBusyUri(null);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
        <FileText className="w-3 h-3" />
        Resources ({server.resources.length})
      </div>
      {server.resources.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">None discovered</p>
      ) : (
        <div className="space-y-1 max-h-44 overflow-y-auto">
          {server.resources.map((r) => (
            <div key={r.uri} className="flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="font-mono truncate">{r.name || r.uri}</div>
                {r.description && <div className="text-muted-foreground truncate">{r.description}</div>}
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busyUri === r.uri}
                onClick={() => insert(r.uri)}
                title="Insert resource text into the chat"
              >
                {busyUri === r.uri ? "…" : "Insert"}
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
    </div>
  );
}

/**
 * Prompts discovered on a server. A prompt may declare arguments; when it does, the
 * user fills them in and the resolved prompt text is inserted into the chat composer.
 */
function PromptSection({ server }: { server: McpStatus }) {
  const { getPrompt, setPendingInsert } = useMcpStore();
  const goToChat = useGoToChat();
  const [openName, setOpenName] = useState<string | null>(null);

  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
        <MessageSquare className="w-3 h-3" />
        Prompts ({server.prompts.length})
      </div>
      {server.prompts.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">None discovered</p>
      ) : (
        <div className="space-y-1 max-h-44 overflow-y-auto">
          {server.prompts.map((p) => (
            <PromptRow
              key={p.name}
              serverId={server.id}
              prompt={p}
              open={openName === p.name}
              onToggle={() => setOpenName(openName === p.name ? null : p.name)}
              onInsert={(text) => {
                setPendingInsert(text);
                goToChat();
              }}
              getPrompt={getPrompt}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PromptRow({
  serverId,
  prompt,
  open,
  onToggle,
  onInsert,
  getPrompt,
}: {
  serverId: string;
  prompt: McpPrompt;
  open: boolean;
  onToggle: () => void;
  onInsert: (text: string) => void;
  getPrompt: (id: string, name: string, args?: Record<string, string>) => Promise<McpPromptGetResult>;
}) {
  const args = (prompt.arguments as { name: string; description?: string; required?: boolean }[]) ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usePrompt = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await getPrompt(serverId, prompt.name, args.length ? values : undefined);
      const text = res.messages.map((m) => m.content.text ?? "").filter(Boolean).join("\n\n");
      if (!text) {
        setError("Prompt returned no text");
        return;
      }
      onInsert(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to get prompt");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="text-xs border border-border rounded p-1.5">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="font-mono text-left truncate flex-1"
          title={prompt.description}
        >
          {prompt.name}
        </button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={usePrompt}>
          {busy ? "…" : "Use"}
        </Button>
      </div>
      {prompt.description && <div className="text-muted-foreground truncate">{prompt.description}</div>}
      {open && args.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {args.map((a) => (
            <div key={a.name} className="flex flex-col gap-0.5">
              <label className="text-[10px] text-muted-foreground">
                {a.name}
                {a.required ? " *" : ""}
                {a.description ? ` — ${a.description}` : ""}
              </label>
              <Input
                value={values[a.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))}
                className="h-7 text-xs"
              />
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
    </div>
  );
}
