import { useEffect, useRef } from "react";
import { useTheme } from "@/components/theme-provider";
import { suppressAppearancePatch } from "@/features/appearance/appearance-patch-guard";
import {
  applyTypographyToDom,
  DEFAULT_TYPOGRAPHY,
  migrateTypography,
} from "@/features/appearance/typography";
import { useDesktopLayout } from "@/features/desktop/state/desktopLayout";
import { isChatWidth } from "@/config/chat";
import { normalizeSectionOrderLenient } from "@/features/desktop/state/sidebarSections";
import { useFoldersStore } from "@/features/folders/state/foldersStore";
import { useWelcomeEngineStore } from "@/features/chat/state/welcomeEngine";
import { useWelcomeScopeStore } from "@/features/chat/state/welcomeScope";
import { isQuickActionTabId, DEFAULT_QUICK_ACTION_TAB } from "@/config/welcome";
import { usePreferencesStore } from "./preferencesStore";

/**
 * Passive write-through pre-paint cache for appearance keys only (mirrors
 * authoritative SQLite state). Never read as authority/migration source.
 * When SQLite says "system", writes "system" (not resolved). When typography
 * is default, removes stale cache key.
 */
function writeAppearancePrepaintCache(input: {
  themeMode: "light" | "dark" | "system";
  lightTheme: string;
  darkTheme: string;
  typography: string;
}): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("tbai-theme", input.themeMode);
    window.localStorage.setItem("tbai-theme-light", input.lightTheme);
    window.localStorage.setItem("tbai-theme-dark", input.darkTheme);
    if (input.typography && input.typography !== "default") {
      window.localStorage.setItem("tbai-typography", input.typography);
    } else {
      window.localStorage.removeItem("tbai-typography");
    }
  } catch {
    /* storage unavailable */
  }
}

/**
 * Single coordinated preferences sync owner (mounted once in AppShell).
 * Applies authoritative snapshot to appearance/desktop/navigation/welcome in one
 * pass with loop suppression. Writes appearance pre-paint cache only after
 * authoritative SQLite state is applied.
 */
export function usePreferencesSync(): void {
  const snapshot = usePreferencesStore((s) => s.snapshot);
  const hydration = usePreferencesStore((s) => s.hydration);
  const reapplySeq = usePreferencesStore((s) => s.authoritativeReapplySeq);
  const { theme, themeIds, setTheme, setThemeId } = useTheme();
  const appliedRevision = useRef<number>(-1);
  const lastReapplySeq = useRef<number>(0);

  useEffect(() => {
    if (hydration !== "ready" || !snapshot) return;
    const forceReapply = reapplySeq !== lastReapplySeq.current;
    if (!forceReapply && snapshot.revision <= appliedRevision.current) return;
    lastReapplySeq.current = reapplySeq;
    appliedRevision.current = snapshot.revision;

    const { appearance: a, desktop: d, welcome: w, navigation: nav } = snapshot.preferences;

    // Appearance (authoritative). Update pre-paint cache only after authoritative state.
    writeAppearancePrepaintCache(a);
    if (a.typography && a.typography !== "default") {
      try {
        const parsed = JSON.parse(a.typography) as unknown;
        const config = migrateTypography(parsed);
        suppressAppearancePatch();
        applyTypographyToDom(config);
      } catch {
        // Invalid authoritative typography: apply safe canonical default (no DB migration).
        suppressAppearancePatch();
        applyTypographyToDom(DEFAULT_TYPOGRAPHY);
      }
    } else {
      // Authoritative default: replace any stale cached/custom typography.
      suppressAppearancePatch();
      applyTypographyToDom(DEFAULT_TYPOGRAPHY);
    }
    if (a.themeMode === "light" || a.themeMode === "dark" || a.themeMode === "system") {
      if (theme !== a.themeMode) {
        suppressAppearancePatch();
        setTheme(a.themeMode);
      }
    }
    if (themeIds.light !== a.lightTheme) {
      suppressAppearancePatch();
      setThemeId("light", a.lightTheme);
    }
    if (themeIds.dark !== a.darkTheme) {
      suppressAppearancePatch();
      setThemeId("dark", a.darkTheme);
    }

    // Desktop (portable fields only; sidebarWidth remains local).
    const desktop = useDesktopLayout.getState();
    const desktopPatch: Partial<ReturnType<typeof useDesktopLayout.getState>> = {};
    if (desktop.sidebarVisible !== d.sidebarVisible) desktopPatch.sidebarVisible = d.sidebarVisible;
    if (desktop.statusBarVisible !== d.statusBarVisible)
      desktopPatch.statusBarVisible = d.statusBarVisible;
    if (isChatWidth(d.chatWidth) && desktop.chatWidth !== d.chatWidth)
      desktopPatch.chatWidth = d.chatWidth;
    if (
      (d.sidebarSort === "updated" || d.sidebarSort === "created") &&
      desktop.sidebarSort !== d.sidebarSort
    ) {
      desktopPatch.sidebarSort = d.sidebarSort;
    }
    const sectionOrder = normalizeSectionOrderLenient(d.sectionOrder);
    if (JSON.stringify(desktop.sectionOrder) !== JSON.stringify(sectionOrder))
      desktopPatch.sectionOrder = sectionOrder;
    if (JSON.stringify(desktop.sectionCollapsed) !== JSON.stringify(d.sectionCollapsed))
      desktopPatch.sectionCollapsed = d.sectionCollapsed;
    if (desktop.showCompleted !== d.showCompleted) desktopPatch.showCompleted = d.showCompleted;
    if (desktop.spellCheck !== d.spellCheck) desktopPatch.spellCheck = d.spellCheck;
    if (Object.keys(desktopPatch).length > 0) useDesktopLayout.setState(desktopPatch);

    // Welcome (portable fields only; agent/model/variant/autoApprove remain local).
    const engineState = useWelcomeEngineStore.getState();
    if (engineState.engine !== w.engine) {
      useWelcomeEngineStore.setState({ engine: w.engine });
    }
    const scopeState = useWelcomeScopeStore.getState();
    const nextScope =
      w.scopeMode === "project" && w.folderId
        ? { mode: "project" as const, folderId: w.folderId }
        : { mode: "simple" as const, folderId: null };
    const nextTab = isQuickActionTabId(w.quickActionTab) ? w.quickActionTab : DEFAULT_QUICK_ACTION_TAB;
    const scopeChanged =
      scopeState.scope.mode !== nextScope.mode || scopeState.scope.folderId !== nextScope.folderId;
    const tabChanged = scopeState.quickActionTab !== nextTab;
    if (scopeChanged || tabChanged) {
      useWelcomeScopeStore.setState({
        ...(scopeChanged ? { scope: nextScope } : {}),
        ...(tabChanged ? { quickActionTab: nextTab } : {}),
      });
    }

    // Navigation (soft refs; no localStorage writes).
    const folders = useFoldersStore.getState();
    if (folders.selectedFolderId !== nav.selectedFolderId) {
      useFoldersStore.setState({ selectedFolderId: nav.selectedFolderId });
    }
    if (JSON.stringify(folders.folderExpanded) !== JSON.stringify(nav.folderExpanded)) {
      useFoldersStore.setState({ folderExpanded: nav.folderExpanded ?? {} });
    }
  }, [hydration, snapshot, reapplySeq, theme, themeIds, setTheme, setThemeId]);
}
