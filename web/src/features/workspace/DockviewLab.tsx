"use client";

/**
 * DEV-ONLY POC LAB — Dockview evaluation.
 *
 * Tests: mixed Direct + OpenCode hosting, hidden-panel execution continuity,
 * and save/restore. Mounted only from a dev-only route; compiled out of
 * production builds (see router.tsx). NOT production code.
 */
import { useCallback, useRef, useState } from "react";
import {
  DockviewReact,
  themeAbyss,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type SerializedDockview,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";

import { DirectChatHost } from "./components/DirectChatHost";
import { DockviewOpenCodeHost } from "./DockviewOpenCodeHost";

/** Real conversation ids from the local dev database. */
const CONV_A = "j8rf1ocag6b4ubqiveruspl0"; // Direct
const CONV_B = "vlah93dgw7k302nmr729dxke"; // Direct
const CONV_OC = "rsp8stebcid7i20rj6a7gnf0"; // OpenCode

const mountCounts: Record<string, number> = {};

function useMountCount(id: string) {
  const ref = useRef(false);
  if (!ref.current) {
    ref.current = true;
    mountCounts[id] = (mountCounts[id] ?? 0) + 1;
  }
  return mountCounts[id];
}

function DirectPanel({ threadId }: { threadId: string }) {
  const mounts = useMountCount(threadId);
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-2 py-1 text-xs text-muted-foreground">
        {threadId} · mounts: {mounts}
      </div>
      <div className="min-h-0 flex-1">
        <DirectChatHost threadId={threadId} />
      </div>
    </div>
  );
}

function OpenCodePanel({ conversationId }: { conversationId: string }) {
  const mounts = useMountCount(conversationId);
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-2 py-1 text-xs text-muted-foreground">
        {conversationId} (OpenCode) · mounts: {mounts}
      </div>
      <div className="min-h-0 flex-1">
        <DockviewOpenCodeHost conversationId={conversationId} />
      </div>
    </div>
  );
}

const components = {
  direct: (props: IDockviewPanelProps<{ threadId: string }>) => (
    <DirectPanel threadId={props.params.threadId} />
  ),
  opencode: (props: IDockviewPanelProps<{ conversationId: string }>) => (
    <OpenCodePanel conversationId={props.params.conversationId} />
  ),
};

export function DockviewLab() {
  const [api, setApi] = useState<DockviewReadyEvent["api"] | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const savedLayout = useRef<SerializedDockview | null>(null);

  const note = useCallback((message: string) => {
    setLog((prev) => [...prev, `${new Date().toISOString().slice(11, 19)} ${message}`]);
  }, []);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      setApi(event.api);
      event.api.addPanel({
        id: CONV_A,
        component: "direct",
        params: { threadId: CONV_A },
        renderer: "always",
      });
      event.api.addPanel({
        id: CONV_B,
        component: "direct",
        params: { threadId: CONV_B },
        renderer: "always",
        position: { referencePanel: CONV_A, direction: "right" },
      });
      event.api.onDidMovePanel((e) => note(`moved ${e.panel.id} from ${e.from.id} to ${e.to.id}`));
      note("2 Direct panels mounted (renderer=always)");
    },
    [note],
  );

  const addOpenCode = useCallback(() => {
    if (!api || api.getPanel(CONV_OC)) return;
    api.addPanel({
      id: CONV_OC,
      component: "opencode",
      params: { conversationId: CONV_OC },
      renderer: "always",
      position: { referencePanel: CONV_B, direction: "below" },
    });
    note("OpenCode panel added (mixed arrangement)");
  }, [api, note]);

  // "Hide" B by activating A in the same group — with renderer=always the
  // inactive panel stays mounted but hidden (visibility:hidden), which is the
  // exact state the POC needs to test execution continuity.
  const hideB = useCallback(() => {
    const panelA = api?.getPanel(CONV_A);
    const panelB = api?.getPanel(CONV_B);
    if (!panelA || !panelB) return;
    panelA.api.setActive();
    note(
      `activated A → B hidden (B.visible=${panelB.api.isVisible}); mounts B=${mountCounts[CONV_B]}`,
    );
  }, [api, note]);

  const showB = useCallback(() => {
    const panelB = api?.getPanel(CONV_B);
    if (!panelB) return;
    panelB.api.setActive();
    note(`activated B → B visible=${panelB.api.isVisible}; mounts B=${mountCounts[CONV_B]}`);
  }, [api, note]);

  const save = useCallback(() => {
    if (!api) return;
    savedLayout.current = api.toJSON();
    note(`saved layout (${Object.keys(savedLayout.current.panels).length} panels)`);
  }, [api, note]);

  const restore = useCallback(() => {
    if (!api || !savedLayout.current) return;
    const before = Object.keys(mountCounts)
      .map((k) => `${k.slice(0, 8)}=${mountCounts[k]}`)
      .join(" ");
    api.fromJSON(savedLayout.current, { reuseExistingPanels: true });
    const after = Object.keys(mountCounts)
      .map((k) => `${k.slice(0, 8)}=${mountCounts[k]}`)
      .join(" ");
    note(`restored layout; mounts before [${before}] after [${after}]`);
  }, [api, note]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <strong className="text-sm">Dockview POC lab</strong>
        <button
          type="button"
          onClick={addOpenCode}
          className="rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          Add OpenCode panel
        </button>
        <button
          type="button"
          onClick={hideB}
          className="rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          Hide B
        </button>
        <button
          type="button"
          onClick={showB}
          className="rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          Show B
        </button>
        <button
          type="button"
          onClick={save}
          className="rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          Save layout
        </button>
        <button
          type="button"
          onClick={restore}
          className="rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          Restore layout
        </button>
        <span className="text-xs text-muted-foreground">
          mounts:{" "}
          {Object.entries(mountCounts)
            .map(([k, v]) => `${k.slice(0, 8)}=${v}`)
            .join(" ")}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <DockviewReact theme={themeAbyss} components={components} onReady={onReady} />
      </div>
      <pre className="max-h-32 shrink-0 overflow-auto border-t p-2 text-xs">{log.join("\n")}</pre>
    </div>
  );
}
