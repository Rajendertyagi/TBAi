import {
  BookOpen,
  Briefcase,
  Bug,
  Code2,
  Compass,
  FileText,
  FlaskConical,
  Mail,
  RefreshCw,
  Scale,
  Table,
  TestTube,
  type LucideIcon,
} from "lucide-react";

export type QuickActionTabId = "coding" | "office" | "research";

/** Accent keys map to full-literal Tailwind fragments in QuickActions
 *  (never composed from template strings — JIT would purge them). */
export type QuickActionAccent =
  | "amber"
  | "pink"
  | "purple"
  | "green"
  | "blue"
  | "orange"
  | "violet";

export interface QuickActionItem {
  id: string;
  title: string;
  description: string;
  prompt: string;
  icon: LucideIcon;
  accent: QuickActionAccent;
}

export interface QuickActionTab {
  id: QuickActionTabId;
  label: string;
  icon: LucideIcon;
  featuredCount: number;
  items: QuickActionItem[];
}

export interface WelcomeLayoutTokens {
  columnMaxWidthClass: string;
  columnPaddingClass: string;
  columnGapClass: string;
  heroTitleClass: string;
  heroSubtitleClass: string;
  cardGridClass: string;
  tabRowClass: string;
  tipClass: string;
  composerMinHeightClass: string;
  scopeRowClass: string;
}

export interface WelcomeConfig {
  layout: WelcomeLayoutTokens;
  storage: {
    scopeKey: string;
    tabKey: string;
  };
  copy: {
    greetingTitle: (appName: string) => string;
    greetingSubtitle: string;
    shortcutHint: string;
    newChatAria: string;
    quickActionsLabel: string;
    railPrev: string;
    railNext: string;
    composerAria: string;
    scopeLabel: string;
    folderTitle: string;
    searchFolder: string;
    noFolders: string;
    chatModeLabel: string;
    folderRemoved: string;
    engineLabel: string;
    agentLabel: string;
    modelLabel: string;
    loadingCapabilities: string;
    capabilitiesError: string;
    selectAgent: string;
    selectModel: string;
    engineDirect: string;
    engineOpenCode: string;
    agentHint: string;
    modelHint: string;
    shieldOffLabel: string;
    shieldOnLabel: string;
    shieldOffTitle: string;
    shieldOnTitle: string;
    shieldAria: (enabled: boolean) => string;
    withoutFolderTitle: string;
    withoutFolderDescription: string;
    projectFolderTitle: string;
    noFoldersHint: string;
    manageFolders: string;
    folderConversations: (count: number) => string;
    invalidScopeFallback: string;
    tips: readonly string[];
  };
  tabs: readonly QuickActionTab[];
}

const TIPS = [
  "Tip: press Enter to send, Shift+Enter for a new line.",
  "Tip: pick a model from the composer chip before sending.",
  "Tip: attach a project folder to give the agent workspace context.",
  "Tip: without a folder the chat uses a disposable workspace.",
] as const;

export const welcomeConfig: WelcomeConfig = {
  layout: {
    columnMaxWidthClass: "max-w-3xl",
    columnPaddingClass: "px-4",
    columnGapClass: "gap-6",
    heroTitleClass: "text-2xl font-semibold tracking-tight text-foreground",
    heroSubtitleClass: "text-sm text-muted-foreground",
    cardGridClass: "grid grid-cols-1 gap-2 sm:grid-cols-3",
    tabRowClass: "flex items-center gap-1",
    tipClass: "text-xs text-muted-foreground",
    composerMinHeightClass: "min-h-30",
    scopeRowClass: "flex flex-col gap-2",
  },
  storage: {
    scopeKey: "tbai:welcome-scope",
    tabKey: "tbai:quick-actions-tab",
  },
  copy: {
    greetingTitle: (appName: string) => `Hi, what do you want to build in ${appName}?`,
    greetingSubtitle:
      "Start with a folder for project context, or without one for a quick disposable chat.",
    shortcutHint: "Ctrl T for a new chat",
    newChatAria: "New conversation welcome screen",
    quickActionsLabel: "Quick actions",
    railPrev: "Scroll skills back",
    railNext: "Scroll skills forward",
    composerAria: "Welcome composer",
    scopeLabel: "Chat scope",
    folderTitle: "Working folder",
    searchFolder: "Search folder...",
    noFolders: "No folders",
    chatModeLabel: "Chat mode",
    folderRemoved: "Project (folder removed)",
    engineLabel: "Engine",
    agentLabel: "Agent",
    modelLabel: "Model",
    loadingCapabilities: "Loading OpenCode agents and models…",
    capabilitiesError: "Could not load OpenCode capabilities",
    selectAgent: "Select an agent",
    selectModel: "Select a model",
    engineDirect: "Direct",
    engineOpenCode: "OpenCode",
    agentHint: "OpenCode agent that owns this conversation",
    modelHint: "OpenCode model the agent runs with",
    shieldOffLabel: "Auto off",
    shieldOnLabel: "Auto on",
    shieldOffTitle: "Auto-approval off — permission requests are asked",
    shieldOnTitle: "Auto-approval on — permission requests are accepted once",
    shieldAria: (enabled: boolean) =>
      enabled ? "Auto-approve permissions: on" : "Auto-approve permissions: off",
    withoutFolderTitle: "Without folder",
    withoutFolderDescription: "Quick chat in a disposable workspace",
    projectFolderTitle: "With a project folder",
    noFoldersHint: "No folders registered yet. Add one to enable project chats.",
    manageFolders: "Manage folders",
    folderConversations: (count: number) =>
      count === 1 ? "1 chat" : `${count} chats`,
    invalidScopeFallback: "Saved folder is gone — fell back to a disposable workspace.",
    tips: TIPS,
  },
  tabs: [
    {
      id: "coding",
      label: "Code",
      icon: Code2,
      featuredCount: 3,
      items: [
        {
          id: "coding-explain",
          title: "Explain code",
          description: "Understand what a file does",
          prompt: "Explain what this code does step by step:\n\n",
          icon: FileText,
          accent: "amber",
        },
        {
          id: "coding-fix",
          title: "Fix a bug",
          description: "Diagnose and patch an error",
          prompt: "Help me diagnose and fix this bug:\n\n",
          icon: Bug,
          accent: "pink",
        },
        {
          id: "coding-refactor",
          title: "Refactor",
          description: "Clean up without changing behavior",
          prompt: "Refactor this code for clarity without changing behavior:\n\n",
          icon: RefreshCw,
          accent: "purple",
        },
        {
          id: "coding-tests",
          title: "Write tests",
          description: "Cover the happy path first",
          prompt: "Write tests for this code, happy path first:\n\n",
          icon: TestTube,
          accent: "blue",
        },
      ],
    },
    {
      id: "office",
      label: "Office",
      icon: Briefcase,
      featuredCount: 3,
      items: [
        {
          id: "office-summary",
          title: "Summarize",
          description: "Turn notes into a summary",
          prompt: "Summarize these notes into key points:\n\n",
          icon: FileText,
          accent: "green",
        },
        {
          id: "office-email",
          title: "Draft email",
          description: "Short professional draft",
          prompt: "Draft a short professional email about:\n\n",
          icon: Mail,
          accent: "blue",
        },
        {
          id: "office-table",
          title: "Make a table",
          description: "Structure scattered data",
          prompt: "Turn this into a clear table:\n\n",
          icon: Table,
          accent: "orange",
        },
      ],
    },
    {
      id: "research",
      label: "Research",
      icon: FlaskConical,
      featuredCount: 3,
      items: [
        {
          id: "research-overview",
          title: "Overview",
          description: "Map the key ideas",
          prompt: "Give me an overview of the key ideas behind:\n\n",
          icon: Compass,
          accent: "violet",
        },
        {
          id: "research-compare",
          title: "Compare",
          description: "Weigh two options",
          prompt: "Compare these two options with trade-offs:\n\n",
          icon: Scale,
          accent: "blue",
        },
        {
          id: "research-sources",
          title: "Find sources",
          description: "Questions to dig deeper",
          prompt: "What should I read next to understand this, and why:\n\n",
          icon: BookOpen,
          accent: "green",
        },
      ],
    },
  ],
};

export const DEFAULT_QUICK_ACTION_TAB: QuickActionTabId = "coding";

export function isQuickActionTabId(value: unknown): value is QuickActionTabId {
  return (
    value === "coding" || value === "office" || value === "research"
  );
}
