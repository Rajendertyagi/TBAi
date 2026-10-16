import { describe, it, expect, beforeAll } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";
import { ROUTES } from "@web/config/navigation.ts";

/**
 * Source-level guards for the bottom status bar's mode-aware model display
 * and the live server-port indicator.
 *
 * Not behavioural — `web/` has no DOM runner. These guards pin the specific
 * code paths so a regression (e.g. a Code chat falling back to the Direct
 * label, or the port indicator using `configuredPort` instead of
 * `activePort`) fails here rather than silently.
 *
 * Files guarded: StatusBar.tsx (shell + Direct label + port) and
 * OpenCodeStatusBarLabel.tsx (the Code label, extracted out of StatusBar so
 * the shell carries no static opencode import). The Code-route invariants
 * used to be asserted wholly against StatusBar.tsx; they now span both files,
 * so the assertions follow the code rather than being deleted.
 */

let source = "";
let codeLabelSource = "";

beforeAll(async () => {
  source = await Bun.file(path.join(REPO_ROOT, "web/src/components/StatusBar.tsx")).text();
  codeLabelSource = await Bun.file(
    path.join(REPO_ROOT, "web/src/features/opencode/OpenCodeStatusBarLabel.tsx"),
  ).text();
});

describe("StatusBar — Code route shows agent·model from conversation config", () => {
  it("branches on the /code pathname prefix", () => {
    // The prefix is the shared route constant; assert it is used AND that it
    // resolves to `/code`, so the invariant (Code-ness is decided by the
    // pathname prefix) is preserved rather than merely re-spelling the literal.
    expect(source).toMatch(/pathname\.startsWith\(ROUTES\.CODE\)/);
    expect(ROUTES.CODE).toBe("/code");
  });

  it("reads the OpenCode conversation config only on Code routes", () => {
    // The Code config reader lives inside `OpenCodeStatusBarLabel`, which
    // StatusBar mounts ONLY under the `isCode` branch and feeds the route's
    // `agentId`. Non-Code routes never mount that reader.
    expect(source).toMatch(/isCode \? \(\s*<OpenCodeStatusBarLabel agentId=\{agentId\}/);
    expect(codeLabelSource).toContain("useOpenCodeConversationConfig(agentId)");
  });

  it("builds the Code label from opencodeAgent + opencodeModel, joined with a separator", () => {
    expect(codeLabelSource).toMatch(
      /codeConfig\.opencodeAgent,\s*codeConfig\.opencodeModel[\s\S]*?\.filter\(\(v\): v is string => !!v\)[\s\S]*?\.join\(" · "\)/,
    );
  });

  it("renders nothing on the right for a Code chat with no bound conversation yet", () => {
    // `codeLabel` is `null` when `codeConfig` is absent, and the label
    // component returns null in that case — so a Code chat with no bound
    // conversation renders nothing on the right rather than a stale model.
    expect(codeLabelSource).toMatch(/const codeLabel = codeConfig[\s\S]*?: null/);
    expect(codeLabelSource).toMatch(/if \(!codeLabel\) return null;/);
  });

  it("uses the Code label (not Direct) on Code routes", () => {
    // On Code routes the Direct label is suppressed and the Code label
    // component is rendered in its place — the two never coexist.
    expect(source).toMatch(/rightLabel\s*=\s*isCode \? null : directLabel/);
    expect(source).toMatch(/isCode \? \(\s*<OpenCodeStatusBarLabel/);
  });
});

describe("StatusBar — non-Code routes keep the Direct label, never fall back to Code", () => {
  it("computes a Direct label from the selected/active provider + model", () => {
    expect(source).toMatch(
      /directLabel\s*=\s*provider[\s\S]*?provider\.name[\s\S]*?copy\.noProvider/,
    );
  });

  it("uses the Code label only under isCode (no leak on non-Code routes)", () => {
    // The right-label selection is the single gate: when not `isCode` the
    // Code label component is not rendered and the Direct label is used.
    expect(source).toMatch(/rightLabel\s*=\s*isCode \? null : directLabel/);
    // And the Code config reader only mounts inside that branch.
    expect(source).toMatch(/isCode \? \(\s*<OpenCodeStatusBarLabel/);
    expect(codeLabelSource).toContain("useOpenCodeConversationConfig(agentId)");
  });
});

describe("StatusBar — server button reflects identity activePort", () => {
  it("reads the live activePort from useServerIdentity", () => {
    expect(source).toMatch(/const \{ identity \} = useServerIdentity\(\)/);
    expect(source).toMatch(/identity\?\.activePort/);
  });

  it("renders `:activePort` (not configuredPort) in the button", () => {
    // The port span must show the active port, with a placeholder when absent.
    expect(source).toMatch(/serverPort != null \? `:\$\{serverPort\}` : "…"/);
    // And the server title must also reference the active port.
    expect(source).toMatch(/\(port \$\{serverPort\}\)/);
  });

  it("uses `…` (ellipsis) when the port is not yet known, not a fake value", () => {
    expect(source).toMatch(/serverPort != null \? `:\$\{serverPort\}` : "…"/);
  });
});
