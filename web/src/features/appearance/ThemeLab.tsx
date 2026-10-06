"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  Copy,
  Info,
  TriangleAlert,
  X,
} from "lucide-react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { CARD_SURFACE } from "@/components/shared/approval-card";
import { cn } from "@/lib/utils";

/**
 * DEV-ONLY diagnostic page. Reachable at `#/theme-lab` in a dev build only —
 * `router.tsx` adds the route behind `import.meta.env.DEV`, so it is compiled
 * out of production.
 *
 * WHY THIS EXISTS. The theme system was verified by screenshotting the welcome
 * screen across 22 combinations. Every other surface — menus, popovers, selects,
 * dialogs, toasts, markdown, code blocks, tool cards, hover and selected rows —
 * had never been rendered under any palette. That is a real gap: a colour mapping
 * can resolve every token without error and still render badly, because "no
 * error" and "readable" are different claims.
 *
 * This page puts every one of those surfaces on screen at once so a palette can
 * be judged against all of them instead of one lucky route.
 *
 * Each specimen carries a `data-lab` attribute naming what it is. That name is
 * the contract with `scripts/theme-audit.mjs`, which walks the rendered DOM,
 * computes each element's real foreground against its real composited
 * background, and reports failures keyed by that name. Without a stable label
 * per element the report can only say "something on this theme is unreadable",
 * which is not actionable.
 *
 * This is a measuring instrument, not a design. It is not linked from any
 * navigation and nothing in the app imports it.
 */

function Specimen({
  name,
  label,
  children,
  className,
}: {
  name: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-3xs text-muted-foreground">{label}</div>
      <div data-lab={name} className={cn("min-w-0", className)}>
        {children}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border/60 p-5 last:border-b-0">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

/**
 * Markdown rendered with the SAME class strings `markdown-text.tsx` uses, so the
 * audit measures the styling the app really ships rather than an idealised copy
 * that could drift from it.
 */
function MarkdownSpecimen() {
  return (
    <div className="max-w-3xl space-y-1 text-sm">
      <p data-lab="md/paragraph" className="aui-md-p my-3 leading-relaxed">
        Body copy in a reply, with a{" "}
        <a data-lab="md/link" className="aui-md-a text-link hover:text-link-hover underline underline-offset-2" href="#">
          primary link
        </a>{" "}
        and some <strong data-lab="md/strong" className="aui-md-strong font-semibold">bold text</strong>.
      </p>
      <p className="my-3 leading-relaxed">
        Inline <code data-lab="md/inline-code" className="aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]">codeToken()</code>{" "}
        inside a sentence.
      </p>
      <div data-lab="md/code-block" className="aui-md-pre border-border/50 bg-muted/30 overflow-x-auto rounded-xl border p-3.5 text-[13px] leading-relaxed">
        <div className="aui-code-header-root border-border/50 bg-muted/50 -mt-3.5 -mb-3.5 mb-0 flex items-center justify-between rounded-t-xl border border-b-0 px-3.5 py-1.5">
          <span className="aui-code-header-language text-muted-foreground font-medium lowercase">typescript</span>
          <Copy className="size-3.5" />
        </div>
        <pre className="mt-2 overflow-x-auto">
          <code>{"const theme = resolveThemeVars(theme, variant);"}</code>
        </pre>
      </div>
      <blockquote data-lab="md/blockquote" className="aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-3 border-s-2 ps-4">
        A blockquote, which uses muted text and a muted left rule.
      </blockquote>
      <ul data-lab="md/list" className="aui-md-ul marker:text-muted-foreground my-3 ms-5 list-disc">
        <li className="aui-md-li leading-relaxed">A list item</li>
        <li className="aui-md-li leading-relaxed">Another item</li>
      </ul>
      <table className="aui-md-table my-3 w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <th data-lab="md/table-head" className="aui-md-th bg-muted px-3 py-1.5 text-start font-medium">Column</th>
            <th className="aui-md-th bg-muted px-3 py-1.5 text-start font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-lab="md/table-cell" className="aui-md-td border-muted-foreground/20 border-s border-b px-3 py-1.5">theme</td>
            <td className="aui-md-td border-muted-foreground/20 border-s border-b px-3 py-1.5">openchamber</td>
          </tr>
        </tbody>
      </table>
      <hr data-lab="md/hr" className="aui-md-hr border-muted-foreground/20 my-3" />
    </div>
  );
}

export function ThemeLab() {
  const [switchOn, setSwitchOn] = useState(true);
  const [selectValue, setSelectValue] = useState("openchamber");

  return (
    <div className="mx-auto h-full w-full max-w-5xl overflow-y-auto pb-24">
      <header className="border-b border-border p-5">
        <h1 className="text-base font-semibold">Theme lab</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Diagnostic only. Every themed surface TBAi can draw, so a palette can be
          judged against all of them instead of one route.
        </p>
      </header>

      <Section title="Text on background">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Specimen name="text/default" label="foreground"><span className="text-foreground">Default body text</span></Specimen>
          <Specimen name="text/muted" label="muted-foreground"><span className="text-muted-foreground">Secondary text</span></Specimen>
          <Specimen name="text/primary" label="primary"><span className="text-primary">Primary / accent</span></Specimen>
          <Specimen name="text/success" label="success"><span className="text-success">Success text</span></Specimen>
          <Specimen name="text/warning" label="warning"><span className="text-warning">Warning text</span></Specimen>
          <Specimen name="text/destructive" label="destructive"><span className="text-destructive">Destructive text</span></Specimen>
        </div>
      </Section>

      <Section title="Surfaces">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Specimen name="surface/background" label="background" className="rounded-lg bg-background p-3 text-foreground">Aa</Specimen>
          <Specimen name="surface/card" label="card / elevated" className="rounded-lg bg-card p-3 text-card-foreground">Aa</Specimen>
          <Specimen name="surface/muted" label="muted / secondary" className="rounded-lg bg-muted p-3 text-foreground">Aa</Specimen>
          <Specimen name="surface/accent" label="accent (hover/selected)" className="rounded-lg bg-accent p-3 text-accent-foreground">Aa</Specimen>
          <Specimen name="surface/sidebar" label="sidebar" className="rounded-lg bg-sidebar p-3 text-sidebar-foreground">Aa</Specimen>
          <Specimen name="surface/statusbar" label="statusbar" className="rounded-lg bg-statusbar p-3 text-foreground">Aa</Specimen>
          <Specimen name="surface/popover" label="popover (glass)" className="glass-surface rounded-lg p-3 text-popover-foreground shadow-floating">Aa</Specimen>
          <Specimen name="surface/disabled" label="disabled / opacity" className="rounded-lg bg-muted p-3 text-muted-foreground opacity-50">Aa</Specimen>
        </div>
      </Section>

      <Section title="Borders, rings and the borderless card">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Specimen name="border/default" label="border" className="rounded-lg border border-border p-3 text-foreground">Aa</Specimen>
          <Specimen name="border/strong" label="border-hover" className="rounded-lg border-2 border-border p-3 text-foreground">Aa</Specimen>
          <Specimen name="ring/focus" label="focus ring" className="rounded-lg bg-background p-3 text-foreground ring-2 ring-ring">Aa</Specimen>
          <Specimen name="border/input" label="input" className="rounded-lg border border-input bg-background p-3 text-foreground">Aa</Specimen>
        </div>
        <Specimen name="card/tool" label="tool / permission card (card-soft + card-outline)">
          <div className={cn("max-w-3xl space-y-2 p-5 text-sm", CARD_SURFACE)}>
            <div className="font-medium text-foreground">Run command</div>
            <p className="text-muted-foreground">Approve this tool call to continue.</p>
            <div className="mt-4 flex gap-2 border-t border-border pt-3">
              <Button size="sm"><Check className="size-3.5" /> Approve</Button>
              <Button size="sm" variant="secondary"><X className="size-3.5" /> Deny</Button>
            </div>
          </div>
        </Specimen>
      </Section>

      <Section title="Rows: hover, selected, focus">
        <div className="max-w-sm overflow-hidden rounded-lg border border-border">
          <div data-lab="row/rest" className="bg-popover px-3 py-2 text-popover-foreground">Resting row</div>
          <div data-lab="row/hover" className="bg-accent px-3 py-2 text-accent-foreground">Hovered row (accent)</div>
          <div data-lab="row/selected" className="bg-accent px-3 py-2 font-medium text-accent-foreground">Selected row (accent)</div>
          <div data-lab="row/focused" className="bg-popover px-3 py-2 text-popover-foreground ring-2 ring-inset ring-ring">Focused row</div>
          <div data-lab="row/destructive" className="bg-popover px-3 py-2 text-destructive">Destructive row</div>
          <div data-lab="row/separator" className="bg-popover"><div className="my-2 h-px bg-border" /></div>
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Specimen name="btn/default" label="default"><Button>Send</Button></Specimen>
          <Specimen name="btn/secondary" label="secondary"><Button variant="secondary">Secondary</Button></Specimen>
          <Specimen name="btn/outline" label="outline"><Button variant="outline">Outline</Button></Specimen>
          <Specimen name="btn/ghost" label="ghost"><Button variant="ghost">Ghost</Button></Specimen>
          <Specimen name="btn/destructive" label="destructive"><Button variant="destructive">Delete</Button></Specimen>
          <Specimen name="btn/link" label="link"><Button variant="link">Link</Button></Specimen>
          <Specimen name="md/link-inline" label="link on card"><a className="text-link underline underline-offset-2" href="#">Link</a></Specimen>
          <Specimen name="btn/disabled" label="disabled"><Button disabled>Disabled</Button></Specimen>
          <Specimen name="btn/small" label="small"><Button size="sm">Small</Button></Specimen>
        </div>
      </Section>

      <Section title="Badges">
        <div className="flex flex-wrap items-center gap-2">
          <Specimen name="badge/default" label="default"><Badge>Default</Badge></Specimen>
          <Specimen name="badge/secondary" label="secondary"><Badge variant="secondary">Secondary</Badge></Specimen>
          <Specimen name="badge/outline" label="outline"><Badge variant="outline">Outline</Badge></Specimen>
          <Specimen name="badge/destructive" label="destructive"><Badge variant="destructive">Denied</Badge></Specimen>
        </div>
      </Section>

      <Section title="Inputs">
        <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
          <Specimen name="input/rest" label="input at rest">
            <Input defaultValue="agnes-3.0-flash" aria-label="input at rest" />
          </Specimen>
          <Specimen name="input/focused" label="input focused">
            <Input defaultValue="Focused field" aria-label="input focused" className="ring-2 ring-ring" />
          </Specimen>
          <Specimen name="input/placeholder" label="placeholder">
            <Input placeholder="Placeholder text" aria-label="input placeholder" />
          </Specimen>
          <Specimen name="input/select-trigger" label="select trigger">
            <Select value={selectValue} onValueChange={setSelectValue}>
              <SelectTrigger aria-label="select trigger"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="openchamber">OpenChamber</SelectItem>
                <SelectItem value="nord">Nord</SelectItem>
              </SelectContent>
            </Select>
          </Specimen>
          <Specimen name="input/switch-on" label="switch on"><Switch checked={switchOn} onCheckedChange={setSwitchOn} aria-label="switch on" /></Specimen>
          <Specimen name="input/switch-off" label="switch off"><Switch checked={false} onCheckedChange={() => {}} aria-label="switch off" /></Specimen>
        </div>
      </Section>

      <Section title="Markdown">
        <MarkdownSpecimen />
      </Section>

      <Section title="Overlays — each trigger opens its panel">
        <div className="flex flex-wrap items-start gap-3">
          <Specimen name="overlay/dropdown-trigger" label="dropdown menu">
            <DropdownMenu>
              <DropdownMenuTrigger data-lab-open="dropdown" asChild>
                <Button variant="outline">Open menu</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Theme</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem>OpenChamber <DropdownMenuShortcut>⌘1</DropdownMenuShortcut></DropdownMenuItem>
                <DropdownMenuItem>Catppuccin</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Specimen>

          <Specimen name="overlay/context-trigger" label="context menu (right-click)">
            <ContextMenu>
              <ContextMenuTrigger data-lab-open="context" asChild>
                <Button variant="outline">Right-click me</Button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem>Copy</ContextMenuItem>
                <ContextMenuItem>Rename</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </Specimen>

          <Specimen name="overlay/popover-trigger" label="popover">
            <Popover>
              <PopoverTrigger data-lab-open="popover" asChild>
                <Button variant="outline">Open popover</Button>
              </PopoverTrigger>
              <PopoverContent className="w-64">
                <div className="space-y-2">
                  <div className="text-sm font-medium">Popover title</div>
                  <p className="text-xs text-muted-foreground">Body copy inside a popover panel.</p>
                  <div className="flex gap-2"><Button size="sm">Action</Button><Button size="sm" variant="secondary">Cancel</Button></div>
                </div>
              </PopoverContent>
            </Popover>
          </Specimen>

          <Specimen name="overlay/dialog-trigger" label="dialog">
            <Dialog>
              <DialogTrigger data-lab-open="dialog" asChild>
                <Button variant="outline">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dialog title</DialogTitle>
                  <DialogDescription>Supporting copy inside the dialog body.</DialogDescription>
                </DialogHeader>
                <DialogFooter><Button size="sm">Confirm</Button></DialogFooter>
              </DialogContent>
            </Dialog>
          </Specimen>

          <Specimen name="overlay/alert-trigger" label="alert dialog">
            <AlertDialog>
              <AlertDialogTrigger data-lab-open="alert" asChild>
                <Button variant="outline">Open alert</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
                  <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </Specimen>

          <Specimen name="overlay/tooltip-trigger" label="tooltip">
            <TooltipIconButton data-lab-open="tooltip" tooltip="Copy to clipboard" aria-label="tooltip trigger">
              <Copy />
            </TooltipIconButton>
          </Specimen>

          <Specimen name="overlay/toast-trigger" label="toast">
            <Button data-lab-open="toast" variant="outline" onClick={() => toast("Saved to workspace", { description: "Toast body copy." })}>
              <Info /> Show toast
            </Button>
          </Specimen>
        </div>
      </Section>

      <Section title="Accent rows inside an open panel">
        <div className="max-w-sm overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground">
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Section label</div>
          <div data-lab="panel/rest" className="rounded-md px-2 py-1.5 text-sm">Resting option</div>
          <div data-lab="panel/hover" className="rounded-md bg-accent px-2 py-1.5 text-sm text-accent-foreground">Hovered option</div>
          <div data-lab="panel/selected" className="rounded-md bg-accent px-2 py-1.5 text-sm font-medium text-accent-foreground">
            <span className="flex items-center gap-2"><Check className="size-4" /> Selected option</span>
          </div>
          <div data-lab="panel/destructive" className="rounded-md px-2 py-1.5 text-sm text-destructive">Delete…</div>
          <div data-lab="panel/divider" className="my-1 h-px bg-border" />
          <div data-lab="panel/disabled" className="rounded-md px-2 py-1.5 text-sm opacity-50">Disabled option</div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ArrowRight className="size-3.5" /> <TriangleAlert className="size-3.5 text-warning" />
          <span>Accent rows are the most theme-sensitive element: 6 of 20 palettes do not define a subtle surface.</span>
        </div>
      </Section>
    </div>
  );
}