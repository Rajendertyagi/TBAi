import { Client } from "@modelcontextprotocol/client";
import type {
  Root,
  ElicitRequest,
  CreateMessageRequest,
  ElicitResult,
  Transport,
} from "@modelcontextprotocol/client";
import { tool, jsonSchema, generateText } from "ai";
import type { JSONSchema7 } from "json-schema";
import { db } from "../../db";
import { logger, normalizeError } from "../../lib/logger";
import { classifyError } from "../../lib/errors";
import { classifySseFailure, safeEndpointMeta } from "./classify";
import type { SseProbeOutcome } from "./classify";
import {
  getConfig as getStoredConfig,
  insertConfig as insertStoredConfig,
  loadConfigs as loadStoredConfigs,
  readRow as readStoredRow,
  rowToConfig as storedRowToConfig,
  updateConfigRow as updateStoredConfigRow,
} from "./store";
import {
  authHintFor,
  buildHeaders,
  buildTransport,
  classifyLocation,
  errMsg,
  probeSseEndpoint,
  sseFailureMessage,
} from "./transport";
import { extractMessageText, mcpContentToText } from "./tool-content";
import { credentialStore } from "../../services/credentials";
import { getModel } from "../../services/ai";
import { instrumentedExecute } from "../../lib/tool-funnel";
import { registry } from "../../config/providers";
import type { McpServerCreate } from "../../lib/validation";
import type {
  McpServerConfig,
  McpConnectionStatus,
  McpFailureReason,
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

interface McpConnection {
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  status: McpConnectionStatus;
  error?: string;
  /** Machine-readable failure reason, set on error|auth_failed. */
  failureReason?: McpFailureReason;
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
/** Read-only SSE probe budget: 3s, diagnostics only, never the transport. */
const _SSE_PROBE_TIMEOUT_MS = 3000;

/**
 * Report the installed MCP SDK version at runtime.
 *
 * Reads from package.json rather than hardcoding, so the log cannot silently
 * drift when the dependency is upgraded.
 */
export function getMcpSdkVersion(): string {
  try {
    const pkg = require("@modelcontextprotocol/core/package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * True when an update changes a field the live transport was built from.
 *
 * Presence is not change. The settings form re-sends the whole draft on every
 * save, so a tool-filter toggle arrives alongside an unchanged `command`; only
 * a value that actually differs may force a reconnect. `authToken` is the
 * exception: the stored token is never read back, so any supplied token — a
 * replacement string, or the `""` that clears it — counts as a change.
 */
function connectionFieldsChanged(
  before: McpServerConfig | undefined,
  input: Partial<McpServerCreate>,
): boolean {
  if (!before) return true;
  const sameJson = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (
    (input.transport !== undefined && input.transport !== before.transport) ||
    (input.command !== undefined && (input.command ?? undefined) !== before.command) ||
    (input.args !== undefined && !sameJson(input.args, before.args)) ||
    (input.url !== undefined && (input.url ?? undefined) !== before.url) ||
    (input.env !== undefined && !sameJson(input.env, before.env)) ||
    (input.headers !== undefined && !sameJson(input.headers, before.headers)) ||
    (input.authType !== undefined && input.authType !== before.authType) ||
    (input.authToken !== undefined && input.authToken !== null)
  );
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
  /**
   * Per-server lifecycle generation; see {@link nextGeneration}.
   *
   * An attempt captures the generation when it starts and must still hold it in
   * order to register or to touch shared state. Every invalidating operation
   * advances it, so "was this attempt invalidated before it got its turn?"
   * becomes a fact the attempt can actually observe.
   */
  private lifecycleGen = new Map<string, number>();
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
    logger.info("mcp", "mcp.sdk_version", { version: getMcpSdkVersion() });
    const configs = this.loadConfigs();
    for (const cfg of configs) {
      if (cfg.enabled && cfg.autoConnect) {
        // Fire-and-forget: failures are recorded as connection errors, not thrown.
        void this.connect(cfg.id);
      }
    }
  }

  // ---- Configuration persistence ----
  // Thin delegates: the SQL lives in `store.ts`, but these remain public
  // methods because callers outside this module use them.

  loadConfigs(): McpServerConfig[] {
    return loadStoredConfigs();
  }

  getConfig(id: string): McpServerConfig | undefined {
    return getStoredConfig(id);
  }

  /** Read a row including the (decrypted) auth token. Internal use only. */

  createConfig(input: McpServerCreate): McpServerConfig {
    return insertStoredConfig(input);
  }

  updateConfig(id: string, input: Partial<McpServerCreate>): McpServerConfig | undefined {
    const conn = this.connections.get(id);
    const wasConnected = conn?.status === "connected";
    const before = this.getConfig(id);
    const updated = updateStoredConfigRow(id, input);
    if (!updated) return undefined;
    if (!updated.enabled) {
      return updated;
    }
    // Only a connection-affecting field that actually CHANGED forces a
    // reconnect. The settings form re-sends the whole draft on every save, so
    // "present" is not "changed": a tool-filter toggle arrives alongside an
    // unchanged `command`, and reconnecting for it would tear down a healthy
    // transport for nothing.
    if (connectionFieldsChanged(before, input)) {
      void this.reconnect(id);
      return updated;
    }
    // Non-connection-affecting edits (disabledTools, roots, notes, name) apply
    // to the live connection in place. `getAiTools()` reads
    // `conn.config.disabledTools` on every call, so a filter change takes effect
    // immediately, with no reconnect.
    if (conn) conn.config = updated;
    // Roots-only edits additionally push the official roots/list_changed
    // notification on the live connection so the server re-lists.
    if (input.roots !== undefined) {
      if (wasConnected) {
        void this.notifyRootsChanged(id);
      } else {
        void this.connect(id);
      }
    }
    return updated;
  }

  /**
   * Official MCP roots list-changed push (SDK v1.30: client.sendRootsListChanged
   * → notifications/roots/list_changed). Safe on disconnected servers (no-op).
   */
  async notifyRootsChanged(id: string): Promise<boolean> {
    const conn = this.connections.get(id);
    if (conn?.status !== "connected") return false;
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
    // Synchronous invalidation, before the row goes away: an attempt parked on
    // an await must not be able to re-register a server that no longer exists.
    this.invalidate(id);
    const conn = this.connections.get(id);
    if (conn?.reconnectTimer) clearTimeout(conn.reconnectTimer);
    void this.disconnect(id);
    db.run("DELETE FROM mcp_servers WHERE id = ?", [id]);
    this.connections.delete(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    // Turning a server OFF is an invalidation for the same reason a disconnect
    // is: a replacement attempt already in flight must not bring it back.
    if (!enabled) this.invalidate(id);
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

  // ---- Connection lifecycle ----

  async connect(id: string): Promise<void> {
    const loaded = readStoredRow(id);
    if (!loaded) return;
    // Named only for the abandon report below. The connection this attempt ends up
    // building is configured from a FRESH row read after the teardown await, so
    // nothing here may be carried forward from this snapshot.
    const config = storedRowToConfig(loaded.row);

    // Claim a lifecycle generation BEFORE the first await, so ownership is
    // decided by when this attempt STARTED rather than by when it happens to
    // register. Everything below - disconnect, delete, disable, or a newer
    // connect - advances the generation, and an attempt that still holds its own
    // is the only one allowed to register or to write shared state.
    const gen = this.nextGeneration(id);

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

    // The registration gate. `connections.set` used to run unconditionally here,
    // so a disconnect, a delete or a disable landing during the close above was
    // silently undone: the attempt registered a fresh connection anyway, built
    // from the config it read BEFORE that close.
    //
    // Two things are established here. First, that this attempt still owns the
    // lifecycle - the check that a generation bump makes possible. Second, that
    // it is registering from the CURRENT row, not a pre-close snapshot: an
    // attempt must never resurrect a server that has since been disabled, or
    // bring back one that has been deleted.
    const current = readStoredRow(id);
    if (!current || !this.ownsLifecycle(id, gen)) {
      this.reportAbandoned(config, current ? "superseded-before-registration" : "config-deleted");
      return;
    }
    const liveConfig = storedRowToConfig(current.row);
    if (!liveConfig.enabled) {
      this.reportAbandoned(liveConfig, "disabled-before-registration");
      return;
    }
    const liveAuthToken = current.authToken;

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
      config: liveConfig,
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
      // SSE-only diagnostic probe: a short read-only GET against the endpoint
      // classifies unreachable / auth / non-SSE responses BEFORE the SDK opens
      // its EventSource. The probe is diagnostic, never the transport itself.
      if (liveConfig.transport === "sse" && liveConfig.url) {
        const probe = await probeSseEndpoint(
          liveConfig.url,
          buildHeaders(liveConfig, liveAuthToken),
        );
        // First await boundary. `disconnect()` may have run while the probe was
        // open, and a newer connect() may have taken the id.
        if (!this.ownsAttempt(id, conn, gen)) {
          await this.abandonAttempt(conn, "superseded-during-sse-probe");
          return;
        }
        const reason = classifySseFailure(probe, undefined, liveAuthToken !== undefined);
        if (
          probe.kind === "unreachable" ||
          probe.kind === "timeout" ||
          reason === "auth_required" ||
          reason === "auth_failed" ||
          reason === "incompatible_response"
        ) {
          this.failConnect(id, conn, liveConfig, probe, reason);
          return;
        }
      }
      const transport = buildTransport(liveConfig, liveAuthToken);
      conn.transport = transport;
      // F3: Handle unexpected transport/session loss. The `onclose` callback
      // fires when the transport closes for any reason (server-initiated session
      // drop, network failure, etc.). We must not leave the manager reporting a
      // healthy connection indefinitely.
      //
      // The handler checks `ownsConnection` to distinguish intentional closes
      // (disconnect, delete, disable, replacement) from unexpected ones. Only
      // unexpected closes trigger a reconnect.
      transport.onclose = () => {
        if (!this.ownsConnection(id, conn, gen)) return;
        if (conn.status !== "connected" && conn.status !== "connecting") return;
        const msg = "Transport closed unexpectedly";
        conn.status = "error";
        conn.error = msg;
        conn.lastErrorAt = Date.now();
        this.pushEvent(id, "error", msg);
        logger.warn("mcp", "mcp.operation", {
          op: "connect",
          outcome: "error",
          mcpServer: liveConfig.name,
          transport: liveConfig.transport,
          message: msg,
        });
        this.scheduleReconnect(id);
      };
      this.registerNotificationHandlers(id);
      this.registerRequestHandlers(id);

      await client.connect(transport);

      // Second await boundary, and the one that produced the reported
      // resurrection: `disconnect()` closes the client underneath this attempt,
      // and for a stdio child the process can still finish starting afterwards,
      // so `client.connect()` resolves on a transport that is already closed.
      if (!this.ownsAttempt(id, conn, gen)) {
        await this.abandonAttempt(conn, "superseded-during-connect");
        return;
      }

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
      this.pushEvent(
        id,
        "connected",
        `Connected to ${liveConfig.name} (era: ${conn.protocolEra ?? "unknown"})`,
      );

      await this.discoverCapabilities(id, conn, gen);
      // Terminal success. Re-checked because discovery is an await boundary: a
      // disconnect or a replacement landing inside it means this attempt no
      // longer describes anything live, and reporting success for it would be
      // the same resurrection one level further down.
      if (!this.ownsConnection(id, conn, gen)) {
        await this.abandonAttempt(conn, "superseded-during-discovery");
        return;
      }
      logger.info("mcp", "mcp.operation", {
        op: "connect",
        outcome: "ok",
        mcpServer: liveConfig.name,
        transport: liveConfig.transport,
        message: `tools=${conn.tools.length} resources=${conn.resources.length} prompts=${conn.prompts.length} era=${conn.protocolEra ?? "unknown"}`,
      });
    } catch (err) {
      // A rejection here is not always a server problem. `disconnect()` closes
      // this very client, which is the most common cause of a failure at these
      // boundaries, and `scheduleReconnect()` below would then undo the caller's
      // explicit teardown. An attempt that no longer owns the id reports
      // nothing and reconnects to nothing.
      if (!this.ownsAttempt(id, conn, gen)) {
        await this.abandonAttempt(conn, "superseded-during-connect");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // SSE endpoints get a post-hoc classification too: the probe was
      // inconclusive, so map the SDK error shape onto a failure reason.
      // Other transports stay on the coarse error status.
      if (liveConfig.transport === "sse" && liveConfig.url) {
        const reason = classifySseFailure({ kind: "error" }, err, liveAuthToken !== undefined);
        const probe: SseProbeOutcome = { kind: "error" };
        if (reason === "auth_failed") {
          this.failConnect(id, conn, liveConfig, probe, reason, message);
          return;
        }
        if (reason === "timeout") {
          this.failConnect(id, conn, liveConfig, probe, reason, message);
          return;
        }
      }
      conn.status = "error";
      conn.error = message;
      conn.failureReason = undefined;
      conn.lastErrorAt = Date.now();
      this.pushEvent(id, "error", `Connection failed: ${message}`);
      logger.error("mcp", "mcp.operation", {
        op: "connect",
        outcome: "error",
        mcpServer: liveConfig.name,
        transport: liveConfig.transport,
        category: classifyError(err).category,
        ...normalizeError(err),
      });
      // Attempt reconnect for enabled servers (capped).
      this.scheduleReconnect(id);
    }
  }

  /**
   * Short read-only GET probe of an SSE endpoint. Reads status + content-type
   * only, consumes and discards the body, never streams. Same auth headers as
   * the real connection. Timeout: 3s. Never logs headers or the URL query.
   */

  /**
   * Record a classified SSE connection failure: truthful status
   * (error vs auth_failed), machine failureReason, diagnostic event, and a
   * log line with safe endpoint metadata. Reconnect policy unchanged (capped).
   */
  private failConnect(
    id: string,
    conn: McpConnection,
    config: McpServerConfig,
    probe: SseProbeOutcome,
    reason: McpFailureReason,
    detail?: string,
  ): void {
    const meta = config.url ? safeEndpointMeta(config.url) : { host: "", port: "", path: "" };
    const probeDetail =
      probe.kind === "ok"
        ? `status=${probe.status} content-type=${probe.contentType ?? "none"}`
        : `probe=${probe.kind}`;
    const message = sseFailureMessage(reason, meta, detail);
    const authFailure = reason === "auth_required" || reason === "auth_failed";
    conn.status = authFailure ? "auth_failed" : "error";
    conn.error = message;
    conn.failureReason = reason;
    conn.lastErrorAt = Date.now();
    this.pushEvent(id, "error", message);
    logger.error("mcp", "mcp.operation", {
      op: "connect",
      outcome: authFailure ? "auth_failed" : "error",
      mcpServer: config.name,
      transport: config.transport,
      failureReason: reason,
      host: meta.host,
      port: meta.port,
      path: meta.path,
      message: probeDetail,
    });
    // Attempt reconnect for enabled servers (capped, unchanged policy).
    this.scheduleReconnect(id);
  }

  /**
   * Allocate the next attempt number for `id`.
   *
   * Monotonic, and advanced SYNCHRONOUSLY by every invalidating operation, so
   * that "was I invalidated before I got my turn?" is a question an attempt can
   * answer rather than one it has to infer from state that has not been written
   * yet.
   *
   * Advancing it is deliberately NOT the same as closing anything. `disconnect()`
   * marks and closes asynchronously; the generation bump happens before its
   * first `await`, so an attempt parked on an await cannot slip a registration
   * in between the intent to tear down and the teardown finishing.
   */
  private nextGeneration(id: string): number {
    const gen = (this.lifecycleGen.get(id) ?? 0) + 1;
    this.lifecycleGen.set(id, gen);
    return gen;
  }

  /**
   * Invalidate every in-flight attempt for `id`.
   *
   * Called from `disconnect()`, `deleteConfig()` and a disable, each BEFORE its
   * first `await`. That ordering is the fix: an attempt between registering and
   * opening its transport has no connection object yet, so the only way to tell
   * it the world moved on is a counter it captured before it started.
   */
  private invalidate(id: string): void {
    this.nextGeneration(id);
  }

  /** Whether `gen` is still the live generation for `id`. */
  private ownsLifecycle(id: string, gen: number): boolean {
    return this.lifecycleGen.get(id) === gen;
  }

  /**
   * Whether `conn` is still the registered connection for `id`, under a
   * generation this attempt still holds.
   *
   * Deliberately does NOT consult status. Once `connect()` has promoted an entry
   * to `"connected"` it runs capability discovery, and a check that required
   * `"connecting"` would be false there by construction - which is exactly the
   * window discovery runs in. Identity plus generation is what still holds.
   */
  private ownsConnection(id: string, conn: McpConnection, gen: number): boolean {
    return this.connections.get(id) === conn && this.ownsLifecycle(id, gen);
  }

  /**
   * Whether this connect attempt still owns `id` and may write shared state.
   *
   * Three independent ways to lose ownership, all of which used to be invisible:
   *
   *  - a NEWER `connect()` replaced the entry (identity);
   *  - `disconnect()`, a delete or a disable landed while this attempt sat on an
   *    await, including the one BEFORE it registered (generation);
   *  - the entry it was tearing down was deliberately disconnected underneath it
   *    (status).
   *
   * The status half is not redundant with the identity half, and it is the half
   * that stops the reported resurrection: after `disconnect()` a single in-flight
   * attempt is STILL the registered entry, so identity alone would wave it
   * straight through.
   */
  private ownsAttempt(id: string, conn: McpConnection, gen: number): boolean {
    return this.ownsConnection(id, conn, gen) && conn.status === "connecting";
  }

  /**
   * Report that an attempt gave up without touching shared state.
   *
   * An abandoned attempt writes no status and pushes no event, so without this
   * line there is no trace that one ever existed.
   */
  private reportAbandoned(config: McpServerConfig, why: string): void {
    logger.info("mcp", "mcp.operation", {
      op: "connect",
      outcome: "abandoned",
      mcpServer: config.name,
      transport: config.transport,
      message: why,
    });
  }

  /**
   * Abandon a superseded attempt: close the resources THIS attempt opened and
   * leave every shared field alone.
   *
   * `conn.client` is this attempt's own client, so closing it cannot disturb a
   * newer connection that has since taken the id.
   */
  private async abandonAttempt(conn: McpConnection, why: string): Promise<void> {
    try {
      await conn.client.close();
    } catch {
      /* the transport is already gone; nothing to release */
    }
    this.reportAbandoned(conn.config, why);
  }

  async disconnect(id: string): Promise<void> {
    // Synchronous, and before anything that can await: this is what invalidates
    // an attempt that is parked between tearing down the prior connection and
    // registering its own. Marking the entry below is not enough on its own,
    // because an attempt in that window has not registered an entry to mark.
    this.invalidate(id);
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
    logger.info("mcp", "mcp.operation", {
      op: "disconnect",
      outcome: "ok",
      mcpServer: conn.config.name,
    });
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
    if (conn?.status !== "connected") {
      await this.connect(id);
      return;
    }
    await this.discoverCapabilities(id);
  }

  private scheduleReconnect(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    if (!conn.config.enabled) return;
    // Never arm a retry for a connection someone deliberately closed.
    if (conn.status === "disconnected") return;
    if (conn.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    conn.reconnectAttempts += 1;
    const attempt = conn.reconnectAttempts;
    conn.reconnectTimer = setTimeout(() => {
      const c = this.connections.get(id);
      if (!c?.config.enabled || c.status === "connected") return;
      // Re-check at fire time: the id may have been disconnected, or replaced,
      // between arming the timer and this callback running.
      if (c.status === "disconnected") return;
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

  /**
   * Discover tools, resources and prompts for a connection.
   *
   * Every one of those three calls is an await boundary, and each is followed by
   * a write. When `expected` is supplied the caller is a `connect()` attempt
   * that owns `id`, and two guards apply after each await:
   *
   *  - **ownership**: identity plus generation. Not status - by the time
   *    discovery runs the entry is already `"connected"`, so a status check
   *    would be false by construction and would silently skip every guard.
   *  - **reporting target**: failures are recorded against `conn`, the
   *    connection the discovery was actually running for. They used to go
   *    through `pushEvent(id, ...)`, which resolves whatever connection is live
   *    NOW - so a discovery that resumed after a disconnect or a replacement
   *    appended its error to somebody else's event history.
   *
   * A superseded discovery therefore writes nothing at all: no stale tool list,
   * no stale event. `refresh()` omits `expected`, which preserves the
   * refresh-on-the-live-connection behaviour.
   */
  private async discoverCapabilities(
    id: string,
    expected?: McpConnection,
    gen?: number,
  ): Promise<void> {
    const conn = expected ?? this.connections.get(id);
    if (!conn) return;
    const owns = () =>
      expected === undefined
        ? this.connections.get(id) === conn
        : this.ownsConnection(id, conn, gen as number);
    const caps = conn.serverCapabilities ?? {};
    try {
      if (caps.tools !== undefined) {
        const res = await conn.client.listTools();
        if (!owns()) return;
        conn.tools = (res.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      }
    } catch (err) {
      if (!owns()) return;
      this.pushEventTo(conn, "error", `Tool discovery failed: ${errMsg(err)}`);
    }
    try {
      if (caps.resources !== undefined) {
        const res = await conn.client.listResources();
        if (!owns()) return;
        conn.resources = (res.resources ?? []).map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));
      }
    } catch (err) {
      if (!owns()) return;
      this.pushEventTo(conn, "error", `Resource discovery failed: ${errMsg(err)}`);
    }
    try {
      if (caps.prompts !== undefined) {
        const res = await conn.client.listPrompts();
        if (!owns()) return;
        conn.prompts = (res.prompts ?? []).map((p) => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments,
        }));
      }
    } catch (err) {
      if (!owns()) return;
      this.pushEventTo(conn, "error", `Prompt discovery failed: ${errMsg(err)}`);
    }
  }

  // ---- Notifications / events ----

  private registerNotificationHandlers(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    const { client } = conn;

    client.setNotificationHandler("notifications/progress", (notification) => {
      const p = notification.params as {
        progress?: number;
        total?: number;
        progressToken?: unknown;
      };
      const msg = `Progress ${p.progress ?? "?"}"${p.total ? `/${p.total}` : ""}`;
      this.pushEvent(id, "progress", msg, notification.params);
    });

    client.setNotificationHandler("notifications/tools/list_changed", () => {
      this.pushEvent(id, "tool_list_changed", "Tool list changed");
      void this.discoverCapabilities(id);
    });

    client.setNotificationHandler("notifications/resources/list_changed", () => {
      this.pushEvent(id, "resource_list_changed", "Resource list changed");
      void this.discoverCapabilities(id);
    });

    client.setNotificationHandler("notifications/prompts/list_changed", () => {
      this.pushEvent(id, "prompt_list_changed", "Prompt list changed");
      void this.discoverCapabilities(id);
    });

    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      const uri = (notification.params as { uri?: string })?.uri ?? "";
      this.pushEvent(id, "resource_updated", `Resource updated: ${uri}`, notification.params);
    });

    client.setNotificationHandler("notifications/message", (notification) => {
      const params = notification.params as { level?: string; logger?: string; data?: unknown };
      const text = typeof params.data === "string" ? params.data : JSON.stringify(params.data);
      this.pushEvent(id, "log", `[${params.level ?? "info"}] ${text}`, notification.params);
    });
  }

  private pushEvent(id: string, kind: McpEventKind, message: string, data?: unknown): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.pushEventTo(conn, kind, message, data);
  }

  /**
   * Record an event against a SPECIFIC connection rather than whatever is
   * currently registered for that id.
   *
   * The distinction is the whole point: work belonging to a superseded
   * connection must land on that connection, not on whichever one took the id
   * while the work was suspended.
   */
  private pushEventTo(
    conn: McpConnection,
    kind: McpEventKind,
    message: string,
    data?: unknown,
  ): void {
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
    client.setRequestHandler("roots/list", () => {
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
    client.setRequestHandler("sampling/createMessage", (request: CreateMessageRequest) =>
      this.handleSampling(id, request),
    );

    // Elicitation: the server asks the *user* a question mid-tool-call; surface it to the UI.
    client.setRequestHandler("elicitation/create", (request: ElicitRequest) =>
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
    return {
      role: "assistant",
      content: { type: "text", text: result.text },
      model: provider.model,
    };
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
        ? {
            action: "accept",
            content: (content ?? {}) as Record<string, string | number | boolean | string[]>,
          }
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
    if (conn?.status !== "connected") throw new Error("Server not connected");
    const started = Date.now();
    try {
      const res = await conn.client.readResource({ uri });
      const contents = (res.contents ?? []).map(
        (c: { uri: string; mimeType?: string; text?: string; blob?: string }) => ({
          uri: c.uri,
          mimeType: c.mimeType,
          text: c.text,
          blob: c.blob,
        }),
      );
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
        // `target`, not `message`: `normalizeError` also emits `message`, and a
        // same-named key before the spread is silently overwritten, which lost
        // the URI on every resource_read failure. The error's own text wins.
        target: `uri=${uri}`,
        durationMs: Date.now() - started,
        ...normalizeError(err),
      });
      throw err;
    }
  }

  async getPrompt(
    id: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<McpPromptGetResult> {
    const conn = this.connections.get(id);
    if (conn?.status !== "connected") throw new Error("Server not connected");
    const started = Date.now();
    try {
      const res = await conn.client.getPrompt({ name, arguments: args });
      const messages = (res.messages ?? []).map(
        (m: { role: "user" | "assistant"; content?: unknown }) => ({
          role: m.role,
          content: { type: "text", text: extractMessageText(m.content) },
        }),
      );
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
        // `target`, not `message` - see the note in readResource above.
        target: `name=${name}`,
        durationMs: Date.now() - started,
        ...normalizeError(err),
      });
      throw err;
    }
  }

  // ---- Status reporting ----

  getStatuses(): McpStatus[] {
    const configs = this.loadConfigs();
    // Credential presence only (never values): one cheap query for the flag
    // the UI needs to render configured-vs-unconfigured auth.
    const presence = new Map<string, boolean>();
    try {
      const rows = db
        .query<{ id: string; auth_token: string | null }, []>(
          "SELECT id, auth_token FROM mcp_servers",
        )
        .all();
      for (const r of rows) presence.set(r.id, r.auth_token !== null);
    } catch {
      /* presence unknown — defaults to false below */
    }
    return configs.map((config) => {
      const conn = this.connections.get(config.id);
      const tools = conn?.tools ?? [];
      const resources = conn?.resources ?? [];
      const prompts = conn?.prompts ?? [];
      const authConfigured = presence.get(config.id) ?? false;
      return {
        id: config.id,
        name: config.name,
        transport: config.transport,
        enabled: config.enabled,
        status: conn?.status ?? "disconnected",
        error: conn?.error,
        failureReason: conn?.failureReason,
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
        authConfigured,
        authHint: authHintFor(config.authType, authConfigured),
        autoConnect: config.autoConnect,
        notes: config.notes,
        roots: config.roots,
        disabledTools: config.disabledTools,
        location: classifyLocation(config),
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
      const disabled = new Set(conn.config.disabledTools ?? []);
      const exposedTools = conn.tools.filter((t) => !disabled.has(t.name));
      // Log unknown entries (stale disabled entries that don't match any discovered tool).
      for (const entry of disabled) {
        if (!conn.tools.some((t) => t.name === entry)) {
          logger.warn("mcp", "mcp.filter_unknown_entry", {
            mcpServer: conn.config.name,
            entry,
          });
        }
      }
      if (exposedTools.length === 0 && conn.tools.length > 0) {
        logger.warn("mcp", "mcp.filter_empty", {
          mcpServer: conn.config.name,
          totalTools: conn.tools.length,
          disabledCount: disabled.size,
        });
      }
      for (const t of exposedTools) {
        const toolName = `mcp__${conn.config.id}__${t.name}`;
        const schema = (t.inputSchema as JSONSchema7) ?? {
          type: "object",
          properties: {},
        };
        tools[toolName] = tool({
          description: `[${conn.config.name}] ${t.description ?? t.name}`,
          inputSchema: jsonSchema(schema),
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
        logger.debug("mcp", "mcp.tool_filtered", {
          mcpServer: conn.config.name,
          toolName: t.name,
          reason: "exposed",
        });
      }
      // Log filtered (disabled) tools.
      for (const t of conn.tools) {
        if (disabled.has(t.name)) {
          logger.debug("mcp", "mcp.tool_filtered", {
            mcpServer: conn.config.name,
            toolName: t.name,
            reason: "disabled",
          });
        }
      }
      logger.debug("mcp", "mcp.filter_applied", {
        mcpServer: conn.config.name,
        totalTools: conn.tools.length,
        exposedTools: exposedTools.length,
        disabledCount: disabled.size,
      });
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
      // SSE-only diagnostic probe first (same rules as connect()): definitive
      // probe failures short-circuit with a classified failureReason.
      if (config.transport === "sse" && config.url) {
        const probe = await probeSseEndpoint(
          config.url,
          buildHeaders(config, input.authToken ?? undefined),
        );
        const reason = classifySseFailure(
          probe,
          undefined,
          (input.authToken ?? undefined) !== undefined,
        );
        if (
          probe.kind === "unreachable" ||
          probe.kind === "timeout" ||
          reason === "auth_required" ||
          reason === "auth_failed" ||
          reason === "incompatible_response"
        ) {
          const meta = safeEndpointMeta(config.url);
          const probeDetail =
            probe.kind === "ok"
              ? `status=${probe.status} content-type=${probe.contentType ?? "none"}`
              : `probe=${probe.kind}`;
          logger.warn("mcp", "mcp.operation", {
            op: "test_connection",
            outcome: "error",
            transport: config.transport,
            failureReason: reason,
            host: meta.host,
            port: meta.port,
            path: meta.path,
            message: probeDetail,
          });
          try {
            await client.close();
          } catch {
            /* ignore */
          }
          return {
            ok: false,
            transport: input.transport,
            error: sseFailureMessage(reason, meta),
            failureReason: reason,
            toolCount: 0,
            resourceCount: 0,
            promptCount: 0,
            tools: [],
            resources: [],
            prompts: [],
          };
        }
      }
      const transport = buildTransport(config, input.authToken ?? undefined);
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
          resources.push({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          });
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
      // SSE: classify the SDK error shape too (probe was inconclusive).
      let failureReason: McpFailureReason | undefined;
      if (config.transport === "sse" && config.url) {
        failureReason = classifySseFailure(
          { kind: "error" },
          err,
          (input.authToken ?? undefined) !== undefined,
        );
        const meta = safeEndpointMeta(config.url);
        logger.warn("mcp", "mcp.operation", {
          op: "test_connection",
          outcome: "error",
          transport: config.transport,
          category: classifyError(err).category,
          failureReason,
          host: meta.host,
          port: meta.port,
          path: meta.path,
        });
      }
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        transport: input.transport,
        error: message,
        failureReason,
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

/**
 * Masked, non-secret auth hint for the UI (type + mask). Never the credential.
 * Returns undefined when no credential is stored or auth is "none".
 */

/**
 * Human-readable, non-secret detail for a classified SSE failure. Carries
 * host/port/path only — never query strings, headers, or credentials.
 */

/** Best-effort text extraction from a v2 sampling/prompt message content block. */

export const mcpManager = McpManager.getInstance();
