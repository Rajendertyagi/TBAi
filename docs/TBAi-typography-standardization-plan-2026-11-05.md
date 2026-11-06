# TBAi — Application-Wide Typography Standardization Plan

> [!NOTE]
> **SUPERSEDED DRAFT:** This in-tree working document has been superseded by the
> authoritative Revision 5 plan (`TBAi-typography-standardization-plan-2026-11-05.md`
> Revision 5, approved 2026-11-06). Implementation and verification records are
> codified in `docs/decisions.md` and repository tests. Do not edit this draft as
> an active specification.

**Status:** Superseded by Revision 5
**Source baseline audited:** `ci/tauri-e2e-verify` at `dd82ed8beb0080dfd5588c499afd2ac1009d9627`  
**Execution dependency:** The original agent must first finish the already-open P1/P2/P3 typography repairs. Those changes must then be independently reviewed and accepted.  
**Purpose:** Make typography consistent and predictable throughout TBAi, using one understandable design standard rather than fixing isolated font problems one component at a time.

---

## 1. Executive summary

TBAi already has a reasonable foundation: separate settings for Interface, Code, Terminal, Reading Line Height and Application Scale. The goal is **not** to replace that system or make every text element look the same.

The goal is to make the application behave like a professionally maintained product with a consistent typography system:

- The same kind of content should look consistent wherever it appears.
- Text-size settings should behave predictably across the application.
- Headings, body text, controls and compact information should have a clear visual hierarchy.
- Code and terminal content should remain distinct from ordinary interface text.
- Small labels should remain visually compact without becoming disproportionately tiny when the user increases the interface size.
- A font setting should change the content it claims to control, and should not unexpectedly change unrelated content.

**Recommended direction:** keep the existing five settings and existing storage format. Establish a small set of semantic text roles, map every visible text surface to the correct role, and make the existing settings control those roles consistently.

This is a standardization project, not a visual redesign. It should reuse the existing CSS variables, Tailwind type scale, components and tests wherever possible. No new typography framework or settings system is proposed.

## 2. What the audit established

The source was checked against the committed GitHub baseline `dd82ed8`. The branch still pointed to that commit when checked. The supplied audit report also described seven modified files in its agent's local working tree; those local changes were not available as committed GitHub source, so their exact contents and ownership could not be established here. They must not be discarded or treated as part of the committed baseline without reviewing their diffs.

### 2.1 Existing settings and their current responsibilities

| Existing setting | What it should control | Direction |
|---|---|---|
| Interface Font | General application text | Keep as the font for normal UI content |
| Interface Font Size | General application text scale | Make all ordinary UI text—including compact labels—respond proportionally while preserving hierarchy |
| Interface Font Weight | Base weight for normal interface text | Keep semantic emphasis for headings, buttons and important labels |
| Code Font | Actual code content | Keep for source code, Markdown code, diffs and code previews |
| Terminal Font | Captured command and terminal output | Keep for actual terminal content, not every status label near it |
| Reading Line Height | Reading-oriented prose | Keep for Markdown prose and assistant reasoning |
| Application Scale | Whole application display scale | Keep independent from the font-size setting |

### 2.2 Confirmed technical observations

1. **Interface size has gaps.** Some first-party components use literal pixel font sizes rather than the existing scale-responsive text tokens. They therefore do not grow proportionally when Interface Font Size changes. The supplied report's approximate count of 28 is not considered final; a reproducible inventory must be generated from the post-repair source before implementation.
2. **The Code setting works on the principal code surfaces.** The scoped CSS rules take precedence over the generic monospace rule for the main Markdown, Shiki and diff surfaces. The earlier claim that the entire Code setting is decorative was incorrect.
3. **The committed OpenCode JSON preview has a nested-element issue.** In baseline `dd82ed8`, the preview's `<pre>` is marked as a code preview, but the inner `<code>` has its own generic monospace declaration. The committed E2E spec does not prove the nested element uses the selected Code family. This is already part of the existing P2 repair and must be closed there, not duplicated here.
4. **Terminal output rows inherit Terminal typography.** The `TerminalBlock` root receives the selected family, size and weight; its plain output rows inherit those values. Small exit/failure chips and timeout summaries are separate UI elements and need their own semantic role.
5. **The generic monospace channel is intentional.** `--font-mono` is used for technical metadata such as paths, IDs, hashes and compact counters. It should not automatically become the Code or Terminal font.
6. **Explicit bold/medium weights are not automatically bugs.** A page title, button label and body paragraph should not necessarily share one weight. The standard must preserve meaningful emphasis while making base-weight behavior predictable.
7. **Reading line-height is intentionally prose-focused.** It should not silently change code, terminal output, controls or compact metadata.
8. **Font loading needs stronger verification.** A computed CSS `font-family` string does not prove that the requested font file actually loaded. Runtime checks should verify bundled fonts themselves.
9. **Font option count and bundling were independently recounted.** At baseline `dd82ed8`, `UI_FONTS` contains 10 options and `MONO_FONTS` contains 5, for 15 total. Eight interface options and three monospace options have bundled font packages (11 bundled total); two interface options and two monospace options rely on platform/system fonts. A later audit claim of 16 total / 11 interface options does not match the committed source and must not be copied into the plan.
10. **The ThemeLab specimen should be checked against the real production DOM.** A preview should demonstrate the same structure and styling path that the actual chat renderer uses.

### 2.3 Current supported ranges (baseline facts, not yet a new design decision)

The committed `typography.ts` currently defines:

| Control | Current supported range | Current default |
|---|---:|---:|
| Interface font size | 12–24px | 16px |
| Code font size | 11–20px | 13px |
| Terminal font size | 10–20px | 12px |
| Reading line height | 1.2–2.0 | 1.5 |
| Application scale | 0.75–1.5 (75–150%) | 1.0 (100%) |

These describe the current controls. They are not a declaration that every value is equally readable or that the range must never change. The refreshed audit must assess usability at the boundaries before the final standard is approved. Font-weight choices are clamped to each selected family's supported range.

### 2.4 What is not yet treated as proven

- The exact total of fixed-size declarations across the whole application.
- Every component's effective computed typography at runtime.
- Whether all bundled font faces load correctly in the packaged Windows WebView2 application.
- The visual quality and minimum readability of every surface at the smallest and largest supported sizes and application scales.
- The provenance and ownership of the seven uncommitted files mentioned in the supplied audit report.

These become explicit audit/verification tasks after the existing repair work is accepted. Do not turn uncertain counts or CSS-only inferences into confirmed defects.

## 3. The standard TBAi should follow

A professional application uses a visual hierarchy. It does not use one font size for everything. TBAi should have a small number of recognizable roles, with consistent treatment throughout the product.

| Role | Where users see it | Intended appearance |
|---|---|---|
| **Page title** | Main page and major dialog titles | Clearly identifies the current page; consistent across settings and feature pages |
| **Section heading** | Groups within a page or panel | Smaller than the page title, visually distinct from body text |
| **Body text** | Chat prose, normal content and descriptions | Comfortable default reading size and normal interface family |
| **Control text** | Buttons, inputs, dropdowns, tabs and selectable values | Readable and consistent across all controls |
| **Secondary text** | Help text, subtitles, descriptions and supporting information | Smaller/muted than body text, but still readable |
| **Compact metadata** | Timestamps, badges, token counts, tiny status labels | Visually compact; scales proportionally with Interface Font Size |
| **Technical metadata** | IDs, hashes, paths, short machine identifiers | Monospace and compact; does not accidentally inherit Code or Terminal settings |
| **Code content** | Markdown code, syntax-highlighted code, diffs, JSON and file previews | Controlled by Code Font settings |
| **Terminal content** | Captured commands and command output | Controlled by Terminal Font settings |
| **Reading prose** | Markdown paragraphs, lists and assistant reasoning | Controlled by Reading Line Height |

A single component can contain more than one role. For example, a terminal card has command output, a command header and a success/failure badge. Those parts should not all be forced into one typography style.

### 3.1 Role-to-setting ownership

This is the intended ownership map for the standard. It describes product behavior, not a requirement to introduce new CSS variables or a new framework.

| Role | Family owner | Size owner | Weight owner | Line-height owner |
|---|---|---|---|---|
| Page title / section heading | Interface Font | Interface Font Size | Interface base plus semantic emphasis | Component role; not Reading Line Height |
| Body text / control text | Interface Font | Interface Font Size | Interface base plus semantic emphasis | Existing component rhythm |
| Secondary text | Interface Font | Interface Font Size | Interface base or deliberate emphasis | Existing component rhythm |
| Compact metadata | Existing interface or technical-metadata family, according to content | Interface Font Size through a compact, readability-clamped role | Deliberate compact/semantic weight | Compact role; not Reading Line Height |
| Technical metadata | Fixed generic monospace channel | Compact role tied to Interface Font Size only where appropriate | Deliberate metadata weight | Compact role |
| Code content | Code Font | Code Font Size | Code Font Weight | Code-specific; not Reading Line Height |
| Terminal content | Terminal Font | Terminal Font Size | Terminal Font Weight | Terminal-specific; not Reading Line Height |
| Reading prose | Interface Font | Interface Font Size | Interface base plus semantic emphasis | Reading Line Height |

The refreshed audit must map actual components and nested elements to these roles. Where an element is genuinely an identifier or machine value rather than code content, it should remain technical metadata. Do not infer ownership from `font-mono` alone.

## 4. Recommended behavior for the existing settings

These are the proposed product defaults. They are engineering decisions for the standardization work; the user should not need to choose CSS classes, selectors or individual component mappings.

### 4.1 Interface Font Size

**Recommended behavior:** all normal interface text responds to this setting, including small labels and compact metadata.

The visual hierarchy remains intact by using different proportional sizes. Compact metadata should scale with the interface, but it must not become illegibly small at the minimum interface size or disproportionately large at the maximum. Use a compact scale role with a readability floor and a sensible upper bound rather than blindly multiplying every small size by the full interface-size ratio.

The exact floor, upper bound and scaling curve must be selected during Phase 2 after checking the current 12–24px interface range. Do not declare today's `text-2xs` / `text-3xs` multipliers to be the final answer without boundary testing.

A fixed size is allowed only when it is a genuine visual/geometry exception, is documented, and does not make the UI hard to read at supported settings.

### 4.2 Interface Font Weight

**Recommended behavior:** treat this as the base weight for normal interface/body text. Keep intentional emphasis for headings, buttons, selected items, important labels and statuses.

Do not mechanically replace every medium or semibold style. Instead, make the weight hierarchy consistent across similar components and ensure the setting has a clear, truthful effect on the text it owns.

### 4.3 Code Font

**Recommended behavior:** control actual code content, not every item that happens to use a monospace font.

This includes Markdown code, syntax-highlighted source, diff content and JSON/file previews. Short paths, hashes, counters and labels around code remain technical metadata unless they are actual code content.

### 4.4 Terminal Font

**Recommended behavior:** control command text and captured terminal output. Exit/failure badges and timeout summaries remain compact status text, visually consistent with other status labels in TBAi.

### 4.5 Reading Line Height

**Recommended behavior:** control reading prose—Markdown paragraphs, lists and assistant reasoning. Do not apply it to controls, headings, code, diffs, terminal output or logs by default.

### 4.6 Application Scale

**Recommended behavior:** keep this separate from font size. It scales the application as a whole. Changing Interface Font Size should not unexpectedly resize spacing, icons, panel geometry or corner radii.

### 4.7 Existing ranges are review inputs, not arbitrary targets

The current ranges are Interface 12–24px, Code 11–20px, Terminal 10–20px, Reading Line Height 1.2–2.0, and Application Scale 75–150%. Phase 2 must assess whether the minimum values remain readable for their roles. Phase 4 must verify representative minimum, default and maximum combinations. Do not widen ranges or add new settings merely to solve a component-level inconsistency.

## 5. What should change—and what should stay stable

| Area | Planned treatment |
|---|---|
| Fixed-size ordinary UI labels | Move to the appropriate proportional role while preserving their relative compactness |
| Repeated page/section headings | Make matching roles look consistent throughout the application |
| Shared metadata styling | Reuse a small number of clear role definitions instead of unrelated one-off styles |
| Generic monospace metadata | Keep distinct from Code and Terminal content |
| Code and Terminal content | Preserve independent settings and verify every supported renderer |
| Explicit emphasis weights | Keep meaningful hierarchy; correct only inconsistent or unintended cases |
| Folder tile and other true geometry exceptions | Preserve when justified and document them |
| Reading line-height | Keep prose-only unless evidence shows a user-visible requirement to expand it |
| ThemeLab specimens | Make them reflect the production rendering structure |
| Font options | Keep existing options unless testing shows a real availability or usability problem; label platform-dependent choices accurately |

## 6. Delivery plan — in the correct order

### Gate 0 — Finish the existing repair work first

This workstream is already assigned to the original agent and takes priority. The agent is expected to finish:

1. **P1 — WebView2 zoom verification:** make the packaged test detect each zoom shortcut independently and verify actual browser zoom behavior.
2. **P2 — OpenCode JSON preview:** fix the nested code-font inheritance and add a computed-style assertion against the actual inner `<code>` element.
3. **P3 — Plan documentation:** correct the stale status of the previous typography implementation plan.

After the agent finishes, preserve and inspect the exact working-tree diff before anything is reset, discarded or overwritten. The seven modified files reported by the audit agent must each be accounted for: identify their owner, purpose, and whether they belong to P1/P2/P3 or unrelated work. Do not assume they are all part of the repair and do not lose them through cleanup. The intended repair changes must be isolated, tested, reviewed and committed; unrelated changes must remain separately owned and out of the repair commit.

Independently review the exact diffs, targeted tests, full verification report and CI evidence. Record the accepted repair commit as the new baseline and confirm the working tree / remote state. Gate 0 closes only when the relevant repair work is committed and accepted, and all pre-existing uncommitted changes have a documented disposition. Do not begin this standardization implementation before Gate 0 is closed.

### Phase 1 — Refresh the audit against the accepted baseline

- Record branch, commit, working-tree state and remote equality.
- Regenerate the complete application-wide inventory from the accepted source.
- Inspect every first-party UI area: application chrome, chat, assistant tools, code and terminal surfaces, settings, dialogs, menus, overlays and secondary panels.
- Record each meaningful font family, size, weight, line-height, letter-spacing and wrapping declaration with its component and actual semantic role.
- Generate the inventory reproducibly from first-party source: scan `web/src/**/*.{tsx,ts,css}` plus `web/index.html` and typography-related configuration for Tailwind arbitrary font-size utilities (including `text-[...]`), explicit CSS `font-size` / `font-family` / `font-weight` / `line-height` / `letter-spacing`, inline typography styles, tracking utilities, and font-family helper strings. Exclude generated output, dependency code and vendored code unless TBAi overrides or wraps its typography. Record the exact command/tool, included paths, exclusions, and the distinction between raw matches, unique declarations and confirmed rendered elements.
- Reconcile the fixed-size count; include a complete file/line list and a repeatable detection method so another reviewer can reproduce it. A raw text search count must not be presented as a defect count.
- Separate confirmed runtime behavior from CSS-based inference.
- Identify legitimate fixed exceptions instead of automatically treating every fixed value as a defect.

**Deliverable:** a traceable source inventory and confirmed issue list. No code changes in this phase.

### Phase 2 — Establish the standard role mapping

- Use the roles in Section 3 as the default standard.
- Map every audited text surface to one role.
- Map those roles to the existing five settings and existing CSS variables; include the final role → setting/token ownership table.
- Select the compact-metadata scaling curve, including its minimum readable floor and upper bound, based on the supported interface range and visual checks.
- Confirm whether the current ranges should remain unchanged based on minimum/maximum readability findings.
- Document the small number of legitimate exceptions.
- Resolve ambiguous ownership internally using the policies in Section 4.
- Present the proposed user-visible defaults for a single high-level review. Do not ask the user to approve individual CSS selectors, weights, tokens or component classes. Only request input where a choice materially changes the visible product behavior.

**Exit criteria:** every audited text surface has a role; each role has an owner and scaling behavior; exceptions are documented; product-visible defaults are stated plainly; no implementation-level ambiguity remains.

**Deliverable:** a short typography standard that the implementation can follow. The user does not need to approve individual CSS selectors, weights or component classes.

### Phase 3 — Implement the standard with minimal changes

- Reuse the current typography storage, settings and CSS variables. No new framework, persistence schema or parallel token system.
- Establish a small, consistent set of shared role styles using the existing styling architecture.
- Update shared UI primitives first so improvements flow through the application naturally.
- Migrate feature-specific components where they do not use the shared roles correctly.
- Separate compact metadata from actual Code/Terminal content.
- Keep existing visual hierarchy and layout behavior.
- Avoid broad rewrites, new dependencies, new settings or unrelated cleanup.
- Split the work into reviewable commits by coherent surface/role groups; keep each diff scoped and reversible.

**Exit criteria:** all inventory items are mapped or documented as exceptions; no new settings/storage format/framework are introduced; targeted checks pass for each migrated group; the final diff is reviewable and contains no unrelated cleanup.

**Deliverable:** consistent typography behavior across the application, with a focused diff and documented exceptions.

### Phase 4 — Verify the rendered application

Test the actual visible results, not only whether CSS variables exist.

- Verify Interface font family, size and base weight on representative body text, headings, controls, secondary text and compact metadata.
- Verify Code family, size and weight in inline code, fenced Markdown, Shiki, diffs and JSON/file previews.
- Verify Terminal family, size and weight on the terminal container and actual output rows; verify status labels separately.
- Verify Reading Line Height on paragraphs, lists and reasoning, while confirming controls and code remain independent.
- Verify Application Scale at supported minimum, default and maximum settings.
- Verify that changing one preference does not unintentionally alter another role.
- Confirm that bundled font faces actually load at the selected family/weight (for example, using the browser Font Loading API such as `document.fonts.load()` / `document.fonts.check()` against representative text), and supplement this with visual inspection. A computed `font-family` string alone is insufficient.
- Inspect narrow dialogs, long paths, large code blocks, dense tool output, collapsed/expanded navigation and both light/dark themes.
- Use Chromium/Edge browser tests and packaged WebView2 CI for desktop-specific confidence.
- Use a bounded visual review matrix rather than testing every possible permutation: light and dark themes; minimum/default/maximum Interface Font Size; minimum/default/maximum Application Scale; default and at least one alternate bundled UI/code/terminal family; representative chat, settings, metadata, code and terminal surfaces. Prioritize boundary combinations and pairwise coverage where the full Cartesian product is excessive.
- Include readability checks at supported minimum sizes: text must remain legible, not clip or overlap, and key controls/labels must remain usable. Record screenshots or equivalent visual evidence for the representative matrix.
- Keep test layers distinct: unit tests for configuration/normalization; DOM tests for token application and role assignment; browser E2E computed-style tests for actual nested rendered elements and setting independence; visual review for hierarchy, clipping and readability; packaged WebView2 CI for desktop behavior.

**Exit criteria:** all automated checks pass; actual nested elements are tested; font loading is verified; boundary-size/scale and theme reviews have evidence; no critical readability, clipping, overflow or hierarchy regression remains.

**Deliverable:** browser and desktop evidence showing that the settings behave as described and that the interface remains usable at supported sizes.

### Phase 5 — Close and document

- Document the typography roles and the reason for each fixed exception.
- Ensure the Appearance page descriptions accurately explain the settings.
- Ensure ThemeLab previews match production rendering.
- Record the test coverage and any platform-dependent font limitations.
- Review the final diff for scope, regressions and unnecessary custom code.

**Deliverable:** a maintainable typography standard, validated in the real application.

## 7. Acceptance criteria

The work is complete when:

1. Every visible first-party text surface is assigned to a documented typography role.
2. Similar content looks consistent across different parts of TBAi.
3. Interface Font Size affects normal UI text and compact metadata proportionally while maintaining hierarchy.
4. Interface Font Weight has a clear and predictable effect on normal text without destroying intentional emphasis.
5. Code settings affect actual code content across all code renderers.
6. Terminal settings affect command and captured output consistently.
7. Technical metadata remains compact and distinct from Code and Terminal content.
8. Reading Line Height affects reading prose only.
9. Application Scale remains independent and scales the whole application.
10. Fixed typography exceptions are few, justified and documented.
11. Bundled font loading is verified at runtime, not inferred from CSS declarations.
12. Tests verify computed styles on actual nested rendered elements.
13. Supported size and scale extremes remain readable and do not break layouts.
14. Existing theme, wrapping, copy, layout and interaction behavior remains intact.
15. The change set contains no unrelated refactors, new typography frameworks or duplicate settings systems.

## 8. Explicit non-goals

- Do not redesign the application's visual identity.
- Do not make all text the same size or weight.
- Do not add more font settings or a new persistence schema.
- Do not replace the existing application-scale mechanism without evidence that it is defective.
- Do not make every monospace label use the Code font.
- Do not apply Reading Line Height to every UI element.
- Do not globally remove semantic bold/medium/semibold hierarchy.
- Do not change spacing, icons, radii or component geometry as part of typography cleanup.
- Do not implement this plan before Gate 0 is complete and independently accepted.

## 9. Rollback and change control

- Capture the accepted post-Gate-0 commit as the implementation baseline.
- Keep standardization changes in focused, reviewable commits grouped by coherent typography roles or UI surfaces.
- Do not combine this work with unrelated feature changes or the earlier P1/P2/P3 repair commits.
- If a change causes a material rendering, accessibility, layout or interaction regression, stop rollout and revert the smallest affected standardization commit(s), rather than resetting the branch or undoing unrelated work.
- Preserve the inventory, screenshots and test evidence so a rollback can be compared against the known baseline.

## 10. Ownership and decision policy

The engineering work should follow this plan without asking the user to make low-level implementation choices.

| Phase | Responsible role | Independent check / approval |
|---|---|---|
| Gate 0 repairs | Original agent already assigned to P1/P2/P3 | Independent source/diff/test review before acceptance |
| Phase 1 audit refresh | Designated audit agent | Independent review of inventory, findings and baseline evidence |
| Phase 2 standard definition | Technical owner prepares the role map and recommendation | User reviews only the resulting visible behavior/defaults where a genuine product preference exists |
| Phase 3 implementation | One designated coding agent, assigned after Phase 2 | Independent code review; no parallel agents editing the same typography worktree |
| Phase 4 verification | Implementation agent produces test and visual evidence | Independent review of evidence and packaged CI result |
| Phase 5 closeout | Implementation agent updates documentation | Independent final diff and acceptance review |

The technical owner is responsible for:

- auditing and mapping components to semantic roles;
- selecting the existing tokens/utilities that implement those roles;
- preserving useful hierarchy;
- deciding which exceptions are technically and visually justified;
- adding the required automated and visual verification;
- minimizing custom code and avoiding unrelated refactors.

The user should only be asked to decide a genuine product preference that changes the visible experience in a meaningful way. Routine choices about selectors, CSS classes, test structure, or individual component mappings remain engineering responsibility.

## 11. Final sequencing rule

**The standardization implementation remains queued.** First, the original agent must complete P1/P2/P3. Then those changes must be independently reviewed and accepted. Only after that should the post-repair audit baseline be refreshed and this plan executed.

This document authorizes planning only. It does not authorize code changes, test changes, commits or pushes.
