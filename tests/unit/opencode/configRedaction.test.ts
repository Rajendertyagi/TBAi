import { describe, expect, it } from "bun:test";
import {
  redactOpenCodeConfigDocument,
  redactOpenCodeConfigText,
  REDACTED_CONFIG_VALUE,
} from "@/services/opencode/configRedaction.ts";

/**
 * Unit B — credential redaction.
 *
 * The configuration document TBAi shows the user carries provider keys,
 * request headers, MCP OAuth secrets and plugin environment values. This
 * suite pins which of those are masked, that the substitution forms are
 * masked too, and that everything else survives.
 */

const SECRET = "sk-do-not-leak-me";

/** Narrows an unknown node to a record for the assertions below. */
function record(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

describe("redactOpenCodeConfigDocument", () => {
  it("masks every value of a provider's settings object", () => {
    const redacted = redactOpenCodeConfigDocument({
      providers: {
        openrouter: {
          name: "OpenRouter",
          settings: { apiKey: SECRET, baseURL: "https://openrouter.ai/api/v1" },
        },
      },
    });
    const provider = record(record(redacted.providers).openrouter);
    const settings = record(provider.settings);

    // The schema's `allOf` permits undeclared keys, so the whole object is
    // masked rather than a named key.
    expect(settings.apiKey).toBe(REDACTED_CONFIG_VALUE);
    expect(settings.baseURL).toBe(REDACTED_CONFIG_VALUE);
    // The key names survive: they are the diagnostic value.
    expect(Object.keys(settings)).toEqual(["apiKey", "baseURL"]);
    // A non-secret field on the provider is untouched.
    expect(provider.name).toBe("OpenRouter");
  });

  it("masks provider headers and body overrides", () => {
    const redacted = redactOpenCodeConfigDocument({
      providers: {
        acme: {
          headers: { Authorization: SECRET },
          body: { api_key: SECRET },
        },
      },
    });
    const provider = record(record(redacted.providers).acme);
    expect(record(provider.headers).Authorization).toBe(REDACTED_CONFIG_VALUE);
    expect(record(provider.body).api_key).toBe(REDACTED_CONFIG_VALUE);
  });

  it("masks a model-level settings, headers and body", () => {
    const redacted = redactOpenCodeConfigDocument({
      providers: {
        acme: {
          models: {
            "model-one": {
              settings: { apiKey: SECRET },
              headers: { Authorization: SECRET },
              body: { token: SECRET },
              variants: [{ id: "v1", settings: { apiKey: SECRET } }],
            },
          },
        },
      },
    });
    const model = record(record(record(redacted.providers).acme).models)["model-one"];
    const modelRecord = record(model);
    expect(record(modelRecord.settings).apiKey).toBe(REDACTED_CONFIG_VALUE);
    expect(record(modelRecord.headers).Authorization).toBe(REDACTED_CONFIG_VALUE);
    expect(record(modelRecord.body).token).toBe(REDACTED_CONFIG_VALUE);
    const variant = record((modelRecord.variants as unknown[])[0]);
    expect(record(variant.settings).apiKey).toBe(REDACTED_CONFIG_VALUE);
  });

  it("masks a V2 agent's request headers and body", async () => {
    const redacted = redactOpenCodeConfigDocument({
      agents: {
        build: {
          description: "Builds things",
          request: { headers: { Authorization: SECRET }, body: { key: SECRET } },
        },
      },
    });
    const agent = record(record(redacted.agents).build);
    const request = record(agent.request);
    expect(record(request.headers).Authorization).toBe(REDACTED_CONFIG_VALUE);
    expect(record(request.body).key).toBe(REDACTED_CONFIG_VALUE);
    expect(agent.description).toBe("Builds things");
  });

  it("masks the V1 provider-options object of an agent", () => {
    const redacted = redactOpenCodeConfigDocument({
      agent: { build: { description: "Builds", options: { apiKey: SECRET } } },
      mode: { plan: { options: { apiKey: SECRET } } },
    });
    const agent = record(record(redacted.agent).build);
    expect(record(agent.options).apiKey).toBe(REDACTED_CONFIG_VALUE);
    expect(agent.description).toBe("Builds");
    const mode = record(record(redacted.mode).plan);
    expect(record(mode.options).apiKey).toBe(REDACTED_CONFIG_VALUE);
  });

  it("masks MCP environment, headers and both spellings of the OAuth secret", () => {
    const redacted = redactOpenCodeConfigDocument({
      mcp: {
        servers: {
          remote: {
            url: "https://mcp.example",
            headers: { Authorization: SECRET },
            oauth: { client_id: "public-id", client_secret: SECRET },
          },
          local: { command: ["node", "server.js"], environment: { TOKEN: SECRET } },
        },
        legacy: {
          url: "https://legacy.example",
          headers: { Authorization: SECRET },
          environment: { TOKEN: SECRET },
          oauth: { clientId: "public-id", clientSecret: SECRET },
        },
      },
    });
    const mcp = record(redacted.mcp);
    const servers = record(mcp.servers);
    const remote = record(servers.remote);
    expect(record(remote.headers).Authorization).toBe(REDACTED_CONFIG_VALUE);
    expect(record(remote.oauth).client_secret).toBe(REDACTED_CONFIG_VALUE);
    // A client id is not a secret.
    expect(record(remote.oauth).client_id).toBe("public-id");
    const local = record(servers.local);
    expect(record(local.environment).TOKEN).toBe(REDACTED_CONFIG_VALUE);

    const legacy = record(mcp.legacy);
    expect(record(legacy.headers).Authorization).toBe(REDACTED_CONFIG_VALUE);
    expect(record(legacy.environment).TOKEN).toBe(REDACTED_CONFIG_VALUE);
    expect(record(legacy.oauth).clientSecret).toBe(REDACTED_CONFIG_VALUE);
  });

  it("masks plugin, LSP and formatter environment values", () => {
    const redacted = redactOpenCodeConfigDocument({
      plugins: [{ package: "my-plugin", env: { TOKEN: SECRET }, options: { key: SECRET } }],
      lsp: { myserver: { command: ["tsserver"], env: { TOKEN: SECRET } } },
      formatter: { prettier: { command: ["prettier"], environment: { TOKEN: SECRET } } },
    });
    const plugin = record((redacted.plugins as unknown[])[0]);
    expect(record(plugin.env).TOKEN).toBe(REDACTED_CONFIG_VALUE);
    expect(record(plugin.options).key).toBe(REDACTED_CONFIG_VALUE);
    const lsp = record(record(redacted.lsp).myserver);
    expect(record(lsp.env).TOKEN).toBe(REDACTED_CONFIG_VALUE);
    const formatter = record(record(redacted.formatter).prettier);
    expect(record(formatter.environment).TOKEN).toBe(REDACTED_CONFIG_VALUE);
  });

  it("masks the legacy V1 provider api key", () => {
    const redacted = redactOpenCodeConfigDocument({
      provider: {
        acme: {
          options: { apiKey: SECRET, baseURL: "https://acme.example" },
          models: { "model-one": { options: { key: SECRET }, headers: { Authorization: SECRET } } },
        },
      },
    });
    const provider = record(record(redacted.provider).acme);
    expect(record(provider.options).apiKey).toBe(REDACTED_CONFIG_VALUE);
    expect(record(provider.options).baseURL).toBe("https://acme.example");
    const model = record(record(provider.models)["model-one"]);
    expect(record(model.options).key).toBe(REDACTED_CONFIG_VALUE);
    expect(record(model.headers).Authorization).toBe(REDACTED_CONFIG_VALUE);
  });

  it("masks the substitution forms, which name a secret without holding one", () => {
    const redacted = redactOpenCodeConfigDocument({
      providers: {
        acme: {
          settings: {
            apiKey: { env: "ACME_API_KEY" },
            certificate: { file: "/run/secrets/acme.pem" },
          },
        },
      },
    });
    const settings = record(record(record(redacted.providers).acme).settings);
    expect(settings.apiKey).toBe(REDACTED_CONFIG_VALUE);
    expect(settings.certificate).toBe(REDACTED_CONFIG_VALUE);
    // The referenced value is never substituted into the response.
    expect(JSON.stringify(redacted)).not.toContain("ACME_API_KEY");
    expect(JSON.stringify(redacted)).not.toContain("/run/secrets/acme.pem");
  });

  it("masks a credential-named key wherever it appears", () => {
    const redacted = redactOpenCodeConfigDocument({
      somethingUnknown: { apiKey: SECRET, nested: { client_secret: SECRET } },
    });
    const unknown = record(redacted.somethingUnknown);
    expect(unknown.apiKey).toBe(REDACTED_CONFIG_VALUE);
    expect(record(unknown.nested).client_secret).toBe(REDACTED_CONFIG_VALUE);
  });

  it("leaves everything that is not a credential untouched", () => {
    const doc = {
      $schema: "https://opencode.ai/config.json",
      shell: "powershell",
      model: "anthropic/claude-sonnet-4-5",
      username: "someone",
      permissions: [
        { action: "question", resource: "*", effect: "ask" },
        { action: "shell", resource: "**/config/RULES.md", effect: "deny" },
      ],
    };
    expect(redactOpenCodeConfigDocument(doc)).toEqual(doc);
  });

  it("does not modify the document it was given", () => {
    const doc = { providers: { acme: { settings: { apiKey: SECRET } } } };
    redactOpenCodeConfigDocument(doc);
    expect((doc.providers.acme.settings as Record<string, unknown>).apiKey).toBe(SECRET);
  });
});

describe("redactOpenCodeConfigText", () => {
  it("redacts the text and keeps the shape", () => {
    const raw = JSON.stringify(
      {
        shell: "powershell",
        providers: { acme: { settings: { apiKey: SECRET } } },
        permissions: [{ action: "question", resource: "*", effect: "ask" }],
      },
      null,
      2,
    );
    const text = redactOpenCodeConfigText(raw);
    expect(text).not.toContain(SECRET);
    expect(text).toContain(REDACTED_CONFIG_VALUE);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.shell).toBe("powershell");
    expect(parsed.permissions).toEqual([{ action: "question", resource: "*", effect: "ask" }]);
  });

  it("withholds text it cannot parse, because it cannot redact it", () => {
    expect(redactOpenCodeConfigText("{ this is not json")).toBe("");
    expect(redactOpenCodeConfigText("[1, 2, 3]")).toBe("");
  });

  it("leaves an empty file empty", () => {
    expect(redactOpenCodeConfigText("")).toBe("");
    expect(redactOpenCodeConfigText("   \n ")).toBe("   \n ");
  });
});
