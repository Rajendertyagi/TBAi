import { useState } from "react";
import { Server } from "lucide-react";
import { useSettingsStore } from "../../stores";
import { Button, Input } from "../../components/ui";
import { Plus, Trash2, Check, Pencil, X } from "lucide-react";
import { SettingsPage, SettingsSection } from "../../components/shared/settings";
import { cn } from "../../lib/utils";
import type { ModelOption } from "../../types";

interface EditState {
  id: string | null;
  name: string;
  type: "openai" | "anthropic" | "google" | "ollama" | "custom";
  endpoint: string;
  apiKey: string;
  model: string;
  models: ModelOption[];
  thinking: "off" | "low" | "medium" | "high";
}

function defaultModelId(models: ModelOption[]): string {
  if (!models.length) return "";
  const latest = models.find((m) => /latest/i.test(m.id));
  return latest?.id ?? models[0].id;
}

/**
 * Providers settings (`/providers`): model providers, endpoints, credentials
 * (keys stay backend-encrypted; the browser never sees them), default models
 * and thinking levels. Moved here from components/SettingsPanel during the
 * application-foundation refactor; behavior unchanged.
 */
export function ProvidersPage() {
  const { providers, setActiveProvider, loadProviders } = useSettingsStore();
  const [isAdding, setIsAdding] = useState(false);
  const [editState, setEditState] = useState<EditState>({
    id: null,
    name: "",
    type: "openai",
    endpoint: "",
    apiKey: "",
    model: "",
    models: [],
    thinking: "off",
  });
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [discovered, setDiscovered] = useState<ModelOption[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState("");

  const startEdit = (provider: any) => {
    setTestResult(null);
    setDiscovered([]);
    setPicked(new Set());
    setDiscoverError(null);
    setEditState({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      endpoint: provider.endpoint || "",
      apiKey: "",
      model: provider.model,
      models: provider.models ?? [],
      thinking: provider.thinking || "off",
    });
  };

  const cancelEdit = () => {
    setTestResult(null);
    setDiscovered([]);
    setPicked(new Set());
    setDiscoverError(null);
    setEditState({ id: null, name: "", type: "openai", endpoint: "", apiKey: "", model: "", models: [], thinking: "off" });
  };

  const handleSaveEdit = async () => {
    if (!editState.id || !editState.name || (!editState.model && editState.models.length === 0)) return;

    await fetch(`/api/providers/${editState.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editState.name,
        type: editState.type,
        endpoint: editState.endpoint || "",
        apiKey: editState.apiKey ? editState.apiKey : undefined,
        model: editState.model,
        models: editState.models,
        thinking: editState.thinking,
      }),
    });

    await loadProviders();
    setTestResult(null);
    cancelEdit();
  };

  const handleAddProvider = async () => {
    if (!editState.name || (!editState.model && editState.models.length === 0)) return;

    await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editState.name,
        type: editState.type,
        endpoint: editState.endpoint || "",
        apiKey: editState.apiKey ? editState.apiKey : undefined,
        model: editState.model,
        models: editState.models,
        thinking: editState.thinking,
      }),
    });

    await loadProviders();
    setIsAdding(false);
    setTestResult(null);
    cancelEdit();
  };

  const handleTest = async () => {
    if (!editState.name && !editState.id) return;
    setTesting(true);
    setTestResult(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const payload: any = {
        name: editState.name || editState.type,
        type: editState.type,
        endpoint: editState.endpoint || "",
        model: editState.model,
      };
      if (editState.id) payload.id = editState.id;
      if (editState.apiKey) payload.apiKey = editState.apiKey;
      const res = await fetch("/api/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult({
          ok: true,
          message: data.modelCount > 0 ? `Connection successful (${data.modelCount} models found)` : "Connection successful",
        });
        if (data.modelCount > 0) handleDiscover();
      } else setTestResult({ ok: false, message: data.error || "Connection failed" });
    } catch (e) {
      setTestResult({
        ok: false,
        message: e instanceof DOMException && e.name === "AbortError" ? "Test timed out" : "Request failed",
      });
    } finally {
      clearTimeout(timer);
      setTesting(false);
    }
  };

  const handleSetActive = async (id: string) => {
    await fetch(`/api/providers/${id}/set-active`, { method: "POST" });
    setActiveProvider(id);
  };

  const handleDeleteProvider = async (id: string) => {
    await fetch(`/api/providers/${id}`, { method: "DELETE" });
    await loadProviders();
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    setDiscoverError(null);
    setDiscovered([]);
    setPicked(new Set());
    try {
      const payload: any = {
        name: editState.name || editState.type,
        type: editState.type,
        endpoint: editState.endpoint || "",
      };
      if (editState.id) payload.id = editState.id;
      if (editState.apiKey) payload.apiKey = editState.apiKey;
      const res = await fetch("/api/providers/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        if (data.models?.length) setDiscovered(data.models);
        else setDiscoverError("No models returned. Enter one manually below.");
      } else {
        setDiscoverError(data.error || "Could not find models");
      }
    } catch {
      setDiscoverError("Request failed");
    } finally {
      setDiscovering(false);
    }
  };

  const handleAddPicked = () => {
    const chosen = discovered.filter((m) => picked.has(m.id));
    const merged = [...editState.models];
    for (const m of chosen) {
      if (!merged.some((x) => x.id === m.id)) merged.push(m);
    }
    const nextModel = editState.model || defaultModelId(merged);
    setEditState({ ...editState, models: merged, model: nextModel });
    setDiscovered([]);
    setPicked(new Set());
  };

  const handleAddAll = () => {
    const merged = [...editState.models];
    for (const m of discovered) {
      if (!merged.some((x) => x.id === m.id)) merged.push(m);
    }
    const nextModel = editState.model || defaultModelId(merged);
    setEditState({ ...editState, models: merged, model: nextModel });
    setDiscovered([]);
    setPicked(new Set());
  };

  const handleAddManual = () => {
    const id = manualModel.trim();
    if (!id) return;
    const merged = [...editState.models];
    if (!merged.some((x) => x.id === id)) {
      merged.push({ id, provider: editState.type });
    }
    const nextModel = editState.model || id;
    setEditState({ ...editState, models: merged, model: nextModel });
    setManualModel("");
  };

  const handleRemoveModel = (id: string) => {
    const merged = editState.models.filter((m) => m.id !== id);
    const nextModel = editState.model === id ? (merged[0]?.id ?? "") : editState.model;
    setEditState({ ...editState, models: merged, model: nextModel });
  };

  return (
    <SettingsPage
      title="Providers"
      description="Model providers, endpoints, and credentials. API keys are encrypted on the server and never shown here."
      actions={
        <Button size="sm" onClick={() => { setIsAdding(true); cancelEdit(); }}>
          <Plus className="w-3 h-3 mr-1" />
          Add
        </Button>
      }
    >
      {/* Add/Edit Form */}
      {(isAdding || editState.id !== null) && (
        <SettingsSection title={editState.id ? "Edit provider" : "Add provider"} icon={Server}>
            <Input
              placeholder="Provider name"
              value={editState.name}
              onChange={(e) => setEditState({ ...editState, name: e.target.value })}
            />
            <select
              value={editState.type}
              onChange={(e) => setEditState({ ...editState, type: e.target.value as any })}
              className="w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google Gemini</option>
              <option value="ollama">Ollama</option>
              <option value="custom">Custom (OpenAI-compatible)</option>
            </select>
            <Input
              placeholder="Endpoint (optional)"
              value={editState.endpoint}
              onChange={(e) => setEditState({ ...editState, endpoint: e.target.value })}
            />
            <Input
              placeholder="API Key (leave blank to keep existing)"
              type="password"
              value={editState.apiKey}
              onChange={(e) => setEditState({ ...editState, apiKey: e.target.value })}
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-20 shrink-0">Thinking</span>
              <select
                value={editState.thinking}
                onChange={(e) => setEditState({ ...editState, thinking: e.target.value as EditState["thinking"] })}
                className="flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="off">Off</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={handleDiscover} disabled={discovering}>
                  {discovering ? "Finding…" : "Find models"}
                </Button>
                {discoverError && (
                  <span className="text-xs text-destructive">{discoverError}</span>
                )}
              </div>

              {discovered.length > 0 && (
                <div className="space-y-2">
                  <div className="rounded-md border border-border p-2 space-y-1 max-h-44 overflow-y-auto">
                    {discovered.map((m) => (
                      <label key={m.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={picked.has(m.id)}
                          onChange={(e) => {
                            const next = new Set(picked);
                            if (e.target.checked) next.add(m.id);
                            else next.delete(m.id);
                            setPicked(next);
                          }}
                        />
                        <span>{m.label ?? m.id}</span>
                        {m.label && m.label !== m.id && (
                          <span className="text-xs text-muted-foreground">{m.id}</span>
                        )}
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={handleAddPicked} disabled={picked.size === 0}>
                      Add selected ({picked.size})
                    </Button>
                    <Button size="sm" variant="ghost" onClick={handleAddAll} disabled={discovered.length === 0}>
                      Add all ({discovered.length})
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Input
                  placeholder="Can't find yours? Type a model name"
                  value={manualModel}
                  onChange={(e) => setManualModel(e.target.value)}
                />
                <Button size="sm" variant="ghost" onClick={handleAddManual} disabled={!manualModel.trim()}>
                  Add
                </Button>
              </div>

              {editState.models.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {editState.models.map((m) => (
                    <span
                      key={m.id}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                        m.id === editState.model
                          ? "border-foreground/40 bg-foreground/10"
                          : "border-border"
                      )}
                    >
                      <button type="button" onClick={() => setEditState({ ...editState, model: m.id })}>
                        {m.label ?? m.id}
                      </button>
                      {m.id === editState.model && (
                        <span className="text-[10px] text-muted-foreground">default</span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRemoveModel(m.id)}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label="Remove model"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={editState.id ? handleSaveEdit : handleAddProvider}>
                <Check className="w-3 h-3 mr-1" />
                {editState.id ? "Update" : "Save"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setIsAdding(false); cancelEdit(); }}>
                <X className="w-3 h-3 mr-1" />
                Cancel
              </Button>
              <Button size="sm" variant="ghost" onClick={handleTest} disabled={testing}>
                {testing ? "Testing…" : "Test connection"}
              </Button>
            </div>
            {testResult && (
              <p className={testResult.ok ? "text-xs text-success" : "text-xs text-destructive"}>
                {testResult.message}
              </p>
            )}
        </SettingsSection>
      )}

      <SettingsSection title="Configured providers" icon={Server}>
        <div className="space-y-2">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className={cn(
                "flex items-center justify-between p-3 rounded-md border",
                provider.isActive ? "border-foreground/20 bg-foreground/5" : "border-border"
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{provider.name}</span>
                  {provider.isActive && (
                    <span className="text-xs bg-foreground text-background px-1.5 py-0.5 rounded">
                      Active
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {provider.type} · {provider.models?.length ? `${provider.models.length} model(s)` : provider.model}
                  {provider.endpoint && ` · ${provider.endpoint}`}
                  {provider.credentialConfigured ? (
                    <span className="ml-1 text-success">· Configured</span>
                  ) : provider.type !== "ollama" ? (
                    <span className="ml-1 text-warning">· No key</span>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-1 ml-2">
                {!provider.isActive && (
                  <Button size="sm" variant="ghost" onClick={() => handleSetActive(provider.id)}>
                    <Check className="w-3 h-3" />
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => startEdit(provider)}>
                  <Pencil className="w-3 h-3" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => handleDeleteProvider(provider.id)}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </div>
          ))}
          {providers.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No providers yet. Add one to start chatting.
            </p>
          )}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
