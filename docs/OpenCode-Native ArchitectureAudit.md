TBAi — OpenCode-Native Architecture Audit and Reference Application Study (Read-only)

Status: Read-only audit completed. No source, tests, manifests, lockfiles, config, DB, branches, or dependencies were modified. No tests/builds were run. The recent SDK 2.2.6 alignment is treated as existing work and was not undone.

Evidence basis (verified): current working tree at develop/c8a2927 with uncommitted alignment changes (package.json, web/package.json, bun.lock, src/services/opencode/scheduledExecution.ts, tests/unit/scheduler/opencode-scheduler.test.ts) and untracked docs/scripts; TBAi source under src/services/opencode/*, src/routes/opencode.ts, src/services/scheduler/*, web/src/features/opencode/*, web/src/tools/opencode/*; installed @opencode/client@2.2.6 / @opencode/protocol@2.2.6 / @opencode/schema@2.2.6 type surfaces in node_modules; local reference clones/docs found at D:\Temp\openchamber, D:\Temp\paseo, D:\Temp\codeg, D:\Coding\OpenChamber, D:\Coding\Paseo, D:\Coding\Codeg, and untracked docs/2026-11-08-codeg-settings-reference-study.md. Upstream OpenCode runtime behavior beyond installed SDK/types and repository-documented evidence is marked where not directly verified from tagged upstream source in this session.

Limitations: Web search was unavailable (HTTP 402), so external repository/version identification relied on local clones and installed artifacts. VS Code source was not inspected locally; VS Code findings are limited to well-known architectural patterns and are explicitly marked non-code-inspected. Paseo/OpenChamber/CodeG findings are sampled from local clones (not exhaustive). No live OpenCode server, cross-client runtime, or DB was exercised.

A. Executive summary

What TBAi is doing correctly

• Clear ownership boundary in intent: OpenCode is treated as the execution/session/runtime authority in core paths (src/services/opencode/sessions.ts, scheduledExecution.ts, web/src/features/opencode/v2Client.ts, v2ThreadController.ts, v2Events.ts), while TBAi owns app UI, conversation records, scheduler jobs/runs, workspace resolution, and app-specific persistence (src/services/storage/*, src/services/scheduler/*, src/routes/*, web/src/features/*).
• Official SDK/client reuse where it matters: backend uses OpenCode.make/generated client (src/services/opencode/client.ts), frontend uses official browser client/types (web/src/features/opencode/v2Client.ts), and scheduler wait was aligned to client.experimental.session.wait for SDK 2.2.6 (src/services/opencode/scheduledExecution.ts).
• Safety-first connection/lifecycle posture: loopback/origin-bound transport and redirect refusal (src/services/opencode/http.ts, connectionState.ts), registration read/validation as discovery hint not authority (registration.ts), adoption probe/capability assessment before install (adoption.ts, compatibility.ts), DB ownership lease/checks (ownership.ts), history/service boundary enforcement (historyBoundary.ts, serviceAccess.ts, runtimeTarget.ts), and proxy allowlist + authorization + server-resolved directory scope (src/routes/opencode.ts, proxyRoutes.ts, proxyAuthorization.ts).
• Durable recovery and integrity work: caller-minted session IDs, intent/journal/orphan reconciliation, bounded recovery, and fail-closed behavior around persistence/ownership (sessions.ts, orphanReconciler.ts, conversationDeletion.ts, connectionState.ts) preserve RT-001-style durability goals.
• Independent-client direction: supports managed and adopted/external-compatible service concepts without requiring a reference app runtime dependency; proxy and browser client are TBAi-owned boundaries.

Where it duplicates OpenCode

• Lifecycle/discovery surface duplication: custom registration parsing, adoption probing, managed server spawn/readiness/listening/capability/version handling, and runtime target resolution (registration.ts, adoption.ts, serverManager.ts, listening.ts, runtime.ts, compatibility.ts, capabilities.ts, startup.ts) sit alongside official SDK/service concepts (Service.discover/ensure/stop, server.info, model/agent/command/config APIs). Some duplication is intentional for safety/ownership, but the amount of bespoke lifecycle logic is high.
• Session/history projection complexity: TBAi maintains extensive local session lifecycle, reconciliation, import, history-boundary, and frontend event/history projection logic (sessions.ts, historyBoundary.ts, serviceAccess.ts, import.ts, web/src/features/opencode/v2Events.ts, v2History.ts, v2MessageProjection.ts, v2ThreadController.ts) over OpenCode’s authoritative session/message/event APIs.
• Config/command/capability mediation: backend re-exposes and sometimes transforms OpenCode config/commands/capabilities through custom routes and write policies (routes/opencode.ts, configDocument.ts, configWritePolicy.ts, commands.ts, capabilities.ts) rather than consistently using direct official client flows where safe.

What is unnecessarily complicated

• serverManager.ts concentration (61k+) and cross-cutting state: process spawn, listening discovery, readiness, auth, DB lease verification, compatibility/capability checks, shutdown/stop coordination, and fallback behavior are tightly coupled. This raises maintenance and correctness risk even when individual safeguards are justified.
• Multiple overlapping abstractions for “which service owns this”: connectionState, runtimeTarget, serviceAccess, historyBoundary, serviceProfile, registration, adoption, and proxy authorization each encode parts of ownership/scope. Necessary distinctions exist (managed/adopted/local/remote/history owner), but boundaries are hard to reason about.
• Frontend V2 runtime size/scope: v2ThreadController.ts (~85k), v2Events.ts (~57k), V2FormCard.tsx, v2Permissions.ts, v2History.ts, etc. implement a large custom synchronization/projection layer. Some is required by assistant-ui/TBAi UX, but the surface is large and likely contains simplification opportunities once upstream contracts are pinned.
• Config write path complexity vs policy outcome: config read/write routes and document/redaction/write-policy modules are substantial, while writes are broadly refused by policy/runtime constraints (routes/opencode.ts applyPermissionChange/configWriteRefusalForRuntime, configWritePolicy.ts). The safety outcome is good; implementation may be heavier than needed for current product behavior.

What should remain custom

• TBAi-owned app concerns: conversation records/folders/workspaces, scheduler jobs/runs and unattended execution policy, UI/UX, settings, and TBAi-specific persistence (src/db/*, src/services/storage/*, src/services/scheduler/*, web/src/features/*).
• Security and ownership guardrails: no credential leakage to browser, origin-bound credential transport, proxy allowlist/authorization, DB ownership fail-closed checks, refusal to control/stop non-owned services, and history-boundary enforcement.
• Durable recovery semantics TBAi promises: RT-001 caller-minted IDs, intent/journal/orphan reconciliation, and scheduler turn reconciliation/outcome classification where OpenCode/TBAi contracts require TBAi-side durability.
• Thin adapters only: mapping OpenCode SDK/event/history shapes into assistant-ui/TBAi UI state, and translating TBAi scheduler/workspace/conversation context into OpenCode calls.

What should be simplified

• Separate “safety policy” from “lifecycle mechanics”: keep TBAi ownership/authorization decisions, but reduce bespoke lifecycle orchestration where official SDK/service behavior can be wrapped safely (especially read-only discovery/status/capability probing) without adopting Service.ensure/stop semantics for non-owned services.
• Consolidate service-resolution vocabulary: make history owner / runtime target / service access / proxy scope derivable from one canonical internal model with explicit invariants and fewer translation points.
• Narrow frontend projection responsibilities: isolate pure event/history normalization from UI/controller concerns; prefer official SDK types/streams and reduce custom state machines where upstream behavior is sufficient.
• Document and enforce capability-driven degradation: use B7-style capability snapshots consistently (already present in parts) instead of scattered version/name assumptions.

Recommended architecture (high level)

• OpenCode (authoritative): execution, sessions/messages/history/events, providers/models/agents/tools/permissions, runtime state, and supported server APIs.
• TBAi Core (authoritative for app): conversations/workspaces/folders, scheduler definitions/runs, app settings, UI state, and policy decisions.
• TBAi OpenCode Adapter (thin, explicit):
  • Connection/Target Resolver: resolves managed vs adopted/external target, enforces loopback/origin/credential binding, never controls non-owned services.
  • Official Client Gateway: single place to construct/use @opencode/client for backend and browser-proxied flows; no parallel protocol/client.
  • Session/History Boundary Guard: enforces conversation↔service ownership and directory scoping before any OpenCode call/proxy.
  • Recovery Coordinator: only TBAi-specific durability (intent/orphan/reconciliation/scheduler outcome) layered on official session/inbox/message APIs.
  • UI Projection Layer: maps official events/history/permissions/forms to assistant-ui/TBAi components; no execution ownership.

B. Reference application findings

Evidence note: findings below are based on sampled inspection of local clones/docs where available. They are patterns to learn from, not dependencies or prescriptions.

1) OpenChamber

Relevant implementation patterns (sampled evidence):

• Strong product/docs focus on OpenCode server connection and session/workflow concepts (packages/docs/content/docs/opencode-server.mdx, .../troubleshooting/opencode-connection.mdx, session-goals.mdx, sessions-in-work.mdx across locales in D:\Temp\openchamber\packages\docs\content\docs\*).
• Operational/tooling emphasis around OpenCode workflows and smoke/review automation (.github/workflows/opencode.yml, .github/workflows/opencode-smoke.yml, .opencode/agent/*, .opencode/commands/*, .agents/skills/opencode-v2/*).
• Appears to treat OpenCode integration as a first-class product concern with explicit connection/session UX and troubleshooting surfaces (docs paths above).

Useful product and architecture decisions for TBAi:

• Make connection mode, ownership, and failure states explicit in UX/docs (managed vs external/adopted, unreachable, incompatible, unauthorized) — aligns with TBAi’s existing refusal taxonomy.
• Keep OpenCode-specific operational knowledge close to integration boundaries (skills/docs/tests) to reduce accidental protocol drift.
• Invest in targeted smoke/compatibility checks around real OpenCode server behavior for supported versions.

Potential improvements for TBAi:

• Simplify operator-facing diagnostics around “which service owns this conversation/session” using TBAi’s existing historyBoundary/runtime status concepts.
• Add clearer compatibility/capability reporting surfaces (TBAi already has B7-style data in places; expose consistently).

Patterns that should not be adopted:

• Any workflow/process automation that assumes control over an external OpenCode server lifecycle.
• Any coupling to OpenChamber-specific registries, protocols, or runtime assumptions (none observed as required; must remain absent).

Exact source files/references supporting findings: D:\Temp\openchamber\packages\docs\content\docs\opencode-server.mdx, D:\Temp\openchamber\packages\docs\content\docs\troubleshooting\opencode-connection.mdx, D:\Temp\openchamber\packages\docs\content\docs\session-goals.mdx, D:\Temp\openchamber\packages\docs\content\docs\sessions-in-work.mdx, D:\Temp\openchamber\.github\workflows\opencode.yml, D:\Temp\openchamber\.github\workflows\opencode-smoke.yml, D:\Temp\openchamber\.agents\skills\opencode-v2\SKILL.md.

2) Paseo

Relevant implementation patterns (sampled evidence):

• Explicit OpenCode-focused integration/testing artifacts: docs/opencode-global-event-baseline.md, browser/e2e specs for OpenCode model switch/rewind/import/session flows (packages/app/e2e/browser/opencode-model-switch.real.spec.ts, rewind-flow.opencode.real.spec.ts, import-session.opencode.real.spec.ts, import-session-flow.spec.ts), and client/session UI/routes (packages/app/src/app/sessions.tsx, host/session routes under packages/app/src/app/h/[serverId]/...).
• Session decomposition/refactor planning and import/session helpers indicate attention to session lifecycle complexity (docs/refactors/session-decomposition-plan.md, packages/app/src/components/import-session-list*.tsx, packages/app/e2e/support/helpers/import-session.ts).

Useful product and architecture decisions for TBAi:

• Treat session import, rewind/model switching, and event-stream behavior as first-class compatibility scenarios with dedicated tests/fixtures.
• Decompose session/event handling into explicit modules with testable boundaries (relevant to TBAi’s large v2ThreadController/v2Events).

Potential improvements for TBAi:

• Strengthen real-server compatibility/e2e coverage for event ordering, reconnect, import, and model/agent switching against supported OpenCode versions (without weakening ownership/safety).
• Consider clearer separation between session transport/sync state and UI projection in frontend OpenCode feature.

Patterns that should not be adopted:

• Any host/server routing model that assumes Paseo’s multi-host product topology unless TBAi explicitly needs it.
• Any test harness assumptions that require external app infrastructure.

Exact source files/references supporting findings: D:\Temp\paseo\docs\opencode-global-event-baseline.md, D:\Temp\paseo\docs\refactors\session-decomposition-plan.md, D:\Temp\paseo\packages\app\e2e\browser\opencode-model-switch.real.spec.ts, D:\Temp\paseo\packages\app\e2e\browser\rewind-flow.opencode.real.spec.ts, D:\Temp\paseo\packages\app\e2e\browser\import-session.opencode.real.spec.ts, D:\Temp\paseo\packages\app\src\app\sessions.tsx, D:\Temp\paseo\packages\app\src\components\import-session-list.tsx.

3) VS Code

Relevant implementation patterns (not code-inspected locally):

• Extension/client boundary discipline: host/platform capabilities exposed through stable APIs; extensions contribute commands/views/providers without owning core runtime internals.
• Command and contribution model: declarative contributions + command routing enable extensibility while keeping core state transitions centralized.
• State separation: UI/view state, workspace state, and service/runtime state are separated to support multiple windows/workspaces and recovery.

Useful product and architecture decisions for TBAi:

• Keep OpenCode runtime/client concerns behind narrow internal interfaces (analogous to service/provider boundaries), with UI consuming typed capabilities/events rather than protocol details.
• Centralize command/action dispatch for OpenCode operations (prompt, interrupt, compact, permission/form replies) to reduce duplicated state transitions.

Potential improvements for TBAi:

• Formalize an internal “OpenCode capability/provider” contract for UI surfaces (commands, config, permissions, forms, models/agents) driven by probed capabilities.

Patterns that should not be adopted:

• Full extension-host/plugin architecture complexity; TBAi does not need VS Code-scale extensibility.
• Generic abstraction layers that obscure OpenCode’s authoritative API behavior.

Exact source files/references supporting findings: None (local source not inspected). Limitation documented; no implementation details invented.

4) CodeG

Relevant implementation patterns (sampled evidence):

• OpenCode appears as a significant integration/configuration domain with dedicated UI and backend modules: settings/connect/behavior/permissions/plugins components and tests (src/components/settings/opencode-*.tsx, src/lib/opencode-*.ts), Rust-side ACP/OpenCode config/launch/credentials/catalog/plugins/skills/parsers (src-tauri/src/acp/opencode_*.rs, src-tauri/src/commands/opencode_credentials.rs, src-tauri/src/parsers/opencode*.rs), and model catalog resource (src-tauri/resources/opencode/models-dev.json).
• Existing TBAi study doc (untracked, read-only context) highlights CodeG’s disciplined boundaries: typed domain owners, explicit storage boundaries, secrets outside portable settings, and event/broadcast patterns for convergence (docs/2026-11-08-codeg-settings-reference-study.md).

Useful product and architecture decisions for TBAi:

• Treat OpenCode configuration/credentials/permissions as explicit domains with validation, redaction, and clear ownership boundaries.
• Prefer typed normalization and allowlisted persistence boundaries over generic catch-all stores (relevant to TBAi app settings, not OpenCode runtime authority).

Potential improvements for TBAi:

• Reuse TBAi’s existing redaction/config-write-policy discipline consistently across all OpenCode-facing surfaces; keep “readable but not writable” states explicit (already partially done in routes/opencode.ts).
• Where TBAi exposes OpenCode config UX, keep projections minimal and capability-aware.

Patterns that should not be adopted:

• CodeG’s broader Tauri/web event bridge, config-sync, or ACP-specific architecture unless TBAi has the same product requirements.
• Any storage of secrets/credentials in portable or browser-visible forms.

Exact source files/references supporting findings: D:\Temp\codeg\src/components/settings/opencode-connect-dialog.tsx, D:\Temp\codeg\src/components/settings/opencode-behavior-section.tsx, D:\Temp\codeg\src/components/settings/opencode-permissions-section.tsx, D:\Temp\codeg\src/components/settings/opencode-plugins-modal.tsx, D:\Temp\codeg\src/lib/opencode-connect.ts, D:\Temp\codeg\src/lib/opencode-permissions.ts, D:\Temp\codeg\src-tauri/src/acp/opencode_config.rs, D:\Temp\codeg\src-tauri/src/acp/opencode_launch.rs, D:\Temp\codeg\src-tauri/src/acp/opencode_credentials.rs, D:\Temp\codeg\src-tauri/src/acp/opencode_catalog.rs, D:\Temp\codeg\src-tauri/src/parsers/opencode.rs, D:\Temp\ai-chat-app\docs\2026-11-08-codeg-settings-reference-study.md (untracked, read-only).

C. OpenCode capability audit (verified against installed SDK 2.2.6 types)

Capability area	Verified official SDK/API interface (@opencode/client@2.2.6)	Evidence	Notes
Server info/connect	client.server.info(), client.server.pair(), client.server.connect(input)	node_modules/@opencode/client/dist/promise/generated/client.d.ts	TBAi uses server info/readiness concepts; pairing/connect not central to current TBAi flow.
Session lifecycle	client.session.list/create/get/remove/fork/update/move/active/switchAgent/switchModel	same	TBAi uses create/get/remove/interrupt/active-related flows and custom recovery/persistence.
Prompting & commands	client.session.prompt, client.session.command, client.session.synthetic, client.session.shell, client.session.compact	same	TBAi scheduler uses prompt, inbox, message.list, experimental.session.wait; web runtime uses prompt/compact/interrupt/revert/forms/permissions.
Inbox	client.session.inbox.list/cancel/update	same	Used by scheduler reconciliation/cancellation (scheduledExecution.ts).
Revert/context/diff	client.session.revert.stage/clear/commit, client.session.context, client.session.diff	same	Web V2 runtime exposes revert operations (v2Client.ts).
Messages/history	client.message.list(input)	same	Used by scheduler reconciliation and web history reader (v2Client.ts, v2History.ts).
Events	client.event.subscribe(input?, requestOptions?) -> AsyncIterable<EventSubscribeOutput>	same	Core to web V2 generation/event pipeline (v2Client.ts, v2Events.ts).
Permissions	client.permission.request.list, client.permission.saved.*, client.permission.create/list/get/reply	same	Web runtime handles permission list/reply/projection (v2Client.ts, v2Permissions.ts).
Forms/questions	client.session.form.list/create/get/reply/cancel, client.form.list	same	Web runtime handles form list/reply/cancel (v2Client.ts, v2Forms.ts, V2FormCard.tsx).
Providers/models/agents/commands/skills	client.provider.list/get, client.model.list/default, client.agent.list/get, client.command.list, client.skill.list	same	TBAi discovers capabilities/commands/models/agents via backend services/routes.
Config	client.config.get(), client.config.shells(), client.experimental.config.update(input)	same	TBAi currently reads config via server/proxy/document flows and restricts writes by policy (routes/opencode.ts, configWritePolicy.ts).
Experimental session ops (moved in 2.2.6)	client.experimental.session.wait/log/stats/import/export/skill/instructions.*	same	wait actively used by scheduler; others not found in active TBAi app code.
Local service lifecycle helpers	Service.discover/ensure/stop/headers from @opencode/client service entry (node_modules/@opencode/client/dist/promise/service.d.ts)	installed service types	Not adopted in TBAi; TBAi intentionally avoids ensure/stop for non-owned services and keeps custom ownership/lifecycle controls.
PTY/shell/worktree/vcs/debug/media/schedule/artifacts/etc.	Extensive additional namespaces in generated client	same	Present in SDK; mostly outside current TBAi OpenCode integration scope except selective proxy/feature needs.

Verification boundary: This confirms SDK-exposed interfaces in the installed 2.2.6 package. It does not by itself prove runtime semantics for every endpoint/version combination beyond what TBAi already exercises or documents.

D. TBAi file-level assessment

File/component	Current responsibility	Official alternative	Decision	Reason
src/services/opencode/client.ts	Creates official OpenCode.make client, wraps transport, records response status for diagnostics	Official @opencode/client (OpenCode.make)	KEEP	Correct thin boundary over official client; preserves TBAi transport/diagnostic needs without custom protocol.
src/services/opencode/http.ts	Origin-bound/gated transport, redirect refusal, credential scoping primitives	SDK accepts custom fetch; no TBAi-specific safety policy in SDK	KEEP	Essential security/ownership guardrail (A1.9/R1-style constraints); must not be weakened.
src/services/opencode/runtime.ts	Binary/version/auth/header/runtime helpers, managed auth metadata	Partial (server.info, SDK headers options) but not TBAi managed-binary policy	KEEP (SIMPLIFY later)	Needed for managed mode and auth scoping; review for minimalism after lifecycle plan.
src/services/opencode/connectionState.ts	Target/attempt/shutdown epoch/latch, request context capture, transport binding	No official equivalent for TBAi multi-mode ownership state	KEEP	Core safety/state authority preventing credential/target races; complex but load-bearing.
src/services/opencode/registration.ts	Reads/validates OpenCode registration/config hints as discovery input (fail-closed)	Service.discover exists but has different authority/behavior; not sufficient alone	KEEP (SIMPLIFY)	Useful as guarded hint parsing; must remain non-authoritative and secret-safe. Consider narrower reuse only behind TBAI policy.
src/services/opencode/adoption.ts	Adoption attempt orchestration: validate, probe, capability assess, install adopted target	Service.discover (read-only discovery) partial; no TBAI ownership/capability policy	KEEP (SIMPLIFY)	Necessary for safe external-server adoption; can be decomposed but not removed.
src/services/opencode/serverManager.ts	Managed opencode serve lifecycle, listening/readiness, DB lease verification, capability checks, shutdown	Service.ensure/stop exist but control lifecycle and are unsafe for non-owned/adopted cases	KEEP (SIMPLIFY)	Required for TBAi-managed mode and ownership guarantees; too large/coupled and should be split by responsibility.
src/services/opencode/listening.ts	Parses/validates child listening announcements, conflict detection	No official TBAi-side equivalent	KEEP	Prevents port/address guessing; supports safe managed startup.
src/services/opencode/ownership.ts	DB path resolution and ownership/lease/holder checks (fail-closed)	opencode debug paths db used as authority; no SDK ownership guard	KEEP	Critical invariant (no shared DB/process conflicts); do not weaken.
src/services/opencode/startup.ts	Startup sequencing (adoption vs managed fallback)	Partial via service helpers, but policy differs	KEEP (SIMPLIFY)	Product/policy orchestration; simplify once target model consolidated.
src/services/opencode/runtimeTarget.ts	Resolves server-wide runtime target and transport; status description	No official TBAI concept	KEEP	Correct place to bind server-wide calls to installed target without leaking credentials.
src/services/opencode/serviceAccess.ts	Conversation-scoped service/history access resolution and refusal	No official TBAI concept	KEEP	Enforces history ownership boundary before OpenCode calls.
src/services/opencode/historyBoundary.ts	Local/remote history owner model, canonicalization, compatibility checks	No official TBAI concept	KEEP (SIMPLIFY)	Essential for cross-service safety; vocabulary/translation complexity can be reduced.
src/services/opencode/serviceProfile.ts	Service profile identity/data-location metadata	No official TBAI concept	KEEP	Small supporting abstraction; useful if kept minimal.
src/services/opencode/sessions.ts	Session ensure/create/reuse/reconcile/terminate/activity, RT-001 intent/orphan handling, mismatch guards	Official session.*, message.list, session.active etc.	KEEP (SIMPLIFY)	Contains necessary TBAI durability/ownership logic over official APIs; large and should be modularized by concern.
src/services/opencode/sessionModel.ts	Model selection/default resolution helpers	client.model.default/list	SIMPLIFY	Keep TBAI selection policy, but prefer direct official model APIs and reduce duplication.
src/services/opencode/capabilities.ts	Agent/model/default capability discovery for TBAI surfaces	agent.list, model.list, model.default	SIMPLIFY	Useful adapter/cache/polling behavior may exist, but should stay thin over official APIs and capability snapshots.
src/services/opencode/compatibility.ts	Version/capability probing and compatibility assessment (B7-style)	server.info and route probing via official HTTP/client transport	KEEP (SIMPLIFY)	Necessary for safe adoption/feature degradation; keep evidence-based and capability-driven.
src/services/opencode/commands.ts	Command feed retrieval for composer/UI	client.command.list	SIMPLIFY	Thin wrapper acceptable; avoid extra transformation/state.
src/services/opencode/configDocument.ts	Reads/writes OpenCode config documents with structural preservation/refusal rules	client.config.get, client.experimental.config.update (and server config behavior)	NEEDS FURTHER INVESTIGATION	Safety-preserving today, but dual path (document editing vs official config APIs) needs careful comparison for managed/adopted modes and upstream guarantees.
src/services/opencode/configRedaction.ts	Redacts config secrets/values for UI/API responses	No official TBAI redaction policy	KEEP	Required security boundary.
src/services/opencode/configWritePolicy.ts	Determines when config writes are allowed/refused	No official TBAI policy	KEEP	Correct fail-closed policy layer; may simplify if write UX remains read-only.
src/services/opencode/proxyRoutes.ts	Allowlist of browser-forwardable OpenCode routes	No official TBAI browser proxy policy	KEEP	Essential attack-surface control.
src/services/opencode/proxyAuthorization.ts	Resolves session/directory scope and authorizes proxy requests	No official TBAI policy	KEEP	Prevents caller-chosen directory/session scope abuse.
src/services/opencode/import.ts	Lists/imports external OpenCode sessions into TBAI conversations	Official session.list/get (and possibly experimental import/export APIs)	NEEDS FURTHER INVESTIGATION	Product feature may be valid; verify against official session/import capabilities and ownership constraints.
src/services/opencode/recovery.ts	Recovery helpers for session/runtime recovery flows	Official session/message/inbox APIs	KEEP (SIMPLIFY)	Keep only TBAI-specific recovery semantics not guaranteed upstream.
src/services/opencode/orphanReconciler.ts	Reconciles orphaned/risk-bearing session intents and cleanup state	No official TBAI durability journal	KEEP	Supports RT-001/durability guarantees; complex but purpose-specific.
src/services/opencode/conversationDeletion.ts	Coordinates OpenCode session termination with TBAI conversation deletion	Official session.remove/interrupt	KEEP	Necessary app-level coordination; must preserve non-blocking/idempotent teardown.
src/services/opencode/scheduledExecution.ts	Executes scheduled turns on OpenCode sessions (strategies, inbox/prompt reconciliation, outcome classification)	Official session.prompt, session.inbox.*, message.list, experimental.session.wait	KEEP (SIMPLIFY)	Correct use of official APIs for TBAI scheduler semantics; complex but largely product-specific. Continue minimizing custom inference.
src/services/opencode/errors.ts	Normalizes OpenCode/client errors into TBAI categories/types	SDK throws typed/structured errors partially	KEEP	Useful adapter boundary for consistent handling/logging/UI mapping.
src/services/opencode/workspace.ts	Resolves workspace/directory context for OpenCode operations	No official TBAI workspace concept	KEEP	TBAI-owned concern required for correct scoping.
src/routes/opencode.ts	HTTP boundary for session/capabilities/commands/config/import/proxy and diagnostics	Official OpenCode server API (direct)	KEEP (SIMPLIFY)	Necessary TBAI boundary (authz, scoping, redaction, policy, proxy). Reduce route complexity where handlers duplicate service logic.
src/routes/scheduler.ts + src/services/scheduler/*	Scheduler domain, persistence, execution, OpenCode engine integration	OpenCode experimental schedule APIs exist in SDK (experimental.schedule.*) but different product semantics	KEEP	TBAI scheduler is app-owned and richer/different (jobs/runs/history/policies). Do not replace with OpenCode schedules without explicit product/compatibility decision.
web/src/features/opencode/v2Client.ts	Browser wrapper over official OpenCode.make, scoped generation/operations/history/events	Official @opencode/client browser usage	KEEP	Good isolation boundary; enforces session scoping and controlled API surface.
web/src/features/opencode/v2ThreadController.ts	Large controller for connection, prompts, retries, recovery, permissions/forms, state sync	Official event/message/session APIs + assistant-ui runtime primitives	SIMPLIFY	Necessary integration core, but size indicates high maintenance risk; split into tested sync/recovery/admission/projection modules.
web/src/features/opencode/v2Events.ts	Event reduction/projection into TBAI thread state	Official event stream/types	SIMPLIFY	Keep pure reducers/projections; reduce custom semantics not required by UI or verified upstream behavior.
web/src/features/opencode/v2History.ts, v2MessageProjection.ts, v2Types.ts	History fetch/merge and message/part projection to UI model	Official message.list and event/message types	KEEP (SIMPLIFY)	Required adapter layer for assistant-ui/TBAI rendering; keep thin and type-driven.
web/src/features/opencode/v2Permissions.ts, v2Forms.ts, V2FormCard.tsx, OpenCodePermissions.tsx, OpenCodeQuestions.tsx	Permission/form UX and request/reply handling	Official permission/form APIs	KEEP	TBAI-owned UX over official contracts; ensure questions/forms remain distinct from approvals (per repo principles).
web/src/features/opencode/v2Runtime.tsx, useOpenCodeRuntime.ts, OpenCodeView.tsx, CodeShell.tsx	Runtime composition and UI integration	assistant-ui runtime/components + official OpenCode client	KEEP	Correct feature-boundary composition; avoid leaking OpenCode internals into shared chat UI.
web/src/features/opencode/openCodeConfig.ts, OpenCodeConfigPage.tsx, config stores/hooks	Config/capability/status UI consuming TBAi routes	Official config/capability APIs via backend	KEEP (SIMPLIFY)	UI should reflect capability/policy state; simplify if backend write support remains intentionally disabled.
web/src/tools/opencode/*	OpenCode tool rendering/adaptation for TBAI UI	assistant-ui tool UI primitives	KEEP	TBAI-specific rendering layer; appropriately isolated.
tests/unit/opencode/*, tests/integration/opencode/*, scheduler OpenCode tests	Coverage for ownership, sessions, recovery, proxy, compatibility, scheduler integration	N/A	KEEP	Valuable safety net for high-risk invariants; inspect/update only when separately authorized.

E. Proposed target architecture

Component diagram

+----------------------------------------------------------------------------------+
|                                      TBAI UI                                     |
|  web/src/features/chat (shared shell/composer)  +  web/src/features/opencode/*   |
|  assistant-ui primitives/rendering  |  OpenCode view, permissions, forms, status |
+-------------------------------------+--------------------------------------------+
                                      |
                                      | TBAI HTTP (same-origin), scoped session headers/ids
                                      v
+----------------------------------------------------------------------------------+
|                                   TBAI Backend                                   |
|  src/routes/opencode.ts (allowlist + authz + redaction + policy + proxy)         |
|  src/routes/scheduler.ts / conversations / workspace / settings                  |
+---------------------------+---------------------------+--------------------------+
                            |                           |
                            |                           |
                            v                           v
+---------------------------+-----------+   +-----------+--------------------------+
| OpenCode Adapter (thin, policy-first) |   | TBAi App Core (authoritative)        |
| - RuntimeTargetResolver               |   | - SQLite app DB (conversations,      |
| - ServiceAccess/HistoryBoundary       |   |   scheduler, folders, settings, etc.)|
| - Official Client Gateway             |   | - Workspace/scheduler/services       |
|   (@opencode/client 2.2.6)            |   | - Secrets/credentials handling       |
| - Recovery Coordinator (RT-001 only)  |   +--------------------------------------+
| - Capability/Compatibility snapshot   |
+---------------------------+-----------+
                            |
                            | official HTTP/SSE via origin-bound transport
                            v
+----------------------------------------------------------------------------------+
|                               OpenCode Server (authoritative)                    |
|  sessions/messages/history/events/providers/models/agents/tools/permissions/config|
|  managed-by-TBAi mode OR existing compatible external/adopted server             |
+----------------------------------------------------------------------------------+

Component responsibilities and communication

Component	Responsibility	Communicates with	Notes
OpenCode Server	Owns AI execution, session/message/history state, event stream, provider/model/agent/tool/permission runtime behavior	TBAi Official Client Gateway via official API/SSE	Source of truth for runtime/conversation execution state.
Official Client Gateway (client.ts, v2Client.ts)	Construct/use official @opencode/client; no custom protocol; attach bounded transport/request options	OpenCode Server; TBAI adapters/controllers	Single SDK boundary per runtime (backend/browser).
Runtime Target Resolver (runtimeTarget.ts, connectionState.ts, startup.ts, adoption.ts, registration.ts, serverManager.ts)	Select/install managed or adopted target; enforce loopback/origin/credential binding; never control non-owned services	Client Gateway, Service Access, routes/status	Managed lifecycle allowed only for TBAi-owned child; adopted is read/attach only per policy.
Service Access & History Boundary (serviceAccess.ts, historyBoundary.ts, proxyAuthorization.ts)	Map conversation/session to allowed service owner and directory scope; refuse cross-service/mismatched access	Routes/proxy, session/recovery/scheduler adapters, TBAi DB	Prevents cross-service history leakage and caller-chosen scope abuse.
Recovery Coordinator (sessions.ts, orphanReconciler.ts, recovery.ts, conversationDeletion.ts)	TBAI-specific durability: caller-minted IDs, intent/journal, orphan reconciliation, safe termination semantics	TBAI DB, Client Gateway, Service Access	Only where TBAI guarantees exceed or must survive transport/process uncertainty.
Scheduler Adapter (scheduledExecution.ts, scheduler services/routes)	Translate TBAI job/run semantics into OpenCode prompt/inbox/wait/message flows; classify outcomes durably	TBAI scheduler DB/services, Client Gateway, Service Access	App-owned scheduling; OpenCode executes turns.
OpenCode HTTP Boundary (routes/opencode.ts, proxyRoutes.ts, config/policy modules)	Validate requests, enforce allowlist/authz/scope/redaction/write policy, proxy approved traffic	Browser UI, adapters, Client Gateway	Browser never receives credentials or unrestricted upstream access.
UI Projection Layer (web/src/features/opencode/*, web/src/tools/opencode/*)	Project official events/history/permissions/forms into assistant-ui/TBAI state and components	Browser Client Gateway, TBAI UI shell	No execution authority; render/adapt only.
TBAI App Core (src/db, src/services/storage, src/services/workspace, scheduler/settings/providers)	Own app data, workflows, settings, and non-OpenCode domain behavior	Routes, adapters, UI	OpenCode DB remains separate and authoritative for OpenCode runtime data.

Mode support (decoupled)

• Connect to existing compatible server: resolve/validate/adopt target (or explicit config path where supported), probe capabilities, install read-only runtime target, enforce history/service boundaries; never stop/replace foreign process.
• TBAi-managed server (optional): start/own child process, verify DB ownership/readiness/capabilities, publish managed target, stop only TBAi-owned child on TBAI shutdown.
• Coupling rule: session/history operations depend on a resolved authorized target + conversation ownership, not on who started the server except for lifecycle control permissions.

F. Prioritized improvement plan

Essential corrections (safety/correctness/invariant-preserving)

1. Codify and test the target architecture invariants explicitly (no behavior change):
   • Scope: connectionState.ts, runtimeTarget.ts, serviceAccess.ts, historyBoundary.ts, proxyAuthorization.ts, routes/opencode.ts, serverManager.ts.
   • Action: document/assert invariants (no non-owned lifecycle control, no credential/origin separation, no cross-service history access, proxy allowlist/scope enforcement, RT-001 preservation).
   • Dependencies/risks: low code risk if doc/test-only; risk is hidden invariant gaps.
2. Close known audit follow-ups before simplification:
   • Scope: ownership dead-branch/unreachable logic review (ownership.ts), boundary-safe redaction sharing where needed (lib/redact.ts vs OpenCode config/UI projections), post-readiness missing-DB invariant evidence, runtime-context parity proof if lifecycle code changes.
   • Dependencies/risks: requires evidence; avoid speculative fixes.
3. Version/support policy clarity for SDK 2.2.6 alignment (existing work):
   • Scope: docs/policy surfaces (not runtime behavior in this task).
   • Action: define supported OpenCode binary/SDK matrix and capability-based fallback expectations.
   • Dependencies/risks: depends on verified upstream/runtime evidence (E1/B5-type gaps).

High-value simplifications (reduce duplication/complexity, preserve behavior)

1. Split serverManager.ts by responsibility (mechanical/internal refactor, behavior-preserving):
   • Candidates: binary/path resolution, spawn/listening, readiness probing, DB lease/ownership verification, capability assessment, shutdown/child tracking.
   • Dependencies: characterization tests around startup/adoption fallback/shutdown/ownership refusals.
   • Risk: lifecycle regressions; do only with strong verification.
2. Unify service identity model:
   • Scope: historyBoundary.ts, serviceProfile.ts, runtimeTarget.ts, serviceAccess.ts, connectionState.ts.
   • Action: single canonical internal representation + adapters for persisted keys/UI labels.
   • Dependencies: migration-safe compatibility with persisted opencodeServiceOwner values.
   • Risk: cross-service access regressions if canonicalization changes.
3. Thin and centralize OpenCode capability/command/model discovery:
   • Scope: capabilities.ts, commands.ts, sessionModel.ts, routes/UI consumers.
   • Action: prefer official agent/model/command APIs and one capability snapshot contract; remove redundant polling/translation where safe.
   • Dependencies: UI expectations for loading/empty states.
4. Frontend V2 decomposition:
   • Scope: v2ThreadController.ts, v2Events.ts, v2History.ts, v2Permissions.ts, v2Forms.ts.
   • Action: separate pure reducers/normalizers, transport/admission/reconnect, and UI-facing controller; expand characterization tests before moves.
   • Dependencies: assistant-ui runtime contract stability.
   • Risk: subtle event ordering/recovery regressions.
5. Config surface simplification (policy-aware):
   • Scope: routes/opencode.ts, configDocument.ts, configWritePolicy.ts, OpenCodeConfigPage.tsx.
   • Action: if writes remain disabled, reduce write-path complexity/UI affordances to match actual capability; if writes are needed later, prefer official config APIs behind explicit policy and ownership checks.
   • Dependencies: product decision on config editing.

Optional improvements

1. Capability-driven UX refinement: consistently hide/disable unsupported optional features based on probed capabilities (already partially modeled).
2. Observability improvements: structured diagnostics for target resolution/adoption refusals/proxy refusals (without secrets/paths leakage beyond policy).
3. Targeted real-server compatibility suite: managed and adopted modes, reconnect/event continuity, permissions/forms, import flows, scheduler turn outcomes (authorized separately).

Things that should deliberately remain unchanged

• No Service.ensure()/Service.stop() on non-owned/adopted servers.
• No weakening of DB ownership checks, fail-closed behavior, or RT-001 caller-minted IDs/durable recovery.
• No OpenCode DB schema changes, merges, copies, imports, migrations, or deletions.
• No plaintext credentials in logs/URLs/config/registries; no browser exposure of secrets.
• No dependency on OpenChamber/Paseo/CodeG/VS Code at runtime.
• No second MCP client/protocol, no second chat runtime/streaming protocol, no framework multiplication.
• TBAI SQLite remains authoritative for app state; OpenCode remains authoritative for runtime/session/history/events.

G. Verification strategy (to execute only when separately authorized)

1) Independent client correctness (TBAi alone)

• Managed mode: start with no external OpenCode dependency; verify server readiness, session create/resume, prompt/stream, permissions/forms, interrupt/cancel, history reload, and clean TBAI-owned shutdown.
• Adopted/existing server mode: connect to a compatible already-running OpenCode server; verify TBAI does not spawn/stop/replace it; verify session/history/event operations work within authorized scope.
• Ownership refusals: simulate foreign DB holder, non-loopback/invalid registration, missing credential, incompatible/missing essential capabilities, cross-service history owner mismatch; expect fail-closed typed refusals.

2) Cross-client session visibility (without coupling)

• Same authorized OpenCode service: create/continue sessions from TBAI and observe visibility/consistency from another OpenCode client (and vice versa) only when both target the same verified service/DB context.
• Boundary cases: ensure TBAI refuses operations when conversation history owner does not match active service; ensure imported/external session handling respects eligibility and ownership rules.
• Non-goal: do not assume shared DB path implies safe concurrent multi-server writes; verify upstream support before any multi-server recommendation.

3) Event synchronization and recovery

• SSE/event stream: validate server.connected/event delivery, reconnect/backoff behavior, idle/liveness handling, and no missed terminal UI state after reconnect/history merge.
• Prompt admission/reconciliation: verify ambiguous transport failures do not cause duplicate side effects (especially scheduler and prompt submission paths); confirm inbox/message reconciliation outcomes.
• History consistency: compare projected UI/history with message.list/session state after refresh, reconnect, compaction, revert, and interruption.

4) Permissions, forms, and tool UX contracts

• Permissions: allow/deny/ask flows map to official permission APIs and TBAI policy; no auto-approval leakage across scopes.
• Forms/questions: question/form replies use form APIs and return structured answers; never routed through approval/permission endpoints.
• Capability degradation: optional missing routes/features degrade gracefully; essential missing capabilities refuse adoption/start with actionable diagnostics.

5) Disconnection and lifecycle ownership

• Managed child failures: startup timeout, early exit, readiness failure, DB ownership conflict during/after startup, shutdown cancellation — verify typed errors and no orphaned ownership claims.
• Adopted server disconnects: verify TBAI reports unavailable/degraded state without attempting lifecycle control; reconnect only when safe.
• Process/database invariants: confirm no second opencode serve against same DB, no termination of foreign processes, and no DB schema/data mutations.

6) Suggested verification layers (authorized later)

• Static/contract: typecheck, route/schema validation tests, proxy allowlist/authorization tests, capability/version classification tests.
• Unit/integration: tests/unit/opencode/*, tests/integration/opencode/*, scheduler OpenCode tests, targeted session/recovery/ownership cases.
• Runtime/manual evidence: controlled runs against OpenCode 2.2.6 managed and compatible external servers; capture logs/diagnostics with redaction; record pass/fail matrix by capability and mode.
• Do not run full test suite/build now: not authorized in this audit task.

Audit conclusion

TBAi already has the core of a viable independent OpenCode client: official SDK usage in key paths, strong safety/ownership instincts, and a clear separation goal between OpenCode runtime authority and TBAI app ownership. The main architectural risk is complexity concentration (especially lifecycle/session/recovery/projection layers) rather than missing foundational direction. The best next step is not a rewrite and not copying reference apps, but a behavior-preserving simplification program: keep TBAI’s safety and durability invariants, push more mechanics behind thin official-SDK adapters where proven safe, and reduce duplicated orchestration/state translation around a single canonical target/ownership model. Implementation should proceed only after explicit approval of a scoped plan.