# OpenChamber reference research

Studied from the actual OpenChamber project at `D:\Temp\openchamber`, including `docs/references/desktop_dark.png` and `desktop_light.png` and the UI source under `packages/ui/src/`.

## Patterns worth adopting

1. **Three-region desktop shell.** A narrow icon rail, a session/project sidebar, a main workspace, and an optional right contextual panel. This gives a stable frame while allowing each workspace its own content layout. TBAi already has a rail and sidebar; the missing piece is a purposeful right inspector for session/context information.

2. **Session inspector panel.** OpenChamber's right panel shows Context usage, Project, Context sources, Usage, MCP status, and Turn stats. TBAi has all of this data (context usage, engine, model, memory, skills, MCP, credits) but does not surface it coherently. A right inspector would make the app feel like a real development workspace.

3. **Dense but calm information layout.** OpenChamber packs a lot of information into the sidebar without feeling crowded, using small type, clear grouping, and restrained color. TBAi's sidebar is dense but noisy; adopting clearer grouping and stronger active states would help.

4. **Warm neutral palette with one restrained accent.** OpenChamber uses warm sand/charcoal surfaces with a golden accent. TBAi's themes already include warm palettes; the redesign should use one restrained accent consistently rather than random per-card colors.

5. **Code and tool presentation.** OpenChamber presents code blocks and tool results as distinct, well-bounded surfaces with clear headers. TBAi's code blocks and tool cards are similar but lack the same clarity of hierarchy.

6. **Composer as a grounded surface.** OpenChamber's composer is a substantial, clearly bounded input area at the bottom of the chat with model/mode controls inline. TBAi's composer is similar but flatter; giving it more presence would improve the chat workspace.

7. **Deliberate light and dark themes.** OpenChamber's light theme is a designed light surface hierarchy, not a simple inversion. TBAi should treat light mode as a first-class design target.

## Patterns NOT to copy

1. **Do not force a three-column layout on every page.** OpenChamber's shell is consistent, but each workspace uses the space differently. TBAi's Settings and Scheduler should not be forced into a chat-style inspector layout.

2. **Do not copy OpenChamber's feature set or terminology.** It has Sessions, Multi-run, Fusion, Worktrees, etc. TBAi has Conversations, Code mode, Scheduler, MCP, Providers, Folders. Use TBAi's real product structure and terminology.

3. **Do not remove focus rings.** OpenChamber removes some focus rings in favor of hover fills; TBAi must keep visible keyboard focus for accessibility.

4. **Do not add panels without a usability benefit.** The right inspector is justified because TBAi already has the data and it improves orientation. Adding decorative panels would not.

5. **Do not adopt OpenChamber's exact color values.** TBAi has its own theme system with 25 palettes. The redesign should work with those themes, not hardcode OpenChamber's colors.

## Summary
Adopt the shell structure, inspector concept, information density, restrained accent, and deliberate theming. Adapt them to TBAi's own features, keep accessibility, and do not copy feature-specific UI that TBAi does not have.
