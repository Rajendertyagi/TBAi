import { useEffect, useState } from "react";
import { Link } from "react-router";
import { FolderCog } from "lucide-react";
import { SettingRow, SettingsPage, SettingsSection } from "../../components/shared/settings";

interface Sysinfo {
  platform: string;
  arch: string;
  release: string;
  hostname: string;
  cpuCount: number;
  cpuModel: string;
  totalMemoryMB: number;
  freeMemoryMB: number;
  uptimeHours: number;
}

/**
 * Workspace settings (`/workspace`): sandbox policy + machine info.
 * Read-only surface over existing /api/tools endpoints (no new backend).
 * File operations themselves stay in chat tools.
 */
export function WorkspacePage() {
  const [sysinfo, setSysinfo] = useState<Sysinfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tools/sysinfo", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Sysinfo;
        if (!cancelled) setSysinfo(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SettingsPage
      title="Workspace"
      description="The folder the assistant may read and work in. Every file tool is confined here — paths outside it are refused."
    >
      <SettingsSection
        title="Sandbox policy"
        icon={FolderCog}
        description="All assistant file and shell tools resolve inside the workspace root. Path traversal and symlink escapes are rejected before any IO."
      >
        <SettingRow
          label="Working in chat"
          description="Ask the assistant to list, read, search, edit, or run things — destructive actions always ask for approval first."
          control={
            <Link
              to="/chat/new"
              className="inline-flex items-center justify-center rounded-md border border-input bg-transparent px-3 py-1 text-sm transition-colors hover:bg-muted"
            >
              Open chat
            </Link>
          }
        />
      </SettingsSection>
      <SettingsSection title="This computer">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!sysinfo && !error && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
        {sysinfo && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            {(
              [
                ["OS", `${sysinfo.platform} ${sysinfo.arch} (${sysinfo.release})`],
                ["Host", sysinfo.hostname],
                ["CPU", `${sysinfo.cpuCount} × ${sysinfo.cpuModel}`],
                ["Memory", `${sysinfo.freeMemoryMB} / ${sysinfo.totalMemoryMB} MB free`],
                ["Uptime", `${sysinfo.uptimeHours} h`],
              ] as Array<[string, string]>
            ).map(([label, value]) => (
              <div key={label} className="rounded-md border border-border p-2">
                <div className="text-muted-foreground">{label}</div>
                <div className="mt-0.5 break-words">{value}</div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
