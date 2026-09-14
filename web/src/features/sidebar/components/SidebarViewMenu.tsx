import { Eye, MessagesSquare } from "lucide-react";
import { useAui } from "@assistant-ui/react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sidebarConfig } from "@/config/sidebar";
import { useDesktopLayout } from "@/features/desktop/state/desktopLayout";
import { reloadThreadList } from "@/features/sidebar/hooks/useThreadListQuerySync";
import { SidebarSectionOrderControl } from "@/features/sidebar/components/SidebarSectionOrderControl";

/**
 * The sidebar's view-options (eye) menu: list toggles → sort mode → section
 * order. A settings panel, not a command list — options keep the menu open on
 * select. Sort changes propagate to the server (`?order=`) with a reload.
 */
export function SidebarViewMenu() {
  const copy = sidebarConfig.copy;
  const aui = useAui();
  const showRecent = useDesktopLayout((s) => s.showRecent);
  const setShowRecent = useDesktopLayout((s) => s.setShowRecent);
  const showCompleted = useDesktopLayout((s) => s.showCompleted);
  const setShowCompleted = useDesktopLayout((s) => s.setShowCompleted);
  const sidebarSort = useDesktopLayout((s) => s.sidebarSort);
  const setSidebarSort = useDesktopLayout((s) => s.setSidebarSort);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={copy.viewOptions}
          aria-label={copy.viewOptions}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <Eye aria-hidden="true" className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <MessagesSquare className="text-muted-foreground" />
            {copy.listOptions}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuCheckboxItem
              checked={showRecent}
              onCheckedChange={setShowRecent}
              onSelect={(event) => event.preventDefault()}
            >
              {copy.showRecent}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={showCompleted}
              onCheckedChange={setShowCompleted}
              onSelect={(event) => event.preventDefault()}
            >
              {copy.showCompleted}
            </DropdownMenuCheckboxItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{copy.sortBy}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sidebarSort}
            onValueChange={(value) => {
              const sort = value === "created" ? "created" : "updated";
              setSidebarSort(sort);
              // The store effect also syncs; reload here for immediacy.
              reloadThreadList(aui);
            }}
          >
            <DropdownMenuRadioItem
              value="updated"
              onSelect={(event) => event.preventDefault()}
            >
              {copy.sortByUpdated}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem
              value="created"
              onSelect={(event) => event.preventDefault()}
            >
              {copy.sortByCreated}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{copy.sectionOrder}</DropdownMenuLabel>
          <SidebarSectionOrderControl />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
