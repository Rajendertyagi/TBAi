# TBAi Phase 5 — Test Prompts (Deferred Cleanup)

Status ledger (updated after implementation):
- Tests 13–15, 16–22, 24–25: IMPLEMENTED and PASSING (see files below).
- Test 23 (source guard): IMPLEMENTED and PASSING
  (`tests/dom/core/IndexRedirect.test.tsx`).
- Tests 23a/23b/23c (behavioral redirect decision): IMPLEMENTED and PASSING
  (`tests/dom/core/IndexRedirect.behavioral.test.tsx` — executes the real
  store + real `activeTab`/`urlForTab`; rendering is pinned by Test 23).
- Full end-to-end redirect through a mounted router: DEFERRED — the repo has
  two copies of react-router (`web/node_modules` vs root), so a test-side
  `MemoryRouter` cannot provide context to `@web` components. Playwright E2E
  (`tests/e2e/routing/index-redirect.spec.ts`) remains the vehicle for that
  coverage and is PENDING.

Original prompts follow; implemented items are marked [DONE].

---

## 1. `navigation.ts` — dead `search` entry removed

### Test 13: search nav entry removed
**File:** `tests/unit/web/navigation/no-search-entry.test.ts`
**Prompt:** Read `web/src/config/navigation.ts` as text. Assert the source does NOT contain `id: "search"`. Assert the source does NOT contain `import { Search }` or `Search,` from lucide-react. Assert `getVisibleNav()` (or `appConfig.nav`) has no entry with `id: "search"`.

### Test 14: features object is now empty
**File:** `tests/unit/web/navigation/features-empty.test.ts`
**Prompt:** Read `web/src/config/navigation.ts`. Assert the `features` constant is `Record<string, never>` or equivalent empty object. Assert no code references `features.search`. Assert `appConfig.features` has no keys.

---

## 2. `navigation.ts` — ROUTES constant used in NavItem routes

### Test 15: NavItem routes reference ROUTES constants
**File:** `tests/unit/web/navigation/nav-routes-use-constant.test.ts`
**Prompt:** Read `web/src/config/navigation.ts`. Assert `route: ROUTES.CHAT` appears for the chat entry. Assert `route: ROUTES.FOLDERS` appears for the folders entry. Assert no NavItem route is a bare string literal `"/chat"` or `"/folders"` — they must reference the constant.

---

## 3. `chatTabs.ts` — page tab code removed

### Test 16: pageKey is removed
**File:** `tests/unit/web/chat/page-key-removed.test.ts`
**Prompt:** Read `web/src/features/chat/state/chatTabs.ts`. Assert the source does NOT contain `pageKey` or `page:`. Assert the `Tab` type's `kind` is `"chat" | "agent"` (no `"page"`). Assert `openPage` is NOT in the `ChatTabsState` interface.

### Test 17: healTab no longer handles page prefix
**File:** `tests/unit/web/chat/heal-tab-no-page.test.ts`
**Prompt:** Unit test `healTab`. Assert `healTab({ key: "page:/scheduler", kind: "page", ref: "/scheduler" })` returns `null` (page prefix is no longer recognized). Assert `healTab({ key: "chat:t1", kind: "chat", ref: "t1" })` still returns the tab unchanged. Assert `healTab({ key: "agent:a1", kind: "agent", ref: "a1" })` still returns the tab unchanged.

### Test 18: tabForKey no longer handles page prefix
**File:** `tests/unit/web/chat/tab-for-key-no-page.test.ts`
**Prompt:** Unit test `tabForKey` (if exported) or behavior via the store. Assert that a key with `page:` prefix does NOT produce a page tab. If `tabForKey` is not exported, test via `healTab` that page-prefixed keys are rejected.

### Test 19: urlForTab handles only chat and agent
**File:** `tests/unit/web/chat/url-for-tab-no-page.test.ts`
**Prompt:** Unit test `urlForTab`. Assert `urlForTab({ key: "chat:t1", kind: "chat", ref: "t1" })` returns `"/chat/t1"`. Assert `urlForTab({ key: "agent:a1", kind: "agent", ref: "a1" })` returns `"/code/a1"`. Assert the function has no fallback branch for page tabs.

---

## 4. `chatTabs.ts` — loadPersisted no longer filters page tabs

### Test 20: loadPersisted passes through all tabs
**File:** `tests/unit/web/chat/load-persisted-no-filter.test.ts`
**Prompt:** Unit test `loadPersisted` or the store initialization. Mock `localStorage.getItem` to return a persisted shape containing a page tab. Assert `loadPersisted()` does NOT filter out page tabs (the filter was removed). Note: this tests the new behavior — page tabs in storage will now be kept (though none should exist in practice). Alternatively, if this is considered undesirable, assert that `healTab` rejects page tabs before they reach `loadPersisted`.

---

## 5. `chatTabs.ts` — conversationIdFromPath uses per-prefix extraction

### Test 21: conversationIdFromPath extracts per-prefix
**File:** `tests/unit/web/chat/conversation-id-from-path.test.ts`
**Prompt:** Unit test `conversationIdFromPath`. Assert `conversationIdFromPath("/chat/t1")` returns `"t1"`. Assert `conversationIdFromPath("/code/a1")` returns `"a1"`. Assert `conversationIdFromPath("/chat/")` returns `null` (empty ID). Assert `conversationIdFromPath("/scheduler")` returns `null`. Assert `conversationIdFromPath("/chat")` returns `null` (no trailing slash).

---

## 6. `chatTabs.ts` — routeStillReferencesRef uses ROUTES constants

### Test 22: routeStillReferencesRef matches chat and code routes
**File:** `tests/unit/web/chat/route-still-references.test.ts`
**Prompt:** Unit test `routeStillReferencesRef`. Assert `routeStillReferencesRef("/chat/t1", "t1")` is `true`. Assert `routeStillReferencesRef("/code/a1", "a1")` is `true`. Assert `routeStillReferencesRef("/chat/t1", "t2")` is `false`. Assert `routeStillReferencesRef("/scheduler", "t1")` is `false`.

---

## 7. `IndexRedirect.tsx` — declarative Navigate with active-tab restoration

### Test 23: IndexRedirect renders Navigate declaratively (no imperative effect) [DONE]
**File:** `tests/dom/core/IndexRedirect.test.tsx` — 5 pass, 0 fail.
**Prompt:** Read `web/src/app/IndexRedirect.tsx` as text. Assert the source does NOT contain `useEffect` or `useNavigate`. Assert the source contains `<Navigate`. Assert the source does NOT contain `return null` (it returns the Navigate element).

### Test 23a: IndexRedirect restores active chat tab [DONE — decision level]
**File:** `tests/dom/core/IndexRedirect.behavioral.test.tsx` — Case A passes.
**Prompt:** Set the real store with an active chat tab (`chat:<id>`). Evaluate the same expression the component renders (`activeTab` + `urlForTab`, fallback `ROUTES.CHAT_NEW`). Assert the destination is `/chat/<id>`.

### Test 23b: IndexRedirect restores active agent tab [DONE — decision level]
**File:** `tests/dom/core/IndexRedirect.behavioral.test.tsx` — Case B passes.
**Prompt:** Set the real store with an active agent tab (`agent:<id>`). Assert the destination is `/code/<id>`.

### Test 23c: IndexRedirect falls back to /chat/new when no tabs exist [DONE — decision level]
**File:** `tests/dom/core/IndexRedirect.behavioral.test.tsx` — Case C passes.
**Prompt:** Empty store. Assert the destination is `/chat/new`.

### Tests 23a/23b/23c full-router E2E [DONE]
**File:** `tests/e2e/routing/index-redirect.spec.ts` (Playwright) — 3 pass, 0 fail
against the isolated E2E server (`bun run test:e2e -- index-redirect.spec.ts`).
- 23a: seeded Direct conversation + active `chat:<id>` tab → `#/chat/<id>` + composer.
- 23b: seeded `engine: "opencode"` conversation + active `agent:<id>` tab →
  `#/code/<id>` + shell chrome, no fallback to `/chat/new`.
- 23c: empty store → `#/chat/new` + welcome surface + `history.length === 2`
  (proves replacement, not push: baseline `about:blank` + one `goto`).

---

## 8. Integration — store initialization without page tabs

### Test 24: store initializes correctly without page tab support
**File:** `tests/unit/web/chat/chat-tabs-no-page.test.ts`
**Prompt:** Import `useChatTabsStore` or `loadPersisted`. Assert the store's initial state (from `loadPersisted()`) contains no page tabs. Assert `activeTab` returns a chat or agent tab, never a page tab. Assert the store's actions do NOT include `openPage`.

---

## 9. Source guard — no page tab references remain in production code

### Test 25: no page tab references in source [DONE]
**File:** `tests/unit/web/chat/no-page-tab-source.test.ts`
**Prompt:** Read `web/src/features/chat/state/chatTabs.ts`. Assert the source does NOT contain `kind: "page"`. Assert the source does NOT contain `pageKey`. Assert the source does NOT contain `openPage`. Assert the source does NOT contain `page:` (as a string prefix in key construction).

---

## 10. Routing Contract and URL Builders

### Test 26: Routes module separation and path builders [DONE]
**File:** `tests/unit/web/navigation/routes-contract.test.ts` — 10 pass, 0 fail.
**Prompt:** Test `ROUTES` and `ROUTE_PATTERNS` objects from `web/src/config/routes.ts`. Assert `ROUTES.chat()` resolves to `/chat/new` when given undefined, empty, or `"new"`. Assert `ROUTES.chat("abc")` resolves to `/chat/abc`. Assert `ROUTES.code("abc")` resolves to `/code/abc`. Assert `ROUTES.code("")` throws an error explaining Code draft is not supported. Assert `ROUTES.parseConversationId` safely decodes URL segments and handles both `/chat/` and `/code/` prefixes, returns `null` for `/chat/new`, returns `null` on extra raw path segments, safely handles malformed percent sequences without throwing, and round-trips encoded slashes.

---

## 11. Tab Persistence and Initial Invariant

### Test 27: Initial draft tab invariant across edge cases [DONE]
**File:** `tests/unit/web/chat/chatTabs.persistence.test.ts` — 11 pass, 0 fail.
**Prompt:** Test `loadPersisted()` and `loadRaw()` under synthetic `localStorage` states. Assert that when `localStorage` has no key, invalid JSON, or throwing `getItem`, `loadPersisted()` returns exactly 1 tab with `kind: "chat"`, `ref: "new"`, and `activeKey: "chat:new"`. Assert legacy `{ openIds: ["a", "", "a", "b"], activeId: "c" }` migrates to unique non-empty tabs and picks `chat:a` as activeKey. Assert that a snapshot with only poisoned unrepairable tabs heals to the fresh draft tab.

---

## 12. Nested Route Error Containment

### Test 28: Router structural check for nested error elements and ROUTE_PATTERNS [DONE]
**File:** `tests/dom/core/router-smoke.test.tsx` — 9 pass, 0 fail.
**Prompt:** Read `web/src/app/router.tsx`. Assert that `errorElement: <RouteError />` is declared on `ChatShell` and `SettingsLayout` in addition to `AppShell` and `CodeShell`. Assert that route patterns consume centralized `ROUTE_PATTERNS` constants.

---

## 13. Full Application Routing, Cross-Engine & Persistence E2E

### Test 29: Cross-engine, deep link refresh, 404 recovery, 5xx retention, error containment, and AppShell persistence E2E [DONE]
**File:** `tests/e2e/routing/index-redirect.spec.ts` (Playwright) — 10 tests.
**Prompt:** Seed real Direct and OpenCode conversations.
1. Index redirects: Active Direct, active Code, and empty storage fallback.
2. Cross-engine: Navigate to `/#/chat/<opencodeId>`, assert URL transitions to `#/code/<opencodeId>`. Navigate to `/#/code/<directId>`, assert URL transitions to `#/chat/<directId>`.
3. Refresh: Navigate to `/#/chat/<id>` and `/#/code/<id>`, reload page, assert URL and active tabs remain intact.
4. AppShell persistence: Acquire DOM element handle for the primary navigation rail (`nav[aria-label='Primary']`) inside AppShell, perform client navigation from Chat to Code, assert the element node handle remains connected (`isConnected === true`) and retains its exact DOM identity (`element === currentNav`), proving AppShell did not unmount or remount.
5. Confirmed 404: Navigate to non-existent ID, assert safe eviction and redirection to `#/chat/new` without looping.
6. Transient 5xx retention: Intercept `/api/conversations/<id>` with 500 error, assert current tab and route are retained without evicting to new chat.
7. Nested error boundary containment: Abort bundle loading for a child route, assert `RouteError` renders while preserving AppShell primary navigation chrome, and clicking "New chat" recovers navigation to `#/chat/new`.
8. History back: Verify replacement navigation on index redirect so clicking browser back returns directly to the prior route without history loops.
