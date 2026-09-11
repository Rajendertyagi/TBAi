import { useEffect, useState } from "react";
import { Button, Input } from "./ui";
import type { McpPendingElicitation } from "../types";

/**
 * Global modal that surfaces MCP server-initiated elicitation requests. When a connected
 * server asks the user a question mid-tool-call, the backend holds the request and exposes
 * it via GET /api/mcp/elicit/pending. This component polls for it and lets the user answer.
 */
export function ElicitationModal() {
  const [pending, setPending] = useState<McpPendingElicitation | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/mcp/elicit/pending");
        const data = (await res.json()) as McpPendingElicitation | null;
        if (!active) return;
        if (data && (!pending || data.elicitationId !== pending.elicitationId)) {
          setPending(data);
          const initial: Record<string, string> = {};
          for (const f of data.fields ?? []) if (f.default) initial[f.name] = f.default;
          setValues(initial);
        } else if (!data && pending) {
          setPending(null);
        }
      } catch {
        /* ignore polling errors */
      }
    };
    const interval = setInterval(tick, 1500);
    void tick();
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [pending]);

  if (!pending) return null;

  const resolve = async (action: "accept" | "decline" | "cancel") => {
    setBusy(true);
    try {
      await fetch("/api/mcp/elicit/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: pending.serverId,
          elicitationId: pending.elicitationId,
          action,
          content: action === "accept" ? values : undefined,
        }),
      });
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-xl">
        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
          {pending.serverName} is asking
        </div>
        <p className="mb-3 text-sm">{pending.message}</p>

        {pending.mode === "url" ? (
          <a
            href={pending.url}
            target="_blank"
            rel="noreferrer"
            className="mb-3 block break-all text-xs text-blue-500 underline"
          >
            {pending.url}
          </a>
        ) : (
          <div className="mb-3 space-y-2">
            {(pending.fields ?? []).map((f) => (
              <div key={f.name} className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">
                  {f.title ?? f.name}
                  {f.description ? ` — ${f.description}` : ""}
                </label>
                {f.enum ? (
                  <select
                    value={values[f.name] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    className="rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                  >
                    <option value="">—</option>
                    {(f.enumNames ?? f.enum).map((opt, i) => (
                      <option key={opt} value={opt}>
                        {f.enumNames?.[i] ?? opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={values[f.name] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => resolve("cancel")}>
            Cancel
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => resolve("decline")}>
            Decline
          </Button>
          <Button size="sm" disabled={busy} onClick={() => resolve("accept")}>
            {busy ? "…" : "Submit"}
          </Button>
        </div>
      </div>
    </div>
  );
}
