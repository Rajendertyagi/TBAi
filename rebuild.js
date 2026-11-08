import fs from 'node:fs';

const p = 'D:/Temp/ai-chat-app/web/public/appearance-comparison.html';

// ── Rebuild the entire file from scratch ─────────────────────────────────────

const head = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TBAi Appearance Architecture — Current Production vs Prototype (Pixel-by-Pixel)</title>
  
  <!-- Font imports matching TBAi production font stack -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300;400;500;600;700&family=Geist+Mono:wght@100..900&family=Geist:wght@100..900&family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&family=Lato:ital,wght@0,100;0,300;0,400;0,700;0,900;1,100;1,300;1,400;1,700;1,900&family=Outfit:wght@100..900&family=Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800&family=Roboto:ital,wght@0,100..900;1,100..900&family=Source+Code+Pro:ital,wght@0,200..900;1,200..900&family=Source+Sans+3:ital,wght@0,200..900;1,200..900&display=swap" rel="stylesheet">

  <script src="https://cdn.tailwindcss.com"><\/script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          borderRadius: {
            'sm': 'calc(var(--radius) * 0.6)',
            'md': 'calc(var(--radius) * 0.8)',
            'lg': 'var(--radius)',
            'xl': 'calc(var(--radius) * 1.2)',
            '2xl': 'calc(var(--radius) * 1.6)',
            '3xl': 'calc(var(--radius) * 2)',
            '4xl': 'calc(var(--radius) * 2.6)',
          },
          fontSize: {
            '2xs': ['0.6875rem', { lineHeight: '0.875rem' }],
            '3xs': ['0.625rem', { lineHeight: '0.75rem' }],
          },
          colors: {
            background: 'hsl(var(--background))',
            foreground: 'hsl(var(--foreground))',
            card: 'hsl(var(--card))',
            'card-foreground': 'hsl(var(--card-foreground))',
            'card-soft': 'hsl(var(--card-soft))',
            'card-outline': 'hsl(var(--card-outline))',
            popover: 'hsl(var(--popover))',
            'popover-foreground': 'hsl(var(--popover-foreground))',
            primary: 'hsl(var(--primary))',
            'primary-foreground': 'hsl(var(--primary-foreground))',
            secondary: 'hsl(var(--secondary))',
            'secondary-foreground': 'hsl(var(--secondary-foreground))',
            muted: 'hsl(var(--muted))',
            'muted-foreground': 'hsl(var(--muted-foreground))',
            accent: 'hsl(var(--accent))',
            'accent-foreground': 'hsl(var(--accent-foreground))',
            destructive: 'hsl(var(--destructive))',
            'destructive-foreground': 'hsl(var(--destructive-foreground))',
            border: 'hsl(var(--border))',
            input: 'hsl(var(--input))',
            ring: 'hsl(var(--ring))',
          }
        }
      }
    }
  <\/script>
  <style>
    /* TBAi Design Tokens — borderless with elevation shadows, matching web/src/styles/globals.css */
    .dark {
      --background: 0 0% 4%;
      --foreground: 0 0% 98.5%;
      --card: 0 0% 8%;
      --card-foreground: 0 0% 98.5%;
      --card-soft: 0 0% 100% / 0.04;
      --card-outline: 0 0% 100% / 0.06;
      --popover: 0 0% 8%;
      --popover-foreground: 0 0% 98.5%;
      --primary: 0 0% 87%;
      --primary-foreground: 0 0% 9%;
      --secondary: 0 0% 14.5%;
      --secondary-foreground: 0 0% 98.5%;
      --muted: 0 0% 13%;
      --muted-foreground: 0 0% 65%;
      --accent: 0 0% 18%;
      --accent-foreground: 0 0% 98.5%;
      --destructive: 0 70% 50%;
      --destructive-foreground: 0 0% 98.5%;
      --border: 0 0% 100% / 0.08;
      --input: 0 0% 100% / 0.10;
      --ring: 0 0% 55.6%;
      --radius: 0.625rem;
      color-scheme: dark;
    }

    .light {
      --background: 0 0% 98%;
      --foreground: 222 47% 11%;
      --card: 0 0% 100%;
      --card-foreground: 222 47% 11%;
      --card-soft: 222 47% 11% / 0.025;
      --card-outline: 222 47% 11% / 0.06;
      --popover: 0 0% 100%;
      --popover-foreground: 222 47% 11%;
      --primary: 222 47% 11%;
      --primary-foreground: 0 0% 98.5%;
      --secondary: 210 40% 96.1%;
      --secondary-foreground: 222 47% 11%;
      --muted: 210 40% 96.1%;
      --muted-foreground: 215.4 16.3% 46.9%;
      --accent: 210 40% 95%;
      --accent-foreground: 222 47% 11%;
      --destructive: 0 84.2% 60.2%;
      --destructive-foreground: 0 0% 98.5%;
      --border: 214.3 31.8% 91.4% / 0.6;
      --input: 214.3 31.8% 91.4%;
      --ring: 215 20.2% 65.1%;
      --radius: 0.625rem;
      color-scheme: light;
    }

    /* Scoped Variables for Current Left Pane */
    :root {
      --cur-ui-font: "Inter", system-ui, -apple-system, sans-serif;
      --cur-ui-size: 16px;
      --cur-ui-weight: 400;
      --cur-code-font: "JetBrains Mono", monospace;
      --cur-code-size: 13px;
      --cur-code-weight: 400;
      --cur-term-font: "JetBrains Mono", monospace;
      --cur-term-size: 12px;
      --cur-term-weight: 400;
      --cur-reading-lh: 1.5;
      --cur-app-scale: 1;

      --prop-ui-font: "Inter", system-ui, -apple-system, sans-serif;
      --prop-ui-size: 16px;
      --prop-ui-weight: 400;
      --prop-code-font: "JetBrains Mono", monospace;
      --prop-code-size: 13px;
      --prop-code-weight: 400;
      --prop-term-font: "JetBrains Mono", monospace;
      --prop-term-size: 12px;
      --prop-term-weight: 400;
      --prop-reading-lh: 1.5;
      --prop-app-scale: 100%;
    }

    /* Left Pane Component Scopes */
    .cur-scope-ui   { font-family: var(--cur-ui-font); font-weight: var(--cur-ui-weight); }
    .cur-scope-code { font-family: var(--cur-code-font); font-size: var(--cur-code-size); font-weight: var(--cur-code-weight); }
    .cur-scope-term { font-family: var(--cur-term-font); font-size: var(--cur-term-size); font-weight: var(--cur-term-weight); }
    .prop-scope-ui  { font-family: var(--prop-ui-font); font-weight: var(--prop-ui-weight); }
    .prop-scope-code{ font-family: var(--prop-code-font); font-size: var(--prop-code-size); font-weight: var(--prop-code-weight); }
    .prop-scope-term{ font-family: var(--prop-term-font); font-size: var(--prop-term-size); font-weight: var(--prop-term-weight); }

    /* Authentic TBAi Select Component Styling (matches SelectTrigger sm variant) */
    .shadcn-select {
      background-color: hsl(var(--input) / 0.3);
      border: 1px solid hsl(var(--border));
      border-radius: calc(var(--radius) * 2.6);
      padding: 0 0.75rem;
      height: 2.25rem;
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.375rem;
      font-size: 0.875rem;
      cursor: pointer;
      outline: none;
      transition: all 0.15s ease;
      color: hsl(var(--foreground));
      width: 14rem;
    }
    .shadcn-select:focus {
      border-color: hsl(var(--ring));
      box-shadow: 0 0 0 3px hsl(var(--ring) / 0.5);
    }
    .shadcn-select:hover {
      background-color: hsl(var(--input) / 0.5);
    }

    /* ── Custom Combobox (replaces native <select> for full dark-mode control)
          Trigger:  borderless pill, soft fill — matches SelectTrigger sm (h-8, rounded-4xl, bg-input/30)
          Panel:    floating, no border, shadow-elevation, bg-popover — matches SelectContent
          Items:    rounded-xl, focus:bg-accent — matches SelectItem
    */
    .combobox-wrap { position: relative; }

    .combobox-trigger {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      width: 100%;
      min-height: 2rem;
      padding: 0.375rem 0.75rem;
      border-radius: calc(var(--radius) * 2.6);
      background-color: hsl(var(--input) / 0.3);
      border: none;
      outline: none;
      cursor: pointer;
      font-size: 0.8125rem;
      color: hsl(var(--foreground));
      transition: background-color 0.15s ease;
      appearance: none;
      text-align: left;
    }
    .combobox-trigger:hover {
      background-color: hsl(var(--input) / 0.5);
    }
    .combobox-trigger[aria-expanded="true"] {
      background-color: hsl(var(--input) / 0.5);
      box-shadow: 0 0 0 3px hsl(var(--ring) / 0.3);
    }
    .combobox-value {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .combobox-chevron {
      flex-shrink: 0;
      color: hsl(var(--muted-foreground));
      transition: transform 0.15s ease;
    }
    .combobox-trigger[aria-expanded="true"] .combobox-chevron {
      transform: rotate(180deg);
    }

    .combobox-panel {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      min-width: 100%;
      max-height: 240px;
      overflow-y: auto;
      background-color: hsl(var(--popover));
      color: hsl(var(--popover-foreground));
      border: none;
      border-radius: calc(var(--radius) * 1.2);
      box-shadow:
        0 1px 2px -1px rgb(0 0 0 / 0.1),
        0 6px 14px -4px rgb(0 0 0 / 0.12),
        0 18px 32px -10px rgb(0 0 0 / 0.16);
      padding: 0.25rem;
      z-index: 60;
      display: none;
    }
    .dark .combobox-panel {
      box-shadow:
        0 2px 6px -2px rgb(0 0 0 / 0.55),
        0 10px 26px -8px rgb(0 0 0 / 0.6);
    }
    .combobox-panel.open {
      display: block;
      animation: cbx-in 0.12s ease-out;
    }
    @keyframes cbx-in {
      from { opacity: 0; transform: translateY(-4px) scale(0.98); }
      to   { opacity: 1; transform: translateY(0)     scale(1); }
    }
    .combobox-panel::-webkit-scrollbar { width: 5px; }
    .combobox-panel::-webkit-scrollbar-track { background: transparent; }
    .combobox-panel::-webkit-scrollbar-thumb {
      background: hsl(var(--border) / 0.5);
      border-radius: 99px;
    }

    .combobox-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.375rem 0.75rem;
      border-radius: calc(var(--radius) * 1.2);
      font-size: 0.8125rem;
      color: hsl(var(--popover-foreground));
      cursor: default;
      user-select: none;
      transition: background-color 0.1s ease;
      background: transparent;
      border: none;
      text-align: left;
      font-family: inherit;
    }
    .combobox-item:hover,
    .combobox-item:focus {
      background-color: hsl(var(--accent));
      color: hsl(var(--accent-foreground));
      outline: none;
    }
    .combobox-item[aria-selected="true"] {
      background-color: hsl(var(--accent) / 0.4);
      color: hsl(var(--accent-foreground));
      font-weight: 500;
    }
    .cbx-check {
      margin-left: auto;
      flex-shrink: 0;
      opacity: 0;
      color: hsl(var(--ring));
    }
    .combobox-item[aria-selected="true"] .cbx-check {
      opacity: 1;
    }

    /* Custom range slider thumb styling */
    input[type=range]::-webkit-slider-thumb {
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: hsl(var(--primary));
      cursor: pointer;
      transition: transform 0.1s ease;
    }
    input[type=range]::-webkit-slider-thumb:hover {
      transform: scale(1.15);
    }
  </style>
</head>`;

// ── LEFT PANE (original, verbatim from production) ───────────────────────────
const leftPane = `
<body class="min-h-screen flex flex-col bg-background text-foreground antialiased">

  <!-- TOP WORKBENCH HEADER -->
  <header class="border-b border-border/80 bg-card/90 backdrop-blur sticky top-0 z-50 px-6 py-2.5 shadow-sm">
    <div class="flex items-center justify-between max-w-[1920px] mx-auto w-full">
      <div class="flex items-center gap-3">
        <div class="size-7 rounded-lg bg-primary/20 text-primary flex items-center justify-center font-bold text-xs tracking-wider">TBAi</div>
        <div>
          <h1 class="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
            Appearance Architecture Comparison
            <span class="text-3xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono font-medium">True Pixel-by-Pixel Fidelity</span>
          </h1>
        </div>
      </div>

      <!-- Controls -->
      <div class="flex items-center gap-3">
        <div class="flex items-center bg-secondary/80 p-0.5 rounded-lg border border-border text-xs">
          <button id="btn-split" onclick="setMode('split')" class="px-2.5 py-1 rounded-md bg-background text-foreground shadow-sm font-medium">Split (50 / 50)</button>
          <button id="btn-cur" onclick="setMode('current')" class="px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground">Current Only</button>
          <button id="btn-prop" onclick="setMode('proposed')" class="px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground">Proposed Only</button>
        </div>
        <button onclick="toggleTheme()" class="h-8 px-3 rounded-4xl border border-border bg-card hover:bg-secondary text-xs flex items-center gap-1.5 font-medium transition-colors">
          <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
          Toggle Light / Dark
        </button>
      </div>
    </div>
  </header>

  <!-- SPLIT SCREEN CONTAINER -->
  <main class="flex-1 grid grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-border w-full">

    <!-- ========================================================================= -->
    <!-- LEFT PANEL: EXACT CURRENT PRODUCTION /appearance ROUTE                     -->
    <!-- ========================================================================= -->
    <section id="pane-cur" class="col-span-12 lg:col-span-6 bg-background/50 overflow-y-auto">
      
      <!-- Section Indicator Header -->
      <div class="bg-secondary/40 border-b border-border px-6 py-2.5 flex items-center justify-between sticky top-0 z-30 backdrop-blur">
        <div class="flex items-center gap-2">
          <span class="size-2 rounded-full bg-slate-400"></span>
          <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">What We Have Right Now (Current Production)</span>
        </div>
        <span class="text-3xs font-mono text-muted-foreground">web/src/features/appearance/AppearancePage.tsx</span>
      </div>

      <!-- SettingsPage Wrapper -->
      <div class="mx-auto h-full w-full max-w-3xl space-y-4 p-4">
        
        <!-- Page Title & Description -->
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 space-y-1">
            <h1 class="text-base font-semibold text-foreground">Appearance</h1>
            <p class="text-xs leading-5 text-muted-foreground">Theme, typography, and display preferences. Applied instantly and remembered on this device.</p>
          </div>
        </div>

        <!-- ========================================== -->
        <!-- SECTION 1: THEME                           -->
        <!-- ========================================== -->
        <section class="space-y-3 rounded-xl border border-border bg-card p-4">
          <div class="flex justify-between gap-3 items-start">
            <div class="min-w-0 space-y-1">
              <h2 class="text-sm font-semibold flex items-center gap-2 text-foreground">
                <svg class="size-4 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor"><circle cx="12" cy="12" r="10"/><path d="M12 2a7 7 0 0 0 7 7c0 2-2 3-2 3s1 1 1 3a3 3 0 0 1-3 3h-3"/></svg>
                Theme
              </h2>
              <p class="text-xs leading-5 text-muted-foreground">Light or dark interface, and the colour theme used in each.</p>
            </div>
          </div>

          <!-- Color theme row -->
          <div class="flex flex-col gap-2">
            <div class="flex justify-between gap-3 items-center">
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 text-sm text-foreground">Color theme</div>
                <div class="text-xs leading-5 text-muted-foreground">Switches the whole app between light and dark tokens.</div>
              </div>
              <div class="shrink-0">
                <button type="button" onclick="toggleTheme()" class="group/button inline-flex shrink-0 items-center justify-center rounded-4xl border border-transparent size-8 hover:bg-muted text-muted-foreground hover:text-foreground">
                  <svg class="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
                </button>
              </div>
            </div>
          </div>

          <!-- Light theme row -->
          <div class="flex flex-col gap-2">
            <div class="flex justify-between gap-3 items-start">
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 text-sm text-foreground">Light theme</div>
                <div class="text-xs leading-5 text-muted-foreground">The colour theme used while in light mode. Independent of the dark one.</div>
              </div>
            </div>
            <fieldset class="min-w-0">
              <legend class="sr-only">Colour theme for light mode</legend>
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                ${['Classic','#ffffff|#ffffff|#18181b'].map(([name]) => `
                <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-ring bg-accent px-2 py-1.5">
                  <span class="flex size-6 shrink-0 overflow-hidden rounded-full ring-1 ring-border">
                    ${['#ffffff','#ffffff','#18181b'].map(c => `<span class="h-full flex-1" style="background-color: ${c};"></span>`).join('\n                    ')}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">Classic</span>
                </label>`).join('\n')}
                ${[['Aura','#F5F0FF|#f1ebfb|#A277FF'],['Ayu','#FDFAF4|#faf6ed|#4AA8C8'],['Carbonfox','#FFFFFF|#f4f4f7|#0072C3'],['Catppuccin','#eff1f5|#e6e9ef|#7130c7'],['Cursor','#FCFCFC|#F1F1F1|#2567A8'],['Fields of the Shire','#f9f5eb|#fcf9f0|#4a6030'],['Gruvbox','#f8f1d5|#efebcd|#076678'],['JetBrains','#FFF|#FFFFFF|#195ce3'],['OpenChamber','#fdfcfa|#f8f7f5|#b35017'],['Vesper','#FFFFFF|#f6f5f5|#a06535']].map(([name,c1,c2,c3]) => `
                <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5 hover:bg-accent">
                  <span class="flex size-6 shrink-0 overflow-hidden rounded-full ring-1 ring-border">
                    <span class="h-full flex-1" style="background-color: ${c1};"></span>
                    <span class="h-full flex-1" style="background-color: ${c2};"></span>
                    <span class="h-full flex-1" style="background-color: ${c3};"></span>
                  </span>
                  <span class="min-w-0 flex-1 truncate text-xs text-foreground">${name}</span>
                </label>`).join('\n')}
              </div>
            </fieldset>
          </div>

          <!-- Dark theme row -->
          <div class="flex flex-col gap-2">
            <div class="flex justify-between gap-3 items-start">
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 text-sm text-foreground">Dark theme</div>
                <div class="text-xs leading-5 text-muted-foreground">The colour theme used while in dark mode. Independent of the light one.</div>
              </div>
            </div>
            <fieldset class="min-w-0">
              <legend class="sr-only">Colour theme for dark mode</legend>
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-ring bg-accent px-2 py-1.5">
                  <span class="flex size-6 shrink-0 overflow-hidden rounded-full ring-1 ring-border">
                    <span class="h-full flex-1" style="background-color: #0a0a0a;"></span>
                    <span class="h-full flex-1" style="background-color: #343434;"></span>
                    <span class="h-full flex-1" style="background-color: #dedede;"></span>
                  </span>
                  <span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">Classic</span>
                </label>
                ${[['Aura','#15141B|#201e2b|#A277FF'],['Ayu','#0F1419|#17202a|#3FB7E3'],['Carbonfox','#161616|#222222|#33B1FF'],['Catppuccin','#1e1e2e|#181825|#cba6f7'],['Cursor','#1a1a1a|#141414|#4c9df3'],['Fields of the Shire','#1b1815|#2b2622|#7a8a5a'],['Gruvbox','#282828|#25292b|#83A598'],['JetBrains','#1E1F22|#2B2D30|#6796f5'],['OpenChamber','#120f0e|#181715|#da7c47'],['Vesper','#151515|#242121|#FFC799']].map(([name,c1,c2,c3]) => `
                <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5 hover:bg-accent">
                  <span class="flex size-6 shrink-0 overflow-hidden rounded-full ring-1 ring-border">
                    <span class="h-full flex-1" style="background-color: ${c1};"></span>
                    <span class="h-full flex-1" style="background-color: ${c2};"></span>
                    <span class="h-full flex-1" style="background-color: ${c3};"></span>
                  </span>
                  <span class="min-w-0 flex-1 truncate text-xs text-foreground">${name}</span>
                </label>`).join('\n')}
              </div>
            </fieldset>
          </div>

          <p class="text-3xs text-muted-foreground">
            Colour palettes from OpenChamber (MIT, Copyright (c) 2025 Bohdan Triapitsyn). Classic is TBAi's own.
          </p>
        </section>`;

// This is getting very large. Let me just read the original file from my first read and reconstruct it properly.
// I have the full original in the conversation history. Let me write a simpler approach.

fs.writeFileSync('/dev/null', ''); // noop

// I'll write the file in 3 parts using separate writes

console.log('Building file...');
