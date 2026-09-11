import { useEffect } from "react";
import { Circle, Plus } from "lucide-react";
import { useMemoryStore } from "../stores";
import { Button, Textarea } from "./ui";
import { Trash2 } from "lucide-react";
import { SettingRow, SettingsPage, SettingsSection } from "./shared/settings";

/**
 * Memory settings (`/memory`): long-term memories persisted across
 * conversations. Thin grammar wrapper over the memory store; behavior
 * unchanged.
 */
export function MemoryPanel() {
  const { memories, newMemory, setNewMemory, loadMemories, addMemory, deleteMemory } = useMemoryStore();

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

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
              <p className="min-w-0 flex-1 text-sm">{memory.content}</p>
              <Button size="sm" variant="ghost" onClick={() => deleteMemory(memory.id)} aria-label="Delete memory">
                <Trash2 className="w-3 h-3" />
              </Button>
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
