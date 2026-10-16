# TBAi — Test Prompts (Implementation Phase Tracker)

This file tracks test prompts for each implementation phase.
Tests are NOT implemented yet — these are prompts/descriptions for future test creation.

---

## Phase 0 — Characterization tests (establish existing behavior)

### Test 1: runtime-ownership-baseline
**File:** `tests/dom/core/runtime-ownership-baseline.test.tsx`
**Prompt:** Mount router at `/chat/new`, `/scheduler`, `/code/test-id`, `/theme-lab`. Assert current runtime presence/absence (documents current state including defects). Use source guards since DOM tests cannot mount routers.

### Test 2: route-observer-baseline
**File:** `tests/dom/core/route-observer-baseline.test.tsx`
**Prompt:** Navigate `/chat/new` → `/scheduler` → `/code/test-id`. Assert `route.change` events (documents `from: undefined` on branch switch). Use source guards.

### Test 3: availability-baseline
**File:** `tests/dom/core/availability-baseline.test.tsx`
**Prompt:** Mount at `/`, navigate to `/code/test-id`. Assert availability store stop/start (documents current gap). Use source guards.

---

## Phase 1 — Persistent AppShell ancestor

### Test 4: persistent-shell
**File:** `tests/dom/core/persistent-shell.test.tsx`
**Prompt:** Navigate through 6 routes (including /chat ↔ /code). Assert AppShell never unmounts. Use E2E (Playwright) for behavioral verification; source guard for structural assertion.

### Test 5: route-observer-continuity
**File:** `tests/dom/core/route-observer-continuity.test.tsx`
**Prompt:** Navigate through 5 routes. Assert every `route.change` has correct `from`. Use E2E for behavioral; source guard for structural.

### Test 6: tab-reconciliation-navigation
**File:** `tests/dom/core/tab-reconciliation-navigation.test.tsx`
**Prompt:** Navigate through 5 routes. Assert `reconcileTabMirror` NOT called during ordinary route navigation. Boot call and recovery-triggered calls are legitimate. Use source guard + unit test with spy.

### Test 7: availability-persistent
**File:** `tests/dom/core/availability-persistent.test.tsx`
**Prompt:** Navigate /chat ↔ /code. Assert availability store never stops. Use E2E for behavioral; source guard for structural.

### Test 8: runtime-lifetime
**File:** `tests/dom/core/runtime-lifetime.test.tsx`
**Prompt:** Mount at `/chat/new`, navigate to `/scheduler` (runtime still present), navigate to `/code/test-id` (Direct absent, OpenCode present), navigate back to `/chat/new` (Direct present, OpenCode absent). Use source guards.

### Test 9: opencode-isolation
**File:** `tests/dom/core/opencode-isolation.test.tsx`
**Prompt:** Mount at `/code/test-id`. Assert OpenCode runtime present. Assert Direct runtime absent. Assert no provider errors. Use source guards.

### Test updates (Phase 1):
- `tests/dom/opencode/CodeShell.test.tsx` — update: CodeShell no longer imports/renders AppShell.
- `tests/dom/core/HydrateFallback.test.tsx` — update: router source assertions reflect AppShell as parent of "/".

---

## Phase 2 — Shared-UI boundary decoupling (H1)

### Test 10: composer-runtime-free
**File:** `tests/dom/components/composer-runtime-free.test.tsx`
**Prompt:** Render Composer in Direct mode (no opencode chips) and agent mode (opencode chips render). Source guard: no `@opencode/client` import.

### Test 11: bundle check (manual)
**Prompt:** `cd web && bun run build`. Verify `@opencode/client` only in CodeShell chunk.

---

## Phase 3 — Navigation literal cleanup (H2)

### Test 12: no-hardcoded-routes
**File:** `tests/unit/web/navigation/no-hardcoded-routes.test.ts`
**Prompt:** Source guard: no `navigate("/...")` literals outside allowlist.

---

## Phase 4 — Router behavioral test coverage (M6)

### Tests 13-18: router-smoke
**File:** `tests/dom/core/router-smoke.test.tsx`
**Prompt:** Mount router. Assert `/` redirects to active tab or `/chat/new`. Assert `/chat/:id` renders ChatView. Assert `/code/:id` renders CodeShell. Assert settings routes render SettingsLayout. Assert `*` redirects to `/`. Assert invalid route behaves predictably.

---

## Phase 5 — Deferred cleanup (M3, M4, M5)

### Test 19: migration test
**File:** `tests/unit/web/chat/chatTabs-migration.test.ts`
**Prompt:** Migration test for persisted tab shapes (keep `healTab` for old shapes). Verify page tabs are filtered on load.