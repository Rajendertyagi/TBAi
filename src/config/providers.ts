import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { ModelOption, ProviderConfig } from "../types";

interface ProviderConfigRow {
  id: string;
  name: string;
  type: ProviderConfig["type"];
  endpoint: string | null;
  model: string;
  models: string | null;
  thinking: string | null;
  is_active: number;
  created_at: number;
  updated_at: number;
}

export class ProviderRegistry {
  private static instance: ProviderRegistry;
  private providers: Map<string, ProviderConfig> = new Map();
  private activeProviderId: string | null = null;

  private constructor() {}

  static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  async loadFromDb(db: Database): Promise<void> {
    const rows = db.query<ProviderConfigRow, SQLQueryBindings[]>("SELECT * FROM provider_configs").all();
    this.providers.clear();
    for (const row of rows) {
      let models: ModelOption[] = [];
      try {
        if (row.models) models = JSON.parse(row.models) as ModelOption[];
      } catch {
        models = [];
      }
      const config: ProviderConfig = {
        id: row.id,
        name: row.name,
        type: row.type,
        endpoint: row.endpoint,
        model: row.model,
        models,
        thinking: (row.thinking as ProviderConfig["thinking"]) || "off",
        isActive: row.is_active === 1,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      };
      this.providers.set(config.id, config);
      if (config.isActive) {
        this.activeProviderId = config.id;
      }
    }
    if (!this.activeProviderId && this.providers.size > 0) {
      this.activeProviderId = this.providers.keys().next().value;
    }
  }

  get(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  // Public list never includes the API key (keys stay backend-only).
  list(): Omit<ProviderConfig, "apiKey">[] {
    return Array.from(this.providers.values()).map(({ apiKey, ...rest }) => rest);
  }

  getActive(): ProviderConfig | undefined {
    if (!this.activeProviderId) return undefined;
    return this.providers.get(this.activeProviderId);
  }

  setActive(id: string): void {
    if (this.providers.has(id)) {
      this.activeProviderId = id;
    }
  }

  add(config: ProviderConfig): void {
    this.providers.set(config.id, config);
  }

  update(id: string, updates: Partial<ProviderConfig>): void {
    const existing = this.providers.get(id);
    if (existing) {
      this.providers.set(id, { ...existing, ...updates, updatedAt: new Date() });
    }
  }

  remove(id: string): void {
    this.providers.delete(id);
    if (this.activeProviderId === id) {
      const remaining = Array.from(this.providers.keys());
      this.activeProviderId = remaining[0] || null;
    }
  }
}

export const registry = ProviderRegistry.getInstance();
