// Ambient type declarations for the ElectroBun runtime modules.
//
// Hutch's ElectroBun devkit (`electrobun`, `electrobun/main`) is resolved at
// build time by the Hutch bundler, not by the TypeScript module resolver, so
// `tsc` cannot locate it through normal node resolution. We declare the minimal
// API surface this project actually uses.
//
// `ElectrobunConfig` is re-exported from the real devkit type definition
// (`.hutch/devkit/api/config/ElectrobunConfig`) so it stays in sync with the
// build tool. `BrowserWindow`/`PATHS` are declared here because the devkit's
// full SDK source is not consumable by `tsc` without pulling in native FFI and
// WebGPU modules that are only meaningful inside the Hutch build.
//
// See docs/architecture.md ("ElectroBun type resolution") for the rationale.

declare module "electrobun/main" {
  export interface BrowserWindowFrameOptions {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    [key: string]: unknown;
  }

  export interface BrowserWindowOptions {
    title?: string;
    url?: string;
    frame?: BrowserWindowFrameOptions;
    [key: string]: unknown;
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowOptions);
    loadURL(url: string): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  }

  export const PATHS: {
    RESOURCES_FOLDER: string;
    [key: string]: string;
  };
}
