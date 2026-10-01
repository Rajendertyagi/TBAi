import { useEffect, useState } from "react";
import { Circle, Plus } from "lucide-react";
import { useMemoryStore } from "../stores";
import { Button, Textarea } from "./ui";
import { Trash2, Pencil } from "lucide-react";
import { SettingRow, SettingsPage, SettingsSection } from "./shared/settings";

/**
 * Plain-language names for the four Phase 5 screening classes.
 *
 * The server sends a stable token, never the pattern source, so this table is the
 * only place the wording lives. `unknown` covers a class added server-side before
 * this table learns about it — the memory is still withheld, only the label lags.
 */
const SAFETY_REASON_TEXT: Record<string, string> = {
  instruction_displacement: "tries to override instructions",
  turn_structure: "looks like it is trying to fake a speaker",
  credential_request: "asks for credentials or secrets",
  secret_material: "looks like it contains a credential",
};

/**
 * The sentence shown under a memory the server withheld from model context.
 *
 * Exported so the wording can be tested directly. That is not a convenience: the
 * repo has no DOM test runner, and `renderToStaticMarkup` reads zustand's SERVER
 * snapshot — so a component test cannot populate the store and then assert on
 * what the populated component renders (see `stalePermissionsStore.test.ts`, which
 * documents the same limitation). Testing this function is therefore how the
 * display is actually pinned, and the component is verified by rendering the
 * store-independent parts.
 *
 * Returns `null` for a memory that screened clean, so the caller renders nothing.
 */
export function memoryStatusLine(memory: { safetyFlag?: true; safetyReason?: string }): string | null {
  if (!memory.safetyFlag) return null;
  const why = SAFETY_REASON_TEXT[memory.safetyReason ?? ""] ?? "did not pass a safety check";
  return `Not sent to the model — this memory ${why}. You can edit or delete it.`;
}

/**
 * Memory settings (`/memory): long-term memories persisted across
 * conversations.
 *
 * Phase 5 additions, both confined to this existing panel:
 *
 * - **Edit**, for correcting a memory the user wrote. With D4 approved there is a
 *   `PATCH` endpoint, and a memory that can be created and deleted but not
 *   corrected is a trap.
 * - **Derived safety status**, via {@link memoryStatusLine}. The browser never
 *   re-runs the screen, so the panel cannot disagree with the backend about what
 *   was withheld.
 *
 * No new route, dialog, page or primitive: this is the same row, extended.
 */
export function MemoryPanel() {
  const { memories, newMemory, setNewMemory, loadMemories, addMemory, updateMemory, deleteMemory } =
    useMemoryStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  function startEdit(id: string, content: string) {
    setEditingId(id);
    setEditingContent(content);
  }

  async function commitEdit(id: string) {
    await updateMemory(id, editingContent);
    setEditingId(null);
    setEditingContent("");
  }

  return (
    <SettingsPage
      title="Memory"
      description="Store important information that persists across conversations."
      actions={
        <Button
          size="sm"
          onClick={() => addMemory(newMemory)}
          disabled={!newMemory.trim()}
        >
          <Plus className="w-3 h-3 mr-1" />
          Add
        </Button>
      }
    >
      <SettingsSection
        title="Saved memories"
        icon={Circle}
        description={memories.length === 0 ? "No memories yet." : `${memories.length} saved`}
      >
        <div className="space-y-2">
          {memories.map((memory) => (
            <div key={memory.id} className="flex items-start justify-between gap-2 rounded-md border border-border bg-muted/30 p-3">
              <div className="min-w-0 flex-1">
                {editingId === memory.id ? (
                  <div className="space-y-2">
                    <Textarea
                      value={editingContent}
                      onChange={(e) => setEditingContent(e.target.value)}
                      rows={3}
                      aria-label="Edit memory"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => commitEdit(memory.id)} disabled={!editingContent.trim()}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm">{memory.content}</p>
                    {memoryStatusLine(memory) ? (
                      // The memory is stored and editable; it is simply not sent to
                      // the model. Stating both halves is the honest description.
                      <p className="mt-1 text-xs text-muted-foreground">{memoryStatusLine(memory)}</p>
                    ) : null}
                  </>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                {editingId === memory.id ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => startEdit(memory.id, memory.content)}
                    aria-label="Edit memory"
                  >
                    <Pencil className="w-3 h-3" />
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => deleteMemory(memory.id)} aria-label="Delete memory">
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection title="Add a memory">
        <SettingRow label="New memory">
          <Textarea
            value={newMemory}
            onChange={(e) => setNewMemory(e.target.value)}
            placeholder="Add a memory..."
            rows={3}
          />
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}