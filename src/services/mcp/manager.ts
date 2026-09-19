import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { Root, ElicitRequest, CreateMessageRequest, ElicitResult, Transport } from "@modelcontextprotocol/client";
import { tool, jsonSchema, generateText } from "ai";
import { db } from "../../db";
import type { SQLQueryBindings } from "bun:sqlite";
import { generateId } from "../../lib/utils";
import { logger, normalizeError } from "../../lib/logger";
import { encryptSecret, decryptSecret } from "../../services/credentials";
import { credentialStore } from "../../services/credentials";
import { getModel } from "../../services/ai";
import { instrumentedExecute } from "../../lib/tool-funnel";
import { registry } from "../../config/providers";
import type { McpServerCreate } from "../../lib/validation";
import type {
  McpServerConfig,
  McpTransport,
  McpAuthType,
  McpConnectionStatus,
  McpToolInfo,
  McpResourceInfo,
  McpPromptInfo,
  McpStatus,
  McpEvent,
  McpEventKind,
  McpTestResult,
  McpPendingElicitation,
  McpResourceReadResult,
  McpPromptGetResult,
} from "./types";

interface McpServerRow {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string | null;
  url: string | null;
  env: string | null;
  headers: string | null;
  auth_type: string;
  auth_token: string | null;
  enabled: number;
  auto_connect: number;
  notes: string | null;
  roots: string | null;
  created_at: number;
  updated_at: number;
}

interface McpConnection {
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  status: McpConnectionStatus;
  error?: string;
  serverCapabilities?: Record<string, unknown>;
  /** Negotiated protocol era as reported by the v2 SDK (e.g. "legacy"). */
  protocolEra?: string;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  events: McpEvent[];
  lastConnectedAt?: number;
  lastErrorAt?: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempts: number;
  /** A server-initiated elicitation request awaiting user input, if any. */
  pendingElicitation?: {
    elicitationId: string;
    resolve: (result: ElicitResult) => void;
    info: McpPendingElicitation;
  };
}

const MAX_EVENTS = 50;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 5000;

function jsonParseSafe<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command ?? undefined,
    args: row.args ? jsonParseSafe<string[]>(row.args, []) : undefined,
    url: row.url ?? undefined,
    env: row.env ? jsonParseSafe<Record<string, string>>(row.env, {}) : undefined,
    headers: row.headers ? jsonParseSafe<Record<string, string>>(row.headers, {}) : undefined,
    authType: (row.auth_type as McpAuthType) || "none",
    enabled: row.enabled === 1,
    autoConnect: row.auto_connect === 1,
    notes: row.notes ?? undefined,
    roots: row.roots ? jsonParseSafe<string[]>(row.roots, []) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Generic MCP client manager.
 *
 * Owns the lifecycle of every configured MCP server connection (register,
 * update, remove, enable/disable, connect, disconnect, reconnect, capability
 * discovery, status). It uses the official @modelcontextprotocol/sdk for all
 * protocol/transport handling and exposes discovered tools as AI SDK v7
 * `tool()` objects so the chat route can hand them to the model.
 *
 * This module is deliberately isolated from UI and chat code.
 */
export class McpManager {
  private static instance: McpManager;
  private connections = new Map<string, McpConnection>();
  private initialized = false;

  static getInstance(): McpManager {
    if (!McpManager.instance) {
      McpManager.instance = new McpManager();
    }
    return McpManager.instance;
  }

  /** Load persisted server configs and connect enabled, auto-connect servers. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const configs = this.loadConfigs();
    for (const cfg of configs) {
      if (cfg.enabled && cfg.autoConnect) {
        // Fire-and-forget: failures are recorded as connection errors, not thrown.
        void this.connect(cfg.id);
      }
    }
  }

  // ---- Configuration persistence ----

  loadConfigs(): McpServerConfig[] {
    const rows = db
      .query<McpServerRow, []>("SELECT * FROM mcp_servers ORDER BY created_at ASC")
      .all();
    return rows.map(rowToConfig);
  }

  getConfig(id: string): McpServerConfig | undefined {
    const row = db
      .query<McpServerRow, [string]>("SELECT * FROM mcp_servers WHERE id = ?")
      .get(id);
    return row ? rowToConfig(row) : undefined;
  }

  /** Read a row including the (decrypted) auth token. Internal use only. */
  private readRow(id: string): { row: McpServerRow; authToken?: string } | undefined {
    const row = db
      .query<McpServerRow, [string]>("SELECT * FROM mcp_servers WHERE id = ?")
      .get(id);
    if (!row) return undefined;
    let authToken: string | undefined;
    if (row.auth_token) {
      try {
        authToken = decryptSecret(row.auth_token);
      } catch {
        authToken = undefined;
      }
    }
    return { row, authToken };
  }

  private insertConfig(input: McpServerCreate): McpServerConfig {
    const id = generateId();
    const now = Date.now();
    const enabled = input.enabled ?? true;
    const autoConnect = input.autoConnect ?? true;
    const authTokenEnv = input.authToken ? encryptSecret(input.authToken) : null;
    db.run(
      `INSERT INTO mcp_servers
        (id, name, transport, command, args, url, env, headers, auth_type, auth_token, enabled, auto_connect, notes, roots, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.transport,
        input.command ?? null,
        input.args ? JSON.stringify(input.args) : null,
        input.url ?? null,
        input.env ? JSON.stringify(input.env) : null,
        input.headers ? JSON.stringify(input.headers) : null,
        input.authType ?? "none",
        authTokenEnv,
        enabled ? 1 : 0,
        autoConnect ? 1 : 0,
        input.notes ?? null,
        input.roots ? JSON.stringify(input.roots) : null,
        now,
        now,
      ],
    );
    return this.getConfig(id)!;
  }

  private updateConfigRow(id: string, input: Partial<McpServerCreate>): McpServerConfig | undefined {
    const existing = this.getConfig(id);
    if (!existing) return undefined;
    const now = Date.now();
    const sets: string[] = [];
    const values: SQLQueryBindings[] = [];
    const set = (col: string, value: SQLQueryBindings) => {
      sets.push(`${col} = ?`);
      values.push(value);
    };
    if (input.name !== undefined) set("name", input.name);
    if (input.transport !== undefined) set("transport", input.transport);
    if (input.command !== undefined) set("command", input.command ?? null);
    if (input.args !== undefined) set("args", input.args ? JSON.stringify(input.args) : null);
    if (input.url !== undefined) set("url", input.url ?? null);
    if (input.env !== undefined) set("env", input.env ? JSON.stringify(input.env) : null);
    if (input.headers !== undefined) set("headers", input.headers ? JSON.stringify(input.headers) : null);
    if (input.authType !== undefined) set("auth_type", input.authType);
    if (input.authToken !== undefined && input.authToken) {
      set("auth_token", encryptSecret(input.authToken));
    }
    if (input.roots !== undefined) set("roots", input.roots ? JSON.stringify(input.roots) : null);
    if (input.enabled !== undefined) set("enabled", input.enabled ? 1 : 0);
    if (input.autoConnect !== undefined) set("auto_connect", input.autoConnect ? 1 : 0);
    if (input.notes !== undefined) set("notes", input.notes ?? null);
    set("updated_at", now);
    db.run(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
    return this.getConfig(id);
  }

  createConfig(input: McpServerCreate): McpServerConfig {
    return this.insertConfig(input);
  }

  updateConfig(id: string, input: Partial<McpServerCreate>): McpServerConfig | undefined {
    const conn = this.connections.get(id);
    const wasConnected = conn?.status === "connected";
    const updated = this.updateConfigRow(id, input);
    if (!updated) return undefined;
    if (!updated.enabled) {
      return updated;
    }
    // Roots-only (or notes-only) edits must NOT tear down the transport: push
    // the official roots/list_changed notification on the live connection so
    // the server re-lists. Connection-affecting edits still reconnect.
    const connectionAffecting =
      input.transport !== undefined ||
      input.command !== undefined ||
      input.args !== undefined ||
      input.url !== undefined ||
      input.env !== undefined ||
      input.headers !== undefined ||
      input.authType !== undefined ||
      input.authToken !== undefined;
    if (input.roots !== undefined && !connectionAffecting) {
      if (wasConnected) {
        void this.notifyRootsChanged(id);
      } else {
        void this.connect(id);
      }
      return updated;
    }
    // Reconnect to apply connection-affecting changes if the server is enabled.
    void this.reconnect(id);
    return updated;
  }

  /**
   * Official MCP roots list-changed push (SDK v1.30: client.sendRootsListChanged
   * → notifications/roots/list_changed). Safe on disconnected servers (no-op).
   */
  async notifyRootsChanged(id: string): Promise<boolean> {
    const conn = this.connections.get(id);
    if (!conn || conn.status !== "connected") return false;
    try {
      await conn.client.sendRootsListChanged();
      this.pushEvent(id, "log", "Roots list changed notification sent");
      return true;
    } catch (err) {
      logger.error("mcp", "mcp.operation", {
        op: "roots_notify",
        outcome: "error",
        mcpServer: conn.config.name,
        transport: conn.config.transport,
        ...normalizeError(err),
      });
      return false;
    }
  }

  deleteConfig(id: string): void {
    const conn = this.connections.get(id);
    if (conn?.reconnectTimer) clearTimeout(conn.reconnectTimer);
    void this.disconnect(id);
    db.run("DELETE FROM mcp_servers WHERE id = ?", [id]);
    this.connections.delete(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    db.run("UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?", [
      enabled ? 1 : 0,
      Date.now(),
      id,
    ]);
    if (enabled) {
      void this.connect(id);
    } else {
      void this.disconnect(id);
    }
  }

  // ---- Transport construction ----

  private buildHeaders(config: McpServerConfig, authToken?: string): Record<string, string> {
    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    if (authToken && config.authType !== "none") {
      if (config.authType === "bearer" || config.authType === "oauth") {
        headers["Authorization"] = `Bearer ${authToken}`;
      } else if (config.authType === "basic") {
        headers["Authorization"] = `Basic ${Buffer.from(authToken).toString("base64")}`;
      }
    }
    return headers;
  }

  private buildTransport(config: McpServerConfig, authToken?: string): Transport {
    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error("STDIO transport requires a command");
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...process.env, ...(config.env ?? {}) },
        cwd: process.cwd(),
        stderr: "ignore",
      }) as unknown as Transport;
    }
    if (!config.url) {
      throw new Error(`${config.transport.toUpperCase()} transport requires a URL`);
    }
    const url = new URL(config.url);
    if (config.transport === "http") {
      return new StreamableHTTPClientTransport(url, {
        requestInit: { headers: this.buildHeaders(config, authToken) },
      }) as unknown as Transport;
    }
    // sse
    return new SSEClientTransport(url, {
      requestInit: { headers: this.buildHeaders(config, authToken) },
    }) as unknown as Transport;
  }

  // ---- Connection lifecycle ----

  async connect(id: string): Promise<void> {
    const loaded = this.readRow(id);
    if (!loaded) return;
    const { row, authToken } = loaded;
    const config = rowToConfig(row);

    // Tear down any prior connection for this id first.
    const prior = this.connections.get(id);
    if (prior) {
      if (prior.reconnectTimer) clearTimeout(prior.reconnectTimer);
      // Cancel any elicitation still awaiting user input on the prior client
      // so its tool-level promise settles as { action: "cancel" } instead of
      // being rejected by the SDK's "Connection closed" abort when the
      // transport closes below.
      this.cancelPendingElicitation(id);
      try {
        await prior.client.close();
      } catch {
        /* ignore */
      }
    }

    const client = new Client(
      { name: "TBAi", version: "0.1.0" },
      {
        // Official v2 era negotiation: modern 2026-07-28 servers negotiate up,
        // legacy/2025-era servers fall back — never modern-only.
        versionNegotiation: { mode: "auto" },
        capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
      },
    );

    const conn: McpConnection = {
      config,
      client,
      transport: null as unknown as Transport,
      status: "connecting",
      tools: [],
      resources: [],
      prompts: [],
      events: [],
      reconnectAttempts: prior?.reconnectAttempts ?? 0,
    };
    this.connections.set(id, conn);

    try {
      const transport = this.buildTransport(config, authToken);
      conn.transport = transport;
      this.registerNotificationHandlers(id);
      this.registerRequestHandlers(id);

      await client.connect(transport);

      conn.status = "connected";
      conn.error = undefined;
      conn.lastConnectedAt = Date.now();
      conn.reconnectAttempts = 0;
      conn.serverCapabilities = (client.getServerCapabilities() as Record<string, unknown>) ?? {};
      try {
        conn.protocolEra = client.getProtocolEra();
      } catch {
        conn.protocolEra = undefined;
      }
      this.pushEvent(id, "connected", `Connected to ${config.name} (era: ${conn.protocolEra ?? "unknown"})`);

      await this.discoverCapabilities(id);
      logger.info("mcp", "mcp.operation", {
        op: "connect",
        outcome: "ok",
        mcpServer: config.name,
        transport: config.transport,
        message: `tools=${conn.tools.length} resources=${conn.resources.length} prompts=${conn.prompts.length} era=${conn.protocolEra ?? "unknown"}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      conn.status = "error";
      conn.error = message;
      conn.lastErrorAt = Date.now();
      this.pushEvent(id, "error", `Connection failed: ${message}`);
      logger.error("mcp", "mcp.operation", {
        op: "connect",
        outcome: "error",
        mcpServer: config.name,
        transport: config.transport,
        ...normalizeError(err),
      });
      // Attempt reconnect for enabled servers (capped).
      this.scheduleReconnect(id);
    }
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = undefined;
    }
    conn.reconnectAttempts = 0;
    // Resolve any pending elicitation as cancelled so a waiting tool call
    // settles instead of hanging forever during shutdown.
    this.cancelPendingElicitation(id);
    // Mark disconnected BEFORE closing: status is the manager's single source
    // of truth, so intentional teardown can never be mistaken for an
    // unexpected loss and re-triggered into reconnect bookkeeping.
    conn.status = "disconnected";
    try {
      await conn.client.close();
    } catch {
      /* ignore */
    }
    this.pushEvent(id, "disconnected", `Disconnected from ${conn.config.name}`);
    logger.info("mcp", "mcp.operation", { op: "disconnect", outcome: "ok", mcpServer: conn.config.name });
  }

  /** Disconnect every connection; never throws (used at shutdown). */
  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
  }

  /** Resolve a pending elicitation as cancelled, if one exists. */
  private cancelPendingElicitation(id: string): void {
    const conn = this.connections.get(id);
    if (!conn?.pendingElicitation) return;
    conn.pendingElicitation.resolve({ action: "cancel" });
    conn.pendingElicitation = undefined;
  }

  async reconnect(id: string): Promise<void> {
    await this.disconnect(id);
    await this.connect(id);
  }

  async refresh(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn || conn.status !== "connected") {
      await this.connect(id);
      return;
    }
    await this.discoverCapabilities(id);
  }

  private scheduleReconnect(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    if (!conn.config.enabled) return;
    if (conn.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    conn.reconnectAttempts += 1;
    const attempt = conn.reconnectAttempts;
    conn.reconnectTimer = setTimeout(() => {
      const c = this.connections.get(id);
      if (!c || !c.config.enabled || c.status === "connected") return;
      logger.info("mcp", "mcp.operation", {
        op: "reconnect",
        outcome: "started",
        mcpServer: c.config.name,
        transport: c.config.transport,
        message: `attempt=${attempt}`,
      });
      void this.connect(id);
    }, RECONNECT_DELAY_MS);
  }

  // ---- Capability discovery ----

  private async discoverCapabilities(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    const caps = conn.serverCapabilities ?? {};
    try {
      if (caps.tools !== undefined) {
        const res = await conn.client.listTools();
        conn.tools = (res.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      }
    } catch (err) {
      this.pushEvent(id, "error", `Tool discovery failed: ${errMsg(err)}`);
    }
    try {
      if (caps.resources !== undefined) {
        const res = await conn.client.listResources();
        conn.resources = (res.resources ?? []).map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));
      }
    } catch (err) {
      this.pushEvent(id, "error", `Resource discovery failed: ${errMsg(err)}`);
    }
    try {
      if (caps.prompts !== undefined) {
        const res = await conn.client.listPrompts();
        conn.prompts = (res.prompts ?? []).map((p) => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments,
        }));
      }
    } catch (err) {
      this.pushEvent(id, "error", `Prompt discovery failed: ${errMsg(err)}`);
    }
  }

  // ---- Notifications / events ----

  private registerNotificationHandlers(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    const { client } = conn;

    client.setNotificationHandler('notifications/progress', (notification) => {
      const p = notification.params as { progress?: number; total?: number; progressToken?: unknown };
      const msg = `Progress ${p.progress ?? "?"}"${p.total ? `/${p.total}` : ""}`;
      this.pushEvent(id, "progress", msg, notification.params);
    });

    client.setNotificationHandler('notifications/tools/list_changed', () => {
      this.pushEvent(id, "tool_list_changed", "Tool list changed");
      void this.discoverCapabilities(id);
    });

    client.setNotificationHandler('notifications/resources/list_changed', () => {
      this.pushEvent(id, "resource_list_changed", "Resource list changed");
      void this.discoverCapabilities(id);
    });

    client.setNotificationHandler('notifications/prompts/list_changed', () => {
      this.pushEvent(id, "prompt_list_changed", "Prompt list changed");
      void this.discoverCapabilities(id);
    });

    client.setNotificationHandler('notifications/resources/updated', (notification) => {
      const uri = (notification.params as { uri?: string })?.uri ?? "";
      this.pushEvent(id, "resource_updated", `Resource updated: ${uri}`, notification.params);
    });

    client.setNotificationHandler('notifications/message', (notification) => {
      const params = notification.params as { level?: string; logger?: string; data?: unknown };
      const text = typeof params.data === "string" ? params.data : JSON.stringify(params.data);
      this.pushEvent(id, "log", `[${params.level ?? "info"}] ${text}`, notification.params);
    });
  }

  private pushEvent(id: string, kind: McpEventKind, message: string, data?: unknown): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    conn.events.push({ kind, message, at: Date.now(), data });
    if (conn.events.length > MAX_EVENTS) {
      conn.events = conn.events.slice(conn.events.length - MAX_EVENTS);
    }
  }

  // ---- Server → client request handlers (roots, sampling, elicitation) ----

  private registerRequestHandlers(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    const { client } = conn;

    // Roots: advertise which filesystem locations the server may access.
    client.setRequestHandler('roots/list', () => {
      const roots: Root[] = (conn.config.roots ?? []).map((uri) => ({ uri }));
      logger.debug("mcp", "mcp.operation", {
        op: "roots",
        outcome: "ok",
        mcpServer: conn.config.name,
        message: `count=${roots.length}`,
      });
      return { roots };
    });

    // Sampling: the server asks the model to generate text; route it to the active provider.
    client.setRequestHandler('sampling/createMessage', (request: CreateMessageRequest) =>
      this.handleSampling(id, request),
    );

    // Elicitation: the server asks the *user* a question mid-tool-call; surface it to the UI.
    client.setRequestHandler('elicitation/create', (request: ElicitRequest) =>
      this.handleElicitation(id, request),
    );
  }

  private async handleSampling(
    id: string,
    request: CreateMessageRequest,
  ): Promise<{ role: "assistant"; content: { type: "text"; text: string }; model: string }> {
    const provider = registry.getActive();
    if (!provider) {
      throw new Error("No active provider configured; cannot fulfill MCP sampling request");
    }
    let apiKey: string | undefined;
    if (provider.type !== "ollama") {
      try {
        apiKey = credentialStore.has(provider.id) ? credentialStore.get(provider.id) : undefined;
      } catch {
        apiKey = undefined;
      }
    }
    const model = getModel({
      type: provider.type,
      endpoint: provider.endpoint,
      model: provider.model,
      apiKey,
    });
    const params = request.params as {
      messages?: { role: "user" | "assistant"; content?: unknown }[];
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
      stopSequences?: string[];
    };
    const messages = (params.messages ?? []).map((m) => ({
      role: m.role,
      content: extractMessageText(m.content),
    }));
    const result = await generateText({
      model,
      system: params.systemPrompt,
      messages,
      maxOutputTokens: params.maxTokens,
      temperature: params.temperature,
      stopSequences: params.stopSequences,
    });
    this.pushEvent(id, "log", `Sampling request fulfilled via ${provider.name}`);
    logger.info("mcp", "mcp.operation", {
      op: "sampling",
      outcome: "ok",
      mcpServer: this.connections.get(id)?.config.name ?? id,
      provider: provider.type,
      model: provider.model,
    });
    return { role: "assistant", content: { type: "text", text: result.text }, model: provider.model };
  }

  private handleElicitation(id: string, request: ElicitRequest): Promise<ElicitResult> {
    const conn = this.connections.get(id);
    const params = request.params as {
      elicitationId?: string;
      mode?: "form" | "url";
      message?: string;
      requestedSchema?: { properties?: Record<string, Record<string, unknown>> };
      url?: string;
    };
    const elicitationId = params.elicitationId ?? `el-${Date.now()}`;
    const mode: "form" | "url" = params.mode ?? (params.url ? "url" : "form");
    const info: McpPendingElicitation = {
      serverId: id,
      serverName: conn?.config.name ?? id,
      elicitationId,
      message: params.message ?? "The server is requesting information",
      mode,
    };
    if (mode === "url") {
      info.url = params.url;
    } else {
      const props = params.requestedSchema?.properties ?? {};
      info.fields = Object.entries(props).map(([name, def]) => ({
        name,
        type: (def.type as string) ?? "string",
        title: def.title as string | undefined,
        description: def.description as string | undefined,
        enum: def.enum as string[] | undefined,
        enumNames: def.enumNames as string[] | undefined,
        default: def.default as string | undefined,
      }));
    }
    return new Promise<ElicitResult>((resolve) => {
      if (!conn) {
        resolve({ action: "cancel" });
        return;
      }
      conn.pendingElicitation = { elicitationId, resolve, info };
      this.pushEvent(id, "log", `Elicitation requested: ${info.message}`);
      logger.info("mcp", "mcp.operation", {
        op: "elicitation",
        outcome: "started",
        mcpServer: conn.config.name,
        message: `mode=${mode} fields=${info.fields?.length ?? 0}`,
      });
    });
  }

  /** Return the first server with a pending elicitation, for the UI to render. */
  getPendingElicitation(): McpPendingElicitation | undefined {
    for (const conn of this.connections.values()) {
      if (conn.pendingElicitation) return conn.pendingElicitation.info;
    }
    return undefined;
  }

  /** Resolve (answer) a pending elicitation from the UI. Returns false if not found. */
  resolveElicitation(
    serverId: string,
    elicitationId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, string | number | boolean | string[]>,
  ): boolean {
    const conn = this.connections.get(serverId);
    if (!conn?.pendingElicitation) return false;
    if (conn.pendingElicitation.elicitationId !== elicitationId) return false;
    const result: ElicitResult =
      action === "accept"
        ? { action: "accept", content: (content ?? {}) as Record<string, string | number | boolean | string[]> }
        : { action };
    conn.pendingElicitation.resolve(result);
    conn.pendingElicitation = undefined;
    logger.info("mcp", "mcp.operation", {
      op: "elicitation",
      outcome: "ok",
      mcpServer: conn.config.name,
      message: `action=${action}`,
    });
    return true;
  }

  // ---- Resource / prompt access (used by the "Insert into chat" UI) ----

  async readResource(id: string, uri: string): Promise<McpResourceReadResult> {
    const conn = this.connections.get(id);
    if (!conn || conn.status !== "connected") throw new Error("Server not connected");
    const started = Date.now();
    try {
      const res = await conn.client.readResource({ uri });
      const contents = (res.contents ?? []).map((c: { uri: string; mimeType?: string; text?: string; blob?: string }) => ({
        uri: c.uri,
        mimeType: c.mimeType,
        text: c.text,
        blob: c.blob,
      }));
      logger.debug("mcp", "mcp.operation", {
        op: "resource_read",
        outcome: "ok",
        mcpServer: conn.config.name,
        message: `uri=${uri} blocks=${contents.length}`,
        durationMs: Date.now() - started,
      });
      return { contents };
    } catch (err) {
      logger.warn("mcp", "mcp.operation", {
        op: "resource_read",
        outcome: "error",
        mcpServer: conn.config.name,
        message: `uri=${uri}`,
        durationMs: Date.now() - started,
        ...normalizeError(err),
      });
      throw err;
    }
  }

  async getPrompt(id: string, name: string, args?: Record<string, string>): Promise<McpPromptGetResult> {
    const conn = this.connections.get(id);
    if (!conn || conn.status !== "connected") throw new Error("Server not connected");
    const started = Date.now();
    try {
      const res = await conn.client.getPrompt({ name, arguments: args });
      const messages = (res.messages ?? []).map((m: { role: "user" | "assistant"; content?: unknown }) => ({
        role: m.role,
        content: { type: "text", text: extractMessageText(m.content) },
      }));
      logger.debug("mcp", "mcp.operation", {
        op: "prompt",
        outcome: "ok",
        mcpServer: conn.config.name,
        message: `name=${name}`,
        durationMs: Date.now() - started,
      });
      return { description: res.description, messages };
    } catch (err) {
      logger.warn("mcp", "mcp.operation", {
        op: "prompt",
        outcome: "error",
        mcpServer: conn.config.name,
        message: `name=${name}`,
        durationMs: Date.now() - started,
        ...normalizeError(err),
      });
      throw err;
    }
  }

  // ---- Status reporting ----

  getStatuses(): McpStatus[] {
    const configs = this.loadConfigs();
    return configs.map((config) => {
      const conn = this.connections.get(config.id);
      const tools = conn?.tools ?? [];
      const resources = conn?.resources ?? [];
      const prompts = conn?.prompts ?? [];
      return {
        id: config.id,
        name: config.name,
        transport: config.transport,
        enabled: config.enabled,
        status: conn?.status ?? "disconnected",
        error: conn?.error,
        serverCapabilities: conn?.serverCapabilities,
        protocolEra: conn?.protocolEra,
        tools,
        resources,
        prompts,
        toolCount: tools.length,
        resourceCount: resources.length,
        promptCount: prompts.length,
        lastConnectedAt: conn?.lastConnectedAt,
        lastErrorAt: conn?.lastErrorAt,
        events: conn?.events ?? [],
        command: config.command,
        args: config.args,
        url: config.url,
        env: config.env,
        headers: config.headers,
        authType: config.authType,
        autoConnect: config.autoConnect,
        notes: config.notes,
        roots: config.roots,
        pendingElicitation: conn?.pendingElicitation?.info,
      } satisfies McpStatus;
    });
  }

  // ---- AI SDK tool bridge ----

  /** Build AI SDK v7 tool() objects for every connected server's tools. */
  getAiTools(requestSignal?: AbortSignal): Record<string, any> {
    const tools: Record<string, any> = {};
    for (const conn of this.connections.values()) {
      if (conn.status !== "connected") continue;
      for (const t of conn.tools) {
        const toolName = `mcp__${conn.config.id}__${t.name}`;
        const schema = (t.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        };
        tools[toolName] = tool({
          description: `[${conn.config.name}] ${t.description ?? t.name}`,
          inputSchema: jsonSchema(schema as never),
          execute: instrumentedExecute(
            toolName,
            async (args: unknown, options?: { abortSignal?: AbortSignal }) => {
              const signal = options?.abortSignal ?? requestSignal;
              // v2 callTool(params, options?) — no result-schema argument.
              const res = await conn.client.callTool(
                { name: t.name, arguments: args as Record<string, unknown> },
                signal ? { signal, timeout: 120000 } : { timeout: 120000 },
              );
              const text = mcpContentToText(res);
              if (res?.isError) {
                throw new Error(text || "MCP tool returned an error");
              }
              return text;
            },
            { mcpServer: conn.config.name },
          ),
        });
      }
    }
    return tools;
  }

  // ---- One-off connection test (no persistence) ----

  async testConnection(input: McpServerCreate): Promise<McpTestResult> {
    const config: McpServerConfig = {
      id: "test",
      name: input.name,
      transport: input.transport,
      command: input.command ?? undefined,
      args: input.args ?? undefined,
      url: input.url ?? undefined,
      env: input.env ?? undefined,
      headers: input.headers ?? undefined,
      authType: input.authType ?? "none",
      enabled: true,
      autoConnect: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const client = new Client(
      { name: "TBAi", version: "0.1.0" },
      {
        versionNegotiation: { mode: "auto" },
        capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } },
      },
    );
    try {
      const transport = this.buildTransport(config, input.authToken ?? undefined);
      await client.connect(transport);
      const caps = (client.getServerCapabilities() as Record<string, unknown>) ?? {};
      const tools: McpToolInfo[] = [];
      const resources: McpResourceInfo[] = [];
      const prompts: McpPromptInfo[] = [];
      if (caps.tools !== undefined) {
        const res = await client.listTools();
        for (const t of res.tools ?? []) {
          tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
        }
      }
      if (caps.resources !== undefined) {
        const res = await client.listResources();
        for (const r of res.resources ?? []) {
          resources.push({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType });
        }
      }
      if (caps.prompts !== undefined) {
        const res = await client.listPrompts();
        for (const p of res.prompts ?? []) {
          prompts.push({ name: p.name, description: p.description, arguments: p.arguments });
        }
      }
      await client.close();
      return {
        ok: true,
        transport: input.transport,
        serverCapabilities: caps,
        toolCount: tools.length,
        resourceCount: resources.length,
        promptCount: prompts.length,
        tools,
        resources,
        prompts,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        transport: input.transport,
        error: message,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        tools: [],
        resources: [],
        prompts: [],
      };
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort text extraction from a v2 sampling/prompt message content block. */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const item = c as { type?: string; text?: string };
          if (item.type === "text") return item.text ?? "";
          return "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const item = content as { type?: string; text?: string };
    if (typeof item.text === "string") return item.text;
  }
  return "";
}

function mcpContentToText(res: unknown): string {
  const content = (res as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        const item = c as { type?: string; text?: string; resource?: unknown; [k: string]: unknown };
        if (item.type === "text") return item.text ?? "";
        if (item.type === "resource") return JSON.stringify(item.resource ?? item);
        return JSON.stringify(item);
      })
      .join("\n");
  }
  if (res && typeof res === "object") return JSON.stringify(res);
  return String(res ?? "");
}

export const mcpManager = McpManager.getInstance();
