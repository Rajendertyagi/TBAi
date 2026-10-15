import { Button, Input, Textarea } from "../../../components/ui";
import { SettingsError, SettingsSection } from "../../../components/shared/settings";
import { authPlaceholder } from "../copy";
import type { McpAuthType, McpFailureReason, McpTool, McpTransport } from "../../../types";
import { Check, X } from "lucide-react";

export interface DraftState {
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
  /** True when the server already stores a credential (presence only, never the value). */
  authConfigured: boolean;
  /** Masked hint echoed by the backend (e.g. "Bearer ••••••"). */
  authHint?: string;
  /** True after the user clicks "Remove auth": save sends authToken "" to clear. */
  authClearRequested: boolean;
  rootsText: string;
  enabled: boolean;
  autoConnect: boolean;
  notes: string;
  disabledTools: string[];
}

export function emptyDraft(): DraftState {
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
    authConfigured: false,
    authHint: undefined,
    authClearRequested: false,
    rootsText: "",
    enabled: true,
    autoConnect: true,
    notes: "",
    disabledTools: [],
  };
}

export interface McpServerFormProps {
  draft: DraftState;
  set: (patch: Partial<DraftState>) => void;
  runTest: () => Promise<void>;
  save: () => Promise<void>;
  cancel: () => void;
  formError: string | null;
  testResult: { ok: boolean; message: string; reason?: McpFailureReason } | null;
  testing: boolean;
  saving: boolean;
  isStdio: boolean;
  /** Discovered tools for this server (available when editing an existing server). */
  tools?: McpTool[];
}

export function McpServerForm({
  draft,
  set,
  runTest,
  save,
  cancel,
  formError,
  testResult,
  testing,
  saving,
  isStdio,
  tools,
}: McpServerFormProps) {
  return (
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
                onChange={(e) =>
                  set({ authType: e.target.value as McpAuthType, authClearRequested: false })
                }
                className="rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="basic">Basic (user:pass)</option>
                <option value="oauth">OAuth</option>
              </select>
              {draft.id && draft.authConfigured && !draft.authClearRequested && draft.authHint && (
                <span className="text-xs text-muted-foreground font-mono">
                  {draft.authHint} stored
                </span>
              )}
            </div>
            {draft.authType !== "none" && !draft.authClearRequested && (
              <>
                {draft.id && draft.authConfigured && (
                  <p className="text-xs text-muted-foreground">
                    A credential is stored. Leave blank to keep it, type a new value to replace it,
                    or remove it.
                  </p>
                )}
                {draft.id && !draft.authConfigured && (
                  <p className="text-xs text-muted-foreground">
                    No credential is stored — connections will be unauthenticated until you enter
                    one.
                  </p>
                )}
                <Input
                  type="password"
                  placeholder={
                    draft.id && draft.authConfigured
                      ? "New value (blank keeps stored credential)"
                      : authPlaceholder(draft.authType)
                  }
                  value={draft.authToken}
                  onChange={(e) => set({ authToken: e.target.value })}
                />
              </>
            )}
            {draft.id &&
              draft.authConfigured &&
              !draft.authClearRequested &&
              draft.authType !== "none" && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => set({ authClearRequested: true, authToken: "" })}
                  >
                    <X className="w-3 h-3 mr-1" />
                    Remove auth
                  </Button>
                </div>
              )}
            {draft.authClearRequested && (
              <p className="text-xs text-warning">
                Stored credential will be removed on save. Cancel to keep it.
              </p>
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
          placeholder={
            "Roots (optional) — file locations the server may access, one URI per line\nfile:///C:/Users/you"
          }
          value={draft.rootsText}
          onChange={(e) => set({ rootsText: e.target.value })}
        />

        {tools && tools.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              Tool filtering (denylist — unchecked tools are hidden from the AI)
            </div>
            <div className="space-y-1 max-h-44 overflow-y-auto">
              {tools.map((t) => {
                const disabled = (draft.disabledTools ?? []).includes(t.name);
                return (
                  <label key={t.name} className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!disabled}
                      onChange={(e) => {
                        const current = draft.disabledTools ?? [];
                        if (e.target.checked) {
                          // Enable: remove from disabled list
                          set({ disabledTools: current.filter((n) => n !== t.name) });
                        } else {
                          // Disable: add to disabled list
                          set({ disabledTools: [...current, t.name] });
                        }
                      }}
                    />
                    <span className="font-mono">{t.name}</span>
                    {t.description && (
                      <span className="text-muted-foreground truncate">— {t.description}</span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        )}

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
  );
}
