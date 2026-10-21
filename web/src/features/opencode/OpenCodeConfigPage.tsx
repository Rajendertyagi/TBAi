import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  FileJson,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
} from "lucide-react";
import {
  SettingsPage,
  SettingsSection,
  SettingsError,
  SettingRow,
  SettingsSaveBar,
} from "@/components/shared/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  actionDescription,
  effectDescription,
  effectLabel,
  openCodeConfigCopy,
  openCodeConfigEffects,
} from "@/features/opencode/configCopy";
import {
  addOpenCodePermissionRule,
  fetchOpenCodeConfig,
  removeOpenCodePermissionRule,
  saveOpenCodePermissionEffect,
  toPermissionRules,
  type OpenCodeConfigSnapshot,
  type OpenCodePermissionEffect,
  type OpenCodePermissionRule,
} from "./openCodeConfig";
import { findPermissionOverride, type PermissionRuleLike } from "./permissionOverrides";
import { cn } from "@/lib/utils";

/**
 * The OpenCode Configuration settings page (`/opencode-config`).
 *
 * ## What this page is, and is not
 *
 * It is a READ-AND-EDIT view over the configuration OpenCode itself consumes.
 * It defines no policy: there is no default ruleset here, no ordering advice,
 * and no merge. A rule the user has not written is reported as absent, because
 * inventing a value for it would misrepresent what OpenCode will do.
 *
 * ## Why each rule is saved on its own
 *
 * There is one Save button per row rather than one for the page. That is a
 * direct consequence of the preservation requirement: the request carries a
 * single `(action, resource, effect)` triple, and the backend re-reads the file
 * and edits that one entry. A page-wide "apply my edited copy of the whole
 * ruleset" button would require shipping a ruleset TBAi authored, which is
 * exactly the shadow-policy failure this feature exists to avoid. The
 * alternative — a pending-changes buffer plus one Save — was rejected because it
 * reintroduces a full-ruleset payload for no benefit.
 *
 * ## The table is FILE-DRIVEN. There is no list of tools behind it.
 *
 * The reference app's permission screen shows a fixed roster — one row per tool,
 * each reading "Inherit (Allow)" or similar. That roster is a rendering of the
 * OLDER per-key config shape, where every tool is a key that is always present.
 * The V2 config this app reads is a flat ordered ARRAY of `{action, resource,
 * effect}` and has no such key to render, so "Inherit (Allow)" is not a value
 * that exists anywhere — it is the ABSENCE of a rule.
 *
 * So this page renders exactly the rules the file contains, and nothing else.
 * Nine today, twenty next month, the same code. A tool with no row is not
 * missing from the page's point of view — it is simply not configured, and
 * OpenCode decides it with its own default. The `addRule` form below is how a
 * rule for a new tool is created; it takes the action as free text, so a tool
 * added by a future OpenCode release needs no change here.
 *
 * The cost of that choice is stated on screen rather than papered over: the
 * section says plainly that it shows the file's rules, so "not listed" is never
 * mistaken for "OpenCode has no opinion about this".
 *
 * ## Ordering is displayed, never rewritten
 *
 * OpenCode resolves the array last-match-wins, so a rule's index is part of its
 * meaning. The page shows the index and does not offer to move rows, because a
 * reorder is a policy decision the reference implementation does not make on
 * the user's behalf either. A NEW rule is appended — the only position chosen on
 * the user's behalf — and the form says so, because "last" is the position that
 * overrides everything above it.
 */

/** The three effects a rule can be written as, in selector order. */
const EFFECT_VALUES = openCodeConfigEffects;

type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving"; readonly rule: OpenCodePermissionRule }
  | { readonly kind: "saved"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

/** The add-a-rule form's own state, kept apart from the effect-edit state. */
interface AddRuleState {
  readonly action: string;
  readonly resource: string;
  readonly effect: OpenCodePermissionEffect;
}

const EMPTY_ADD_RULE: AddRuleState = { action: "", resource: "*", effect: "ask" };

/** One effect selector bound to a single rule. */
function EffectSelect({
  value,
  disabled,
  onChange,
  label,
}: {
  value: OpenCodePermissionEffect;
  disabled: boolean;
  onChange: (effect: OpenCodePermissionEffect) => void;
  label: string;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as OpenCodePermissionEffect)}
    >
      <SelectTrigger className="h-8 w-[9.5rem] text-xs" aria-label={`${label} effect`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {EFFECT_VALUES.map((effect) => (
          <SelectItem key={effect} value={effect} className="text-xs">
            <span className="font-medium">{effectLabel[effect]}</span>
            <span className="ml-2 text-muted-foreground">{effectDescription[effect]}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The native JSON view: the file's structure with every credential masked.
 *
 * A file that could not be parsed has no structure to redact, so its text is
 * withheld rather than shown unredacted.
 */
function NativeJson({ raw, malformed }: { raw: string; malformed: boolean }) {
  if (malformed) {
    return <p className="text-xs text-muted-foreground">{openCodeConfigCopy.json.withheld}</p>;
  }
  if (raw.trim().length === 0) {
    return <p className="text-xs text-muted-foreground">{openCodeConfigCopy.json.empty}</p>;
  }
  return (
    <pre className="max-h-[26rem] overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-[11px] leading-5">
      <code>{raw}</code>
    </pre>
  );
}

/**
 * The add-a-rule form.
 *
 * The action field is FREE TEXT with a datalist of the actions already present
 * in the file, and that is deliberate. A datalist is autocomplete, not a
 * contract: it cannot prevent typing a tool this OpenCode release has never
 * heard of, which is exactly what has to keep working. A fixed roster of
 * fifteen known tools would be the opposite — a list to maintain, that goes
 * stale, and that cannot express a tool added next month.
 *
 * The position consequence is printed under the button, not buried: the rule
 * goes last, and last wins.
 */
function AddRuleForm({
  existingActions,
  busy,
  disabled,
  onAdd,
}: {
  existingActions: readonly string[];
  busy: boolean;
  disabled: boolean;
  onAdd: (rule: OpenCodePermissionRule) => void;
}) {
  const [draft, setDraft] = useState<AddRuleState>(EMPTY_ADD_RULE);
  const copy = openCodeConfigCopy.add;
  const actionTrimmed = draft.action.trim();
  const resourceTrimmed = draft.resource.trim();
  const ready = actionTrimmed.length > 0 && resourceTrimmed.length > 0 && !busy && !disabled;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
      <div>
        <p className="text-sm font-medium">{copy.title}</p>
        <p className="text-xs leading-5 text-muted-foreground">{copy.description}</p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem]">
        <div className="space-y-1">
          <label htmlFor="opencode-new-action" className="text-[11px] text-muted-foreground">
            {copy.action}
          </label>
          <Input
            id="opencode-new-action"
            list="opencode-known-actions"
            value={draft.action}
            disabled={disabled}
            placeholder="question"
            className="h-8 text-xs"
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="opencode-new-resource" className="text-[11px] text-muted-foreground">
            {copy.resource}
          </label>
          <Input
            id="opencode-new-resource"
            value={draft.resource}
            disabled={disabled}
            placeholder="*"
            className="h-8 font-mono text-xs"
            onChange={(event) => setDraft({ ...draft, resource: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">{copy.effect}</span>
          <EffectSelect
            value={draft.effect}
            disabled={disabled}
            label="new rule effect"
            onChange={(effect) => setDraft({ ...draft, effect })}
          />
        </div>
      </div>
      {existingActions.length > 0 && (
        <datalist id="opencode-known-actions">
          {existingActions.map((action) => (
            <option key={action} value={action} />
          ))}
        </datalist>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!ready}
          onClick={() => {
            onAdd({
              action: actionTrimmed,
              resource: resourceTrimmed,
              effect: draft.effect,
            });
            setDraft(EMPTY_ADD_RULE);
          }}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {busy ? copy.submitting : copy.submit}
        </Button>
        <span className="text-[11px] text-muted-foreground">{copy.position}</span>
      </div>
    </div>
  );
}

export function OpenCodeConfigPage() {
  const [snapshot, setSnapshot] = useState<OpenCodeConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [addState, setAddState] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "busy" }
    | { readonly kind: "error"; readonly message: string }
    | { readonly kind: "done"; readonly message: string }
  >({ kind: "idle" });
  const [removingIndex, setRemovingIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setSnapshot(await fetchOpenCodeConfig());
    } catch (error) {
      setSnapshot(null);
      setLoadError(error instanceof Error ? error.message : "Failed to read configuration");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rules = useMemo(() => toPermissionRules(snapshot?.permissions ?? null), [snapshot]);
  /**
   * The readable rules in the FILE's order, indexed by the file's own
   * positions.
   *
   * The override relation has to be computed over the order OpenCode
   * resolves — the file's array — because that is the order that decides
   * which rule wins. A rule the page could not read still occupies its place
   * there, so it is a hole in this array rather than a missing entry: the
   * relation is not shifted by it, and the row number an override notice
   * names is the file's row number.
   */
  const fileRules = useMemo(() => {
    const byFileIndex: (PermissionRuleLike | undefined)[] = [];
    for (const row of rules.rules) byFileIndex[row.index] = row.rule;
    return byFileIndex;
  }, [rules]);
  /**
   * The single uncommitted edit, held as the rule's POSITION in the file plus
   * the full target rule.
   *
   * The position is what makes two identical rules independently editable: with
   * the `(action, resource)` pair alone, a configuration holding the same pair
   * twice gives both rows the same identity, and the edit would land on
   * whichever one the backend happened to find first.
   *
   * Holding the whole rule as well is what makes the write safe: the backend
   * re-checks the identity at that position before writing, so a rule that
   * moved or changed since the page read it is refused rather than edited.
   */
  const [pending, setPending] = useState<{
    readonly index: number;
    readonly rule: OpenCodePermissionRule;
  } | null>(null);

  const save = useCallback(async () => {
    if (!pending) return;
    setSaveState({ kind: "saving", rule: pending.rule });
    try {
      const result = await saveOpenCodePermissionEffect(
        pending.index,
        pending.rule,
        pending.rule.effect,
      );
      setPending(null);
      setSaveState({
        kind: "saved",
        message: result.changed ? openCodeConfigCopy.save.saved : openCodeConfigCopy.save.unchanged,
      });
      // Re-read so the page shows what is actually on disk, including any
      // field the write preserved that this page does not model.
      await load();
    } catch (error) {
      setPending(null);
      setSaveState({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to save the change",
      });
    }
  }, [load, pending]);

  const saving = saveState.kind === "saving";
  const adding = addState.kind === "busy";
  const editable = snapshot?.editable === true && !saving && !adding;

  /**
   * Actions already present in the file, for the add form's autocomplete.
   *
   * Derived from the file rather than a constant, which is what keeps this
   * list honest: it can only ever suggest what the user actually has.
   */
  const existingActions = useMemo(
    () => [...new Set(rules.rules.map((row) => row.rule.action))].sort(),
    [rules],
  );

  const addRule = useCallback(
    async (rule: OpenCodePermissionRule) => {
      setAddState({ kind: "busy" });
      try {
        await addOpenCodePermissionRule(rule);
        setAddState({ kind: "done", message: openCodeConfigCopy.add.added });
        await load();
      } catch (error) {
        setAddState({
          kind: "error",
          message: error instanceof Error ? error.message : "Failed to add the rule",
        });
      }
    },
    [load],
  );

  const removeRule = useCallback(
    async (index: number, rule: OpenCodePermissionRule) => {
      setRemovingIndex(index);
      setAddState({ kind: "idle" });
      try {
        await removeOpenCodePermissionRule(index, rule);
        setAddState({ kind: "done", message: openCodeConfigCopy.remove.removed });
        await load();
      } catch (error) {
        setAddState({
          kind: "error",
          message: error instanceof Error ? error.message : "Failed to remove the rule",
        });
      } finally {
        setRemovingIndex(null);
      }
    },
    [load],
  );

  return (
    <SettingsPage
      title={openCodeConfigCopy.page.title}
      description={openCodeConfigCopy.page.description}
      actions={
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void load()}
          disabled={loading || saving}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden="true" />
          )}
          Reload
        </Button>
      }
    >
      {loadError && <SettingsError>{loadError}</SettingsError>}

      {!snapshot && loading && (
        <p className="text-xs text-muted-foreground">{openCodeConfigCopy.states.loading}</p>
      )}

      {snapshot && (
        <>
          <SettingsSection
            title={openCodeConfigCopy.sections.source}
            icon={FileJson}
            description={openCodeConfigCopy.source.description}
          >
            <SettingRow
              label={openCodeConfigCopy.source.active}
              icon={ChevronRight}
              description={snapshot.path || "—"}
            />
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {openCodeConfigCopy.source.discovered}
              </p>
              <ul className="space-y-0.5">
                {snapshot.discoveredPaths.map((path) => (
                  <li
                    key={path}
                    className={cn(
                      "truncate font-mono text-[11px]",
                      path === snapshot.path ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {path}
                  </li>
                ))}
              </ul>
            </div>
          </SettingsSection>

          <SettingsSection
            title={openCodeConfigCopy.sections.permissions}
            icon={Shield}
            description={openCodeConfigCopy.permissions.description}
          >
            <p className="text-xs leading-5 text-muted-foreground">
              {openCodeConfigCopy.permissions.fileDriven}
            </p>
            {snapshot.malformed && (
              <SettingsError>{openCodeConfigCopy.states.malformed}</SettingsError>
            )}
            {rules.skipped > 0 && (
              <SettingsError>{openCodeConfigCopy.permissions.skipped(rules.skipped)}</SettingsError>
            )}
            {snapshot.permissions === null && (
              <p className="text-xs text-muted-foreground">
                {openCodeConfigCopy.permissions.noKey}
              </p>
            )}
            {snapshot.permissions !== null && rules.rules.length === 0 && rules.skipped === 0 && (
              <p className="text-xs text-muted-foreground">
                {openCodeConfigCopy.permissions.empty}
              </p>
            )}

            {rules.rules.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)_10rem] items-center gap-3 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                  <span>{openCodeConfigCopy.labels.order}</span>
                  <span>{openCodeConfigCopy.labels.action}</span>
                  <span>{openCodeConfigCopy.labels.resource}</span>
                  <span>{openCodeConfigCopy.permissions.effect}</span>
                </div>
                {rules.rules.map((row, position) => {
                  const { rule, index } = row;
                  // Identity is the rule's POSITION in the file, not its
                  // (action, resource) pair: OpenCode resolves the array
                  // last-match-wins, so a configuration holding the same pair
                  // twice has two distinct rules, and only their positions
                  // tell them apart. The backend re-checks the identity at
                  // that position before writing.
                  const isPending = pending !== null && pending.index === index;
                  // The row number the page shows is the rule's position in
                  // the FILE, so it names the same row the override notice
                  // names even when a rule the page cannot read sits between
                  // them. The position in the rendered list is only used for
                  // the alternating row shading.
                  const fileRow = index + 1;
                  const override = findPermissionOverride(fileRules, index);
                  return (
                    <div
                      key={index}
                      className={cn(
                        "grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)_10rem] items-center gap-3 px-3 py-2 text-xs",
                        position % 2 === 1 && "bg-muted/30",
                        isPending && "bg-accent/10",
                      )}
                    >
                      <span className="tabular-nums text-muted-foreground">{fileRow}</span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{rule.action}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {actionDescription(rule.action)}
                        </span>
                      </span>
                      <span className="min-w-0">
                        <span
                          className="block truncate font-mono text-[11px]"
                          title={rule.resource}
                        >
                          {rule.resource}
                        </span>
                        {override.kind !== "none" && (
                          <span
                            className="block truncate text-[10px] text-amber-600 dark:text-amber-400"
                            title={openCodeConfigCopy.permissions.overrideTitle(
                              override.kind,
                              override.byIndex + 1,
                            )}
                          >
                            {openCodeConfigCopy.permissions.override(
                              override.kind,
                              override.byIndex + 1,
                            )}
                          </span>
                        )}
                      </span>
                      <div className="flex items-center justify-end gap-1.5">
                        <EffectSelect
                          value={isPending && pending ? pending.rule.effect : rule.effect}
                          disabled={!editable}
                          // The row number is part of the name: a configuration
                          // may hold the same (action, resource) pair twice, and
                          // two controls with the same name would be
                          // indistinguishable to a person using a screen reader
                          // and to a test.
                          label={`${rule.action} ${rule.resource} effect (rule ${fileRow})`}
                          onChange={(effect) => {
                            setSaveState({ kind: "idle" });
                            // Selecting the effect already on disk clears the
                            // pending edit rather than staging a no-op, so Save
                            // is never enabled for a change that writes nothing.
                            setPending(
                              effect === rule.effect ? null : { index, rule: { ...rule, effect } },
                            );
                          }}
                        />
                        {isPending && (
                          <span className="text-[10px] text-muted-foreground">
                            {openCodeConfigCopy.save.dirty}
                          </span>
                        )}
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          disabled={!editable || removingIndex !== null}
                          title={openCodeConfigCopy.remove.label}
                          aria-label={`Remove rule ${rule.action} ${rule.resource} (row ${fileRow})`}
                          onClick={() => {
                            // A removal is destructive and immediately written,
                            // so it is confirmed. The message names the rule and
                            // states that the rest keep their positions, which
                            // is the part a user is actually worried about.
                            if (
                              !window.confirm(
                                openCodeConfigCopy.remove.confirm(
                                  `${rule.action} · ${rule.resource}`,
                                ),
                              )
                            ) {
                              return;
                            }
                            void removeRule(index, rule);
                          }}
                        >
                          {removingIndex === index ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <SettingsSaveBar
              onSave={() => void save()}
              saving={saving}
              disabled={!pending || !editable}
              label={openCodeConfigCopy.save.idle}
              savingLabel={openCodeConfigCopy.save.saving}
            />

            {saveState.kind === "saved" && (
              <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Check className="size-3.5" aria-hidden="true" />
                {saveState.message}
              </p>
            )}
            {saveState.kind === "error" && <SettingsError>{saveState.message}</SettingsError>}

            <AddRuleForm
              existingActions={existingActions}
              busy={adding}
              disabled={!editable}
              onAdd={(rule) => void addRule(rule)}
            />

            {addState.kind === "done" && (
              <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Check className="size-3.5" aria-hidden="true" />
                {addState.message}
                {rules.rules.length === 0 && <span>{openCodeConfigCopy.remove.backToDefault}</span>}
              </p>
            )}
            {addState.kind === "error" && <SettingsError>{addState.message}</SettingsError>}
          </SettingsSection>

          <SettingsSection
            title={openCodeConfigCopy.sections.json}
            icon={FileJson}
            description={openCodeConfigCopy.json.description}
          >
            <NativeJson raw={snapshot.raw} malformed={snapshot.malformed} />
          </SettingsSection>

          {!snapshot.malformed && (
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <AlertCircle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              {openCodeConfigCopy.source.description}
            </p>
          )}
        </>
      )}
    </SettingsPage>
  );
}
