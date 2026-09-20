import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Globe } from "lucide-react";
import { toast } from "sonner";
import { SettingsSection, SettingRow } from "../../components/shared/settings";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useServerIdentity } from "./state/serverIdentity";

/** Poll cadence while waiting for the rebound server to answer. */
const READY_POLL_INTERVAL_MS = 250;
/** How long to wait for the new origin before reporting failure. */
const READY_TIMEOUT_MS = 15000;

interface PortProbe {
  port: number;
  available: boolean;
  reason?: string;
}

function isValidPortText(text: string): boolean {
  if (!/^\d{1,5}$/.test(text.trim())) return false;
  const n = Number.parseInt(text.trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function formatTime(when: number): string {
  return new Date(when).toLocaleTimeString();
}

async function waitForReady(origin: string): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/healthz`, { cache: "no-store" });
      if (res.ok) return true;
    } catch {
      /* not up yet — keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Web server port with explicit restart.
 *
 * TBAi runs ONE application server. Editing the value only changes the
 * pending input — the live listener is untouched until "Restart to apply" is
 * clicked. Save persists without restarting (next boot picks it up); restart
 * rebinds the same server (persisting first), then the client polls the new
 * origin and navigates, preserving the current path + hash. All API calls
 * are same-origin relative, so navigation is the entire reconnect: no stale
 * base URL exists.
 */
export function ServerSection() {
  // Shared server identity (also drives the status-bar indicator): active vs
  // configured ports plus reachability. Local input state stays here — the
  // shared poller never steals typed text; it only refreshes on explicit
  // reload() calls below.
  const { identity, reachable, checkedAt, loadError, reload } =
    useServerIdentity();
  const [input, setInput] = useState("");
  const [inputSeeded, setInputSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<PortProbe | null>(null);
  const [copied, setCopied] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Seed the input once from the configured port; afterwards it belongs to
  // the user until save/restart replace it.
  useEffect(() => {
    if (!inputSeeded && identity != null) {
      setInput(String(identity.configuredPort));
      setInputSeeded(true);
    }
  }, [identity, inputSeeded]);

  const busy = saving || restarting || testing;
  const inputValid = isValidPortText(input);
  const inputPort = inputValid ? Number.parseInt(input.trim(), 10) : null;
  // Save: input differs from the persisted configured value.
  const dirty = identity != null && inputPort != null
    && inputPort !== identity.configuredPort;
  // Restart: input differs from the live listener.
  const pending = identity != null && inputPort != null
    && inputPort !== identity.activePort;

  const onSave = useCallback(async () => {
    if (!identity || busy || !dirty || inputPort == null) return;
    setSaving(true);
    setRestartError(null);
    try {
      const res = await fetch("/api/server/port", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: inputPort }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`);
      // Re-read shared identity so Save/Restart visibility follows the
      // persisted value; the typed input is left alone.
      await reload();
      toast.success(`Port ${inputPort} saved. Restart to apply.`);
    } catch (err: unknown) {
      if (!mounted.current) return;
      const message = err instanceof Error ? err.message : "Save failed.";
      setRestartError(message);
      toast.error(message);
      await reload();
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [busy, dirty, inputPort, reload]);

  const probePort = useCallback(async (port: number): Promise<PortProbe> => {
    const res = await fetch("/api/server/check-port", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      available?: boolean;
      reason?: string;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error ?? `Check failed (${res.status})`);
    return { port, available: data.available === true, reason: data.reason };
  }, []);

  const onTest = useCallback(async () => {
    if (!identity || busy || inputPort == null || !pending) return;
    setTesting(true);
    setRestartError(null);
    try {
      const result = await probePort(inputPort);
      if (mounted.current) setProbe(result);
    } catch (err: unknown) {
      if (!mounted.current) return;
      const message = err instanceof Error ? err.message : "Check failed.";
      setRestartError(message);
      toast.error(message);
    } finally {
      if (mounted.current) setTesting(false);
    }
  }, [identity, busy, inputPort, pending, probePort]);

  const onRestart = useCallback(async () => {
    if (!identity || busy || !pending || inputPort == null) return;
    const port = inputPort;
    setRestarting(true);
    setRestartError(null);
    try {
      // Pre-flight: fail fast with a clear message instead of attempting a
      // restart that is guaranteed to conflict. The server re-validates at
      // bind time, so a port taken in between still fails honestly there.
      const pre = await probePort(port);
      if (mounted.current) setProbe(pre);
      if (!pre.available) {
        throw new Error(
          pre.reason === "active_port"
            ? `Already running on port ${port}.`
            : `Port ${port} is already in use.`,
        );
      }
      const res = await fetch("/api/server/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        activePort?: number;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Restart failed (${res.status})`);
      }
      // The response came from the OLD listener. Wait until the new origin
      // actually answers, then move the whole client (browser tab or Tauri
      // webview) over, preserving the current view via path + hash.
      const loc = window.location;
      const origin = `${loc.protocol}//${loc.hostname}:${port}`;
      const ready = await waitForReady(origin);
      if (!mounted.current) return;
      if (!ready) {
        setRestartError(
          `The server did not answer on port ${port}. It may still be starting — retry, or return to port ${identity.activePort} if that listener is still up.`,
        );
        toast.error(`Server not reachable on port ${port}.`);
        await reload();
        return;
      }
      window.location.href = `${origin}${loc.pathname}${loc.search}${loc.hash}`;
    } catch (err: unknown) {
      if (!mounted.current) return;
      const message = err instanceof Error ? err.message : "Restart failed.";
      setRestartError(message);
      toast.error(message);
      // Re-read: a bind conflict leaves the old listener running, so the UI
      // must show the still-active port rather than the failed target.
      await reload();
    } finally {
      if (mounted.current) setRestarting(false);
    }
  }, [identity, busy, pending, inputPort, reload, probePort]);

  const onCopyUrl = useCallback(async () => {
    if (!identity) return;
    const loc = window.location;
    const url = `${loc.protocol}//${loc.hostname}:${identity.activePort}`;
    try {
      await navigator.clipboard.writeText(url);
      if (!mounted.current) return;
      setCopied(true);
      toast.success("Server URL copied.");
      setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, 2000);
    } catch {
      toast.error("Could not copy to clipboard.");
    }
  }, [identity]);

  const statusDot =
    reachable == null ? (
      <span className="inline-block size-2 rounded-full bg-muted-foreground/40" aria-hidden="true" />
    ) : reachable ? (
      <span className="inline-block size-2 rounded-full bg-emerald-500" aria-hidden="true" />
    ) : (
      <span className="inline-block size-2 rounded-full bg-destructive" aria-hidden="true" />
    );
  const statusText =
    reachable == null
      ? "Checking…"
      : reachable
        ? `Running${checkedAt != null ? ` · checked ${formatTime(checkedAt)}` : ""}`
        : `Unreachable${checkedAt != null ? ` · checked ${formatTime(checkedAt)}` : ""}`;

  return (
    <SettingsSection
      title="Web server"
      icon={Globe}
      description="TBAi runs a single local web server. Changing the port never restarts immediately — the current server keeps running until you apply the change."
    >
      <SettingRow
        label="Active port"
        icon={Globe}
        description={
          loadError ?? identity == null
            ? (loadError ?? "Reading server state…")
            : `The server is currently listening on port ${identity.activePort}.`
        }
        control={
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5" title={statusText}>
              {statusDot}
              <span className="text-sm font-medium tabular-nums" aria-live="polite">
                {identity?.activePort ?? "—"}
              </span>
            </span>
            {identity != null && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void onCopyUrl()}
                aria-label="Copy server URL"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy URL"}
              </Button>
            )}
          </div>
        }
      />
      <SettingRow
        label="Port"
        icon={Globe}
        description={
          identity?.envLocked
            ? "The port is set by the PORT environment variable and cannot be changed here."
            : "Edit the port, save it for later, or restart to apply now. Until restart the server keeps running on the active port."
        }
        control={
          <div className="flex items-center gap-2">
            <Input
              value={input}
              disabled={busy || identity == null || identity.envLocked}
              onChange={(e) => {
                setInput(e.target.value);
                setProbe(null);
                setRestartError(null);
              }}
              inputMode="numeric"
              aria-label="Web server port"
              className="w-24 text-right tabular-nums"
            />
            {dirty && !identity?.envLocked && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || !inputValid}
                onClick={() => void onSave()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            )}
            {pending && !identity?.envLocked && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !inputValid}
                  onClick={() => void onTest()}
                >
                  {testing ? "Testing…" : "Test"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || !inputValid}
                  onClick={() => void onRestart()}
                >
                  {restarting ? "Restarting…" : "Restart to apply"}
                </Button>
              </>
            )}
          </div>
        }
      />
      {!inputValid && input !== "" && (
        <p className="text-sm text-destructive" role="alert">
          Enter a port between 1 and 65535.
        </p>
      )}
      {probe != null && probe.port === inputPort && (
        <p
          className={`text-sm ${probe.available ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
          role="status"
        >
          {probe.available
            ? `Port ${probe.port} is available.`
            : probe.reason === "active_port"
              ? `Port ${probe.port} is the active port.`
              : `Port ${probe.port} is already in use.`}
        </p>
      )}
      {restartError != null && (
        <p className="text-sm text-destructive" role="alert">
          {restartError}
        </p>
      )}
    </SettingsSection>
  );
}
