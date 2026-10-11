# EMERGENCY PRESERVATION SNAPSHOT — NOT AN APPROVED PRODUCTION COMMIT

> **READ THIS FIRST.**
>
> This branch exists solely because the workstation hosting this repository was
> crashing or at risk of becoming unavailable. It was created under an
> instruction whose explicit purpose was **preservation**, not review,
> integration, or release.
>
> **Nothing on this branch has been reviewed, approved, or released.**
> **Do not merge this into `main`. Do not deploy from it.**
> **Do not treat the commit history here as a proposed or agreed commit sequence.**

---

## What this branch is

An emergency checkpoint of a working tree that contained a substantial amount of
**uncommitted work belonging to at least two other agents**, alongside a
backend-strictness recovery effort. It is a snapshot of a messy state, preserved
so the work is not lost. That is its entire purpose.

## What is deliberately NOT true of this branch

- The three-commit boundary (MCP extraction / chat+strictness / scheduler
  behaviour) was **proposed but never executed**. The scheduler behaviour change
  remains uncommitted-by-agreement and is the one file that differs between the
  working tree and the proposed tree — see `proposed-commit2-delta/`.
- No commit on this branch is approved. The compiler and test evidence gathered
  before the crash is recorded in `evidence/` and summarised in
  `INTEGRATION-PLAN.md`, but it was gathered in **scratch reproduction trees**,
  not on this branch.
- The working tree was **not independently verified as a whole**. Roughly 382
  tracked files outside the recovery scope were modified by concurrent work.

## Layout

| Path | What it is |
|---|---|
| `pre-integration-backup/` | Byte-verified backup of the 16 recovery target paths as they stood **before** the integration was written. This is the only rollback that exists for three of them, which are untracked and absent from git history. |
| `recovered-blob-candidates/` | 39 candidate blobs exported byte-for-byte from dangling git objects, the source material for the recovery. |
| `proposed-commit2-delta/` | The **single file** that differs between this working tree and the verified proposed-commit-2 tree. |
| `evidence/` | Junit captures (before/after per-test comparisons), the recovery manifest, byte-hash records, and the test-gate results captured before the crash. |
| `INTEGRATION-PLAN.md` | The integration plan, including its record of the six remaining test failures and the six concurrent test files that were absent from the reproduction tree. |

## Recovery source that is NOT here

The full `scratch/` reproduction trees (~1,150 files each, five of them) were not
copied in — they are near-duplicates of this working tree and would add hundreds
of megabytes for no additional recoverable content. Their distinguishing delta is
the single file in `proposed-commit2-delta/`. The remaining trees differed from
this tree only in line endings, which was verified rather than assumed.

## Secrets

No credentials were published. `*.db` files and `.env` are gitignored and were
excluded by `git add -A`. `src/services/credentials.ts` is application source
that encrypts secrets at rest and contains no key literals.

## If you are reading this to decide what to do next

Start with `INTEGRATION-PLAN.md`, then read `evidence/10-review-freeze.txt` and
`evidence/integration-precondition-check.tsv`. The recovery is reproducible from
`recovered-blob-candidates/` plus the strictness work, but **verify rather than
trust** — two candidate selections were wrong during recovery and were corrected
by compiler feedback, which means passing checks do not by themselves prove a
file is the intended lost version.