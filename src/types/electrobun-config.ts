// Re-exports the real ElectroBun config type from the Hutch devkit so that
// `import type { ElectrobunConfig } from "electrobun"` resolves under `tsc`
// (the devkit is only injected by the Hutch bundler at build time). See
// docs/architecture.md ("ElectroBun type resolution").
export type { ElectrobunConfig } from "../../.hutch/devkit/api/config/ElectrobunConfig";
