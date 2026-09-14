import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useSettingsStore } from "@/stores";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ProviderConfig } from "@/types";
import { AddProviderDialog, EditProviderDialog } from "./ProviderDialog";

const TYPE_FILTER_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google Gemini" },
  { value: "ollama", label: "Ollama" },
  { value: "custom", label: "Custom" },
];

/**
 * Providers settings (`/providers`): model providers, endpoints, credentials
 * (keys stay backend-encrypted; the browser never sees them), default models
 * and thinking levels. Add/edit live in dialogs; the list stays mounted.
 */
export function ProvidersPage() {
  const { providers, loadProviders } = useSettingsStore();
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProviderConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadProviders()
      .catch(() => toast.error("Could not load providers."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleProviders = useMemo(
    () => (typeFilter === "all" ? providers : providers.filter((p) => p.type === typeFilter)),
    [providers, typeFilter],
  );

  const handleSetActive = async (id: string) => {
    try {
      const res = await fetch(`/api/providers/${id}/set-active`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error || `Could not activate (HTTP ${res.status}).`);
        return;
      }
      await loadProviders();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not activate.");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/providers/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error || `Could not delete (HTTP ${res.status}).`);
        return;
      }
      toast.success("Provider deleted");
      setDeleteTarget(null);
      await loadProviders();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <section className="space-y-3 px-3 pt-3 md:px-4 md:pt-4">
        <div>
          <h1 className="text-sm font-semibold">Providers</h1>
          <p className="text-sm text-muted-foreground">
            Model providers, endpoints, and credentials. API keys are encrypted on the
            server and never shown here.
          </p>
        </div>
      </section>

      <section className="mt-4 space-y-2 px-3 pb-3 md:px-4 md:pb-4">
        <div className="flex items-center justify-between gap-2">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-8 w-40 text-xs" aria-label="Filter providers by type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPE_FILTER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8 text-xs" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : visibleProviders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Server className="mb-2 h-8 w-8 opacity-40" />
            <span className="text-xs">
              {providers.length === 0
                ? "No providers yet. Add one to start chatting."
                : "No providers match this filter."}
            </span>
          </div>
        ) : (
          <div className="space-y-2">
            {visibleProviders.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{provider.name}</span>
                      {provider.isActive && (
                        <Badge className="border-transparent bg-foreground px-1.5 text-background">
                          Active
                        </Badge>
                      )}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {provider.models?.length ? `${provider.models.length} model(s)` : provider.model}
                      {provider.endpoint && ` · ${provider.endpoint}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
                      {provider.type}
                    </Badge>
                    {provider.credentialConfigured ? (
                      <Badge variant="secondary" className="px-1.5 py-0 text-3xs text-success">
                        Key
                      </Badge>
                    ) : (
                      provider.type !== "ollama" && (
                        <Badge variant="secondary" className="px-1.5 py-0 text-3xs text-warning">
                          No key
                        </Badge>
                      )
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  {!provider.isActive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Set ${provider.name} active`}
                      onClick={() => void handleSetActive(provider.id)}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label={`Edit ${provider.name}`}
                    onClick={() => setEditTarget(provider)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    aria-label={`Delete ${provider.name}`}
                    onClick={() => setDeleteTarget({ id: provider.id, name: provider.name })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <AddProviderDialog open={addOpen} onOpenChange={setAddOpen} onSaved={() => {}} />

      <EditProviderDialog
        provider={editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        onSaved={() => {}}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="max-w-xs gap-6 rounded-4xl border-0 shadow-2xl ring-1 ring-border sm:max-w-md">
          <AlertDialogHeader className="items-center text-center sm:items-start sm:text-left">
            <AlertDialogTitle className="text-lg font-medium">Delete provider?</AlertDialogTitle>
            <AlertDialogDescription>
              {`This will permanently delete "${deleteTarget?.name ?? ""}" and its stored credential. Providers still used by conversations cannot be deleted.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
              disabled={deleting}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
