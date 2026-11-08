import { Fragment, type ReactNode } from "react";
import { Palette } from "lucide-react";
import type { FolderMenuEntry, SidebarMenuAction, SidebarMenuKit } from "../lib/menu-actions";
import { DEFAULT_FOLDER_COLOR, FOLDER_COLORS } from "../lib/folder-colors";

/**
 * Renders the shared action list into a dropdown or context menu.
 *
 * Both menu surfaces call this with the same list, which is what keeps the `⋯`
 * button and the right-click identical — not a convention, the same data.
 */
export function renderMenuActions(
  kit: Pick<SidebarMenuKit, "Item" | "Separator">,
  actions: SidebarMenuAction[],
): ReactNode {
  const { Item, Separator } = kit;
  return actions.map((action, index) => (
    <Fragment key={action.key}>
      {index > 0 && actions[index - 1].group !== action.group && <Separator />}
      <Item variant={action.destructive ? "destructive" : undefined} onSelect={action.onSelect}>
        {action.icon}
        {action.label}
      </Item>
    </Fragment>
  ));
}

/** Folder menu body, including the colour submenu at its documented position. */
export function renderFolderMenu(kit: SidebarMenuKit, entries: FolderMenuEntry[]): ReactNode {
  const { Item, Separator, Sub, SubTrigger, SubContent } = kit;
  return entries.map((entry, index) => {
    const group = entry.kind === "action" ? entry.action.group : entry.group;
    const previous = entries[index - 1];
    const previousGroup =
      previous === undefined
        ? group
        : previous.kind === "action"
          ? previous.action.group
          : previous.group;

    return (
      <Fragment key={entry.kind === "action" ? entry.action.key : entry.key}>
        {index > 0 && previousGroup !== group && <Separator />}
        {entry.kind === "action" ? (
          <Item
            variant={entry.action.destructive ? "destructive" : undefined}
            onSelect={entry.action.onSelect}
          >
            {entry.action.icon}
            {entry.action.label}
          </Item>
        ) : (
          <Sub>
            <SubTrigger>
              <Palette className="size-4" />
              {entry.label}
            </SubTrigger>
            <SubContent className="min-w-[12rem] p-2">
              <Item onSelect={() => entry.onPick(DEFAULT_FOLDER_COLOR)} className="gap-2">
                <span
                  aria-hidden
                  className="size-4 shrink-0 rounded border border-border"
                  style={{ backgroundColor: DEFAULT_FOLDER_COLOR }}
                />
                <span className="min-w-0 flex-1 truncate">Default</span>
                {entry.current === DEFAULT_FOLDER_COLOR && (
                  <span className="text-xs text-muted-foreground">✓</span>
                )}
              </Item>
              <Separator />
              <div className="grid grid-cols-6 gap-1">
                {FOLDER_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    title={color}
                    aria-label={color}
                    onClick={() => entry.onPick(color)}
                    className="size-5 cursor-pointer rounded-sm outline-none ring-offset-1 ring-offset-popover transition-[box-shadow,transform] duration-100 hover:scale-110 data-[active]:ring-2 data-[active]:ring-foreground/60"
                    data-active={entry.current === color ? "" : undefined}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </SubContent>
          </Sub>
        )}
      </Fragment>
    );
  });
}
