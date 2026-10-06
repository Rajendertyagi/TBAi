# PM Focused Audit — createV2RuntimeStore Internals

**Purpose:** Facts only. No fixes. No suggestions. Code snippets in full where asked.

---

## 1. Full code of `createV2RuntimeStore`

Show the complete function body of `createV2RuntimeStore` — wherever it is defined in `web/src/features/opencode/`.

---

## 2. Full code of `projectV2RepositoryItems`

Show the complete function body of `projectV2RepositoryItems` — wherever it is defined.

---

## 3. What is `messageRepository` exactly?

In the context of `createV2RuntimeStore` or wherever it is built:
- What TypeScript type/interface does it conform to?
- Where is that type defined? Show the definition.

---

## 4. assistant-ui `useExternalStoreRuntime` contract

- What does `useExternalStoreRuntime` expect as its argument? Show the TypeScript type it accepts.
- Which file/package defines this? (`web/node_modules/...` is fine)
- Does assistant-ui document or expose any memoization helper for this adapter? Yes/No + show if yes.

---

## 5. The identity check in assistant-ui

The coding agent found that assistant-ui has an identity check at `external-store-thread-runtime-core.js:191-196` (`if (this._store === store) return`).
- Show those exact lines.
- What is `store` in that context — what field of the adapter object does it compare?

---

## 6. What parts of `V2ThreadState` does `createV2RuntimeStore` actually use?

List every field of `V2ThreadState` that `createV2RuntimeStore` (and any functions it calls) reads. Be specific.

---

## Delivery

Return as markdown. One section per question. Full code where asked. Facts only.
