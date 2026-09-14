import { useCallback, useId, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { filterModelGroups, type ModelGroup } from "@/lib/model-groups";

interface ModelOptionListProps {
  groups: ModelGroup[];
  currentProviderId: string | undefined;
  currentModelId: string | undefined;
  onSelect: (providerId: string, modelId: string) => void;
  searchPlaceholder: string;
  searchAriaLabel: string;
  listAriaLabel: string;
  emptyLabel: string;
}

/**
 * Searchable model list for the composer model picker (Codeg
 * `ModelOptionList` structure, adapted: our provider lists are small so no
 * virtualizer — plain scroll, same keyboard contract: Up/Down/Home/End move
 * the cursor across options (skipping group headers), Enter selects).
 * All copy arrives via props (config-first); icons stay ours (Check only).
 */
export function ModelOptionList({
  groups,
  currentProviderId,
  currentModelId,
  onSelect,
  searchPlaceholder,
  searchAriaLabel,
  listAriaLabel,
  emptyLabel,
}: ModelOptionListProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const baseId = useId();
  const listId = `${baseId}-list`;

  const rows = useMemo(() => {
    const out: Array<
      | { kind: "header"; key: string; name: string }
      | { kind: "option"; key: string; providerId: string; modelId: string; label: string }
    > = [];
    for (const g of filterModelGroups(groups, query)) {
      out.push({ kind: "header", key: `h:${g.providerId}`, name: g.providerName });
      for (const m of g.models) {
        out.push({
          kind: "option",
          key: `${g.providerId}:${m.id}`,
          providerId: g.providerId,
          modelId: m.id,
          label: m.label ?? m.id,
        });
      }
    }
    return out;
  }, [groups, query]);

  const optionRowIndices = useMemo(
    () => rows.flatMap((row, index) => (row.kind === "option" ? [index] : [])),
    [rows],
  );
  // Reverse lookup (flat row index → keyboard option index) so each option
  // row resolves its cursor position during render without a counter.
  const optionIndexByRow = useMemo(() => {
    const map = new Map<number, number>();
    optionRowIndices.forEach((rowIndex, optionIndex) => map.set(rowIndex, optionIndex));
    return map;
  }, [optionRowIndices]);
  const optionCount = optionRowIndices.length;
  // Clamp on read so a shrinking filtered set can never leave the cursor
  // out of range (no setState-in-effect needed).
  const activeClamped = optionCount === 0 ? 0 : Math.min(activeIndex, optionCount - 1);

  const moveActiveTo = useCallback(
    (next: number) => {
      if (optionCount === 0) return;
      setActiveIndex(Math.max(0, Math.min(optionCount - 1, next)));
    },
    [optionCount],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // IME composition (CJK): Enter confirms the candidate, must not select.
      if ((event.nativeEvent as { isComposing?: boolean }).isComposing) return;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveActiveTo(activeClamped + 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveActiveTo(activeClamped - 1);
          break;
        case "Home":
          event.preventDefault();
          moveActiveTo(0);
          break;
        case "End":
          event.preventDefault();
          moveActiveTo(optionCount - 1);
          break;
        case "Enter": {
          const rowIndex = optionRowIndices[activeClamped];
          const row = rowIndex != null ? rows[rowIndex] : undefined;
          if (row && row.kind === "option") {
            event.preventDefault();
            onSelect(row.providerId, row.modelId);
          }
          break;
        }
        default:
          break;
      }
    },
    [activeClamped, moveActiveTo, onSelect, optionCount, optionRowIndices, rows],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-2">
        <input
          type="text"
          value={query}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={
            optionCount > 0 ? `${baseId}-opt-${activeClamped}` : undefined
          }
          aria-label={searchAriaLabel}
          placeholder={searchPlaceholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {optionCount === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto p-1">
          <div role="listbox" id={listId} aria-label={listAriaLabel}>
            {rows.map((row, flatIndex) => {
              if (row.kind === "header") {
                return (
                  <div
                    key={row.key}
                    role="presentation"
                    className="truncate px-2 pt-2 pb-0.5 text-xs font-medium text-muted-foreground"
                  >
                    {row.name}
                  </div>
                );
              }
              const optionIndex = optionIndexByRow.get(flatIndex) ?? 0;
              const selected =
                row.modelId === currentModelId &&
                row.providerId === currentProviderId;
              const active = optionIndex === activeClamped;
              return (
                <button
                  key={row.key}
                  type="button"
                  role="option"
                  id={`${baseId}-opt-${optionIndex}`}
                  aria-selected={selected}
                  title={row.label}
                  onMouseMove={() => setActiveIndex(optionIndex)}
                  onClick={() => onSelect(row.providerId, row.modelId)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    active && "bg-accent text-accent-foreground",
                    selected && !active && "bg-accent/60",
                  )}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                    {selected ? <Check aria-hidden="true" className="size-4" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
