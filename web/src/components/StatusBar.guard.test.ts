import { describe, it, expect, beforeAll } from "bun:test";

/**
 * Source-level guards for the bottom status bar's mode-aware model display
 * and the live server-port indicator.
 *
 * Not behavioural — `web/` has no DOM runner. These guards pin the specific
 * code paths so a regression (e.g. a Code chat falling back to the Direct
 * label, or the port indicator using `configuredPort` instead of
 * `activePort`) fails here rather than silently.
 *
 * File guarded: StatusBar.tsx
 */

let source = "";

beforeAll(async () => {
  source = await Bun.file(
    new URL("./StatusBar.tsx", import.meta.url),
  ).text();
});

describe("StatusBar — Code route shows agent·model from conversation config", () => {
  it("branches on the /code pathname prefix", () => {
    expect(source).toMatch(/pathname\.startsWith\("\/code"\)/);
  });

  it("reads the OpenCode conversation config only on Code routes", () => {
    // The hook must receive `agentId` only when `isCode`, so non-Code
    // routes never mount a Code config reader.
    expect(source).toMatch(
      /useOpenCodeConversationConfig\(\s*isCode \? agentId : undefined,\s*\)/,
    );
  });

  it("builds the Code label from opencodeAgent + opencodeModel, joined with a separator", () => {
    expect(source).toMatch(
      /codeConfig\.opencodeAgent,\s*codeConfig\.opencodeModel[\s\S]*?\.filter\(\(v\): v is string => !!v\)[\s\S]*?\.join\(" · "\)/,
    );
  });

  it("renders nothing on the right for a Code chat with no bound conversation yet", () => {
    // `codeLabel` is `null` when `codeConfig` is absent — the right button
    // only renders when `rightLabel` is truthy.
    expect(source).toMatch(/const codeLabel = codeConfig[\s\S]*?: null/);
    expect(source).toMatch(/\{rightLabel \? \(/);
  });

  it("uses the Code label (not Direct) on Code routes", () => {
    // `rightLabel` must select `codeLabel` when `isCode` and `directLabel` otherwise.
    expect(source).toMatch(/rightLabel\s*=\s*isCode \? codeLabel : directLabel/);
  });
});

describe("StatusBar — non-Code routes keep the Direct label, never fall back to Code", () => {
  it("computes a Direct label from the selected/active provider + model", () => {
    expect(source).toMatch(/directLabel\s*=\s*provider[\s\S]*?provider\.name[\s\S]*?copy\.noProvider/);
  });

  it("uses the Code label only under isCode (no leak on non-Code routes)", () => {
    // The right-label selection is the single gate: when not `isCode` the
    // Code config must not leak into the label.
    expect(source).toMatch(/rightLabel\s*=\s*isCode \? codeLabel : directLabel/);
    // And the Code config hook is only fed `agentId` when `isCode`
    // (otherwise `undefined`), so non-Code routes never mount a Code reader.
    expect(source).toMatch(/useOpenCodeConversationConfig\(\s*isCode \? agentId : undefined,\s*\)/);
  });
});

describe("StatusBar — server button reflects identity activePort", () => {
  it("reads the live activePort from useServerIdentity", () => {
    expect(source).toMatch(/const \{ identity \} = useServerIdentity\(\)/);
    expect(source).toMatch(/identity\?\.activePort/);
  });

  it("renders `:activePort` (not configuredPort) in the button", () => {
    // The port span must show the active port, with a placeholder when absent.
    expect(source).toMatch(
      /serverPort != null \? `:\$\{serverPort\}` : "…"/,
    );
    // And the server title must also reference the active port.
    expect(source).toMatch(/\(port \$\{serverPort\}\)/);
  });

  it("uses `…` (ellipsis) when the port is not yet known, not a fake value", () => {
    expect(source).toMatch(/serverPort != null \? `:\$\{serverPort\}` : "…"/);
  });
});
