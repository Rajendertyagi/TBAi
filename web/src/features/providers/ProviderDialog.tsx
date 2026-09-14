import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { useSettingsStore } from "@/stores";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ApiProtocol, ModelOption, ProviderConfig } from "@/types";

type ProviderType = ProviderConfig["type"];

const TYPE_OPTIONS: Array<{ value: ProviderType; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google Gemini" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
];

const THINKING_OPTIONS = ["off", "low", "medium", "high"] as const;

function defaultApiProtocol(type: ProviderType): ApiProtocol {
  if (type === "openai") return "responses";
  if (type === "custom" || type === "ollama") return "chat-completions";
  return "responses";
}

function defaultModelId(models: ModelOption[]): string {
  if (!models.length) return "";
  const latest = models.find((m) => /latest/i.test(m.id));
  return latest?.id ?? models[0].id;
}

interface FormState {
  name: string;
  type: ProviderType;
  endpoint: string;
  apiKey: string;
  model: string;
  models: ModelOption[];
  thinking: "off" | "low" | "medium" | "high";
  apiProtocol: ApiProtocol;
}

function blankForm(): FormState {
  return {
    name: "",
    type: "openai",
    endpoint: "",
    apiKey: "",
    model: "",
    models: [],
    thinking: "off",
    apiProtocol: defaultApiProtocol("openai"),
  };
}

function formFromProvider(p: ProviderConfig): FormState {
  return {
    name: p.name,
    type: p.type,
    endpoint: p.endpoint || "",
    apiKey: "",
    model: p.model,
    models: p.models ?? [],
    thinking: p.thinking || "off",
    apiProtocol: p.apiProtocol ?? defaultApiProtocol(p.type),
  };
}

interface ProviderDialogProps {
  mode: "add" | "edit";
  /** Edit target; null for add mode. */
  provider: ProviderConfig | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

function ProviderDialog({ mode, provider, open, onOpenChange, onSaved }: ProviderDialogProps) {
  const { loadProviders } = useSettingsStore();
  const [form, setForm] = useState<FormState>(() =>
    mode === "edit" && provider ? formFromProvider(provider) : blankForm(),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [discovered, setDiscovered] = useState<ModelOption[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState("");

  // Reset (add) or prefill (edit) every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setForm(mode === "edit" && provider ? formFromProvider(provider) : blankForm());
    setError(null);
    setTestResult(null);
    setDiscovered([]);
    setPicked(new Set());
    setDiscoverError(null);
    setManualModel("");
    setSaving(false);
  }, [open, mode, provider]);

  /** Models actually being saved: stored list plus anything still staged —
      ticked discovery picks and even unconfirmed manual text (both used to
      be silently dropped on Save). */
  const effectiveModels = (): ModelOption[] => {
    const merged = [...form.models];
    for (const m of discovered.filter((d) => picked.has(d.id))) {
      if (!merged.some((x) => x.id === m.id)) merged.push(m);
    }
    const manualId = manualModel.trim();
    if (manualId && !merged.some((x) => x.id === manualId)) {
      merged.push({ id: manualId, provider: form.type });
    }
    return merged;
  };

  const validate = (): ModelOption[] | null => {
    if (!form.name.trim()) {
      setError("Give the provider a name.");
      return null;
    }
    const models = effectiveModels();
    if (!form.model && models.length === 0) {
      setError("Add at least one model (Find models, or type one below).");
      return null;
    }
    if (form.type === "custom" && !form.endpoint.trim()) {
      setError("Custom providers need an endpoint (OpenAI-compatible base URL).");
      return null;
    }
    return models;
  };

  const handleSubmit = async () => {
    const models = validate();
    if (!models || saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        type: form.type,
        endpoint: form.endpoint || "",
        apiKey: form.apiKey ? form.apiKey : undefined,
        model: form.model || defaultModelId(models),
        models,
        thinking: form.thinking,
        apiProtocol: form.apiProtocol,
      };
      const res =
        mode === "edit" && provider
          ? await fetch(`/api/providers/${provider.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            })
          : await fetch("/api/providers", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || `Save failed (${res.status}).`);
        return;
      }
      toast.success(mode === "edit" ? "Provider updated" : "Provider added");
      await loadProviders();
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if ((!form.name && !provider) || testing) return;
    setTesting(true);
    setTestResult(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const payload: Record<string, unknown> = {
        name: form.name || form.type,
        type: form.type,
        endpoint: form.endpoint || "",
        model: form.model,
      };
      if (provider) payload.id = provider.id;
      if (form.apiKey) payload.apiKey = form.apiKey;
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
          message:
            data.modelCount > 0
              ? `Connection successful (${data.modelCount} models found)`
              : "Connection successful",
        });
        if (data.modelCount > 0) void handleDiscover();
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

  const handleDiscover = async () => {
    setDiscovering(true);
    setDiscoverError(null);
    setDiscovered([]);
    setPicked(new Set());
    try {
      const payload: Record<string, unknown> = {
        name: form.name || form.type,
        type: form.type,
        endpoint: form.endpoint || "",
      };
      if (provider) payload.id = provider.id;
      if (form.apiKey) payload.apiKey = form.apiKey;
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

  const mergeModels = (ids: string[]) => {
    const merged = [...form.models];
    for (const m of discovered.filter((d) => ids.includes(d.id))) {
      if (!merged.some((x) => x.id === m.id)) merged.push(m);
    }
    setForm({ ...form, models: merged, model: form.model || defaultModelId(merged) });
    setDiscovered([]);
    setPicked(new Set());
  };

  const handleAddManual = () => {
    const id = manualModel.trim();
    if (!id) return;
    const merged = [...form.models];
    if (!merged.some((x) => x.id === id)) {
      merged.push({ id, provider: form.type });
    }
    setForm({ ...form, models: merged, model: form.model || id });
    setManualModel("");
  };

  const handleRemoveModel = (id: string) => {
    const merged = form.models.filter((m) => m.id !== id);
    setForm({ ...form, models: merged, model: form.model === id ? (merged[0]?.id ?? "") : form.model });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-4xl border-0 shadow-2xl ring-1 ring-border gap-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-medium">
            {mode === "edit" ? "Edit provider" : "Add provider"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={mode === "edit" ? "edit-mp-name" : "add-mp-name"} className="text-xs font-medium">
              Name
            </label>
            <Input
              id={mode === "edit" ? "edit-mp-name" : "add-mp-name"}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Provider name"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Type</label>
            <Select
              value={form.type}
              onValueChange={(v) => {
                const type = v as ProviderType;
                setForm({ ...form, type, apiProtocol: defaultApiProtocol(type) });
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.type !== "google" && form.type !== "anthropic" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium">API protocol</label>
              <Select
                value={form.apiProtocol}
                onValueChange={(v) => setForm({ ...form, apiProtocol: v as ApiProtocol })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat-completions" className="text-xs">
                    Chat Completions
                  </SelectItem>
                  <SelectItem value="responses" className="text-xs">
                    Responses API
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor={mode === "edit" ? "edit-mp-endpoint" : "add-mp-endpoint"} className="text-xs font-medium">
              Endpoint
            </label>
            <Input
              id={mode === "edit" ? "edit-mp-endpoint" : "add-mp-endpoint"}
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              placeholder={
                form.type === "custom"
                  ? "Endpoint (required, e.g. http://localhost:1234/v1)"
                  : "Endpoint (optional)"
              }
            />
          </div>
          {form.type === "custom" && (
            <p className="text-xs text-muted-foreground">
              OpenAI-compatible base URL. Used for chat, connection testing, and model discovery.
            </p>
          )}

          <div className="space-y-1.5">
            <label htmlFor={mode === "edit" ? "edit-mp-key" : "add-mp-key"} className="text-xs font-medium">
              API key
            </label>
            <Input
              id={mode === "edit" ? "edit-mp-key" : "add-mp-key"}
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={mode === "edit" ? "Leave blank to keep the current key" : "API key"}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Thinking</label>
            <Select
              value={form.thinking}
              onValueChange={(v) => setForm({ ...form, thinking: v as FormState["thinking"] })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THINKING_OPTIONS.map((o) => (
                  <SelectItem key={o} value={o} className="text-xs capitalize">
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Models</label>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => void handleDiscover()} disabled={discovering}>
                {discovering ? "Finding…" : "Find models"}
              </Button>
              {discoverError && <span className="text-xs text-destructive">{discoverError}</span>}
            </div>

            {discovered.length > 0 && (
              <div className="space-y-2">
                <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {discovered.map((m) => (
                    <label key={m.id} className="flex cursor-pointer items-center gap-2 text-sm">
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
                  <Button size="sm" onClick={() => mergeModels([...picked])} disabled={picked.size === 0}>
                    Add selected ({picked.size})
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => mergeModels(discovered.map((d) => d.id))}
                    disabled={discovered.length === 0}
                  >
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

            {form.models.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {form.models.map((m) => (
                  <span
                    key={m.id}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                      m.id === form.model ? "border-foreground/40 bg-foreground/10" : "border-border",
                    )}
                  >
                    <button type="button" onClick={() => setForm({ ...form, model: m.id })}>
                      {m.label ?? m.id}
                    </button>
                    {m.id === form.model && (
                      <span className="text-[10px] text-muted-foreground">default</span>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRemoveModel(m.id)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Remove model"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => void handleTest()} disabled={testing}>
              {testing ? "Testing…" : "Test connection"}
            </Button>
            {testResult && (
              <span className={testResult.ok ? "text-xs text-success" : "text-xs text-destructive"}>
                {testResult.message}
              </span>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {mode === "edit" ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddProviderDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  return <ProviderDialog mode="add" provider={null} open={open} onOpenChange={onOpenChange} onSaved={onSaved} />;
}

export function EditProviderDialog({
  provider,
  onOpenChange,
  onSaved,
}: {
  provider: ProviderConfig | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  return (
    <ProviderDialog
      mode="edit"
      provider={provider}
      open={provider !== null}
      onOpenChange={onOpenChange}
      onSaved={onSaved}
    />
  );
}
