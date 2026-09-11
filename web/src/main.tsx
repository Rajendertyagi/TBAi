import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/globals.css'
import { installGlobalLogHooks } from './lib/logger'
import { ThemeProvider } from './components/theme-provider'

// DEV ONLY compatibility shim for the assistant-ui DevTools chain.
//
// Both `AssistantRuntimeProvider` (runtime registration) and `DevToolsModal`
// (panel rendering) guard on `process.env.NODE_ENV`, but Vite browsers have
// no `process` object at all — so without this, the panel renders yet waits
// forever ("Waiting for assistant-ui instance..."). This fills the smallest
// missing piece, dev-only, without clobbering anything already present.
// Production bundles never execute this branch (import.meta.env.DEV is false
// and tree-shaken away).
if (import.meta.env.DEV) {
  const scope = window as unknown as Record<string, unknown>;
  const existing = (scope.process ?? {}) as Record<string, unknown>;
  const existingEnv = (existing.env ?? {}) as Record<string, unknown>;
  scope.process = { ...existing, env: { ...existingEnv, NODE_ENV: "development" } };
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
)

// Capture otherwise-silent failures (unhandled rejections, window errors).
installGlobalLogHooks();
