# Prompt Tracker — Implementation Plan (rev 15, post /gpt-review rounds 1-14)

Governing PU: PU-20260814-0809-7QK2 | Handoff: https://drive.google.com/file/d/1GuuCQAp229cTTpwJxBdsCLMiIEkMt-vd/view
Standard: Claude Code Handoff Standard v0.29 | Lane: 100% lane (b).
Full round-by-round history: workstream LL doc,
https://drive.google.com/file/d/1oCtGaFrMtgB_MC6Lc9q4SesuY5EXvXga/view

**Round 14 was the first pass with zero genuinely new findings — this is
pass 1 of the 2 required consecutive clean passes for CLEAN CONVERGENCE
(Standard §8 v0.26).**

CLOSED BY AUTHORITY DECISION — not reopened absent genuinely new
evidence: (1) Deployment-Protection-only auth — Mose, round 2, restated
10x. (2) Copy-count race — Mose, round 4, restated 4x. (3) Create-
duplicate-race — same class as #2.

DECLINED, proportionality, unchanged reasoning on every restatement:
mid-pagination byte budget (4x); real pagination past 5,000 records
(2x); rate-limiting/timeout machinery; hard conflict on hash-candidate
exhaustion (5x — signaled via `duplicateCheckIncomplete` instead); in-app
retention/deletion/export; a dedicated Notion-schema-verification
endpoint (2x — manual README step instead); requiring user confirmation
on duplicate-check-incomplete; structured logging/request-correlation
infrastructure (round 14) — Vercel's own function logs are proportionate
at this scale.

## Round 14 clarifications (wording only, no design/behavior change —
two already-implemented fixes were restated because the prose was still
ambiguous, not because the fixes were missing)

1. **Aggregate prompt-length cap** (20,000 Unicode code points) is
   checked in `api/prompts.js`'s `POST` handler STRICTLY BEFORE
   `chunkRichText` ever runs — chunking only ever operates on
   already-validated, already-bounded text. Stated explicitly here to
   remove any remaining ambiguity: this is not merely a per-chunk limit.
2. **Content-Type check** accepts `application/json` with any standard
   parameters (e.g. `; charset=utf-8`) — parses the media-type portion
   before any `;`, case-insensitive compare. Not exact string equality.
3. README's manual verification step now explicitly lists checking each
   of the 6 Notion properties (name + type) individually, not just "try
   the full flow."

## Notion database schema (unchanged since rev 4)

| Property | Notion type | JS field | Mapping |
|---|---|---|---|
| Prompt Text | title | `promptText` | chunked ≤2000-codepoint array, original casing |
| Normalized Text | rich_text | `normalizedText` | chunked ≤2000-codepoint array, `text.trim().toLowerCase()` |
| Normalized Hash | rich_text | `normalizedHash` | ≤64-char hex, `sha256Hex(normalizedText)`, re-verified before trust |
| Count | number | `count` | non-negative safe integer, overflow-guarded read+write |
| Last Used | date | `lastUsed` | canonical `toISOString()` form on every copy; null until first copy |
| Created | date | `created` | canonical `toISOString()` form, set once |

Env vars: `NOTION_API_KEY`, `NOTION_DATABASE_ID`, `ALLOWED_ORIGIN`
(optional, else derived from `VERCEL_URL`).

## Current design (all rounds' fixes incorporated — stable since rev 14)

**`lib/matching.js`** — `normalize`, `findExactMatch`, `filterPrompts`,
`resolveSearchState`. Dual-environment export guard. **Mode 1**:
`tests/matching.test.js`.

**`lib/notion.js`** — `NOTION_API_VERSION="2022-06-28"`,
`chunkRichText(text, maxLen=2000)` (code-point-safe, only ever called on
text already validated ≤20,000 code points), `sha256Hex(text)`,
`parseCount(raw)` (finite/non-negative/safe-integer, read+write
guarded), `serializedSizeBytes` (3.5MB threshold, actionable-message
503), `readBodyWithLimit(req, maxBytes)` (streaming, single-response-
safe), `expectedOrigin()` (computes+validates the normalized trusted
origin once, from `ALLOWED_ORIGIN`/`VERCEL_URL`, throws a clear config
error if unparseable), `isSameOrigin(req)` (normalized `URL(...).origin`
comparison, fails closed), `isValidIso8601(str)` (exact canonical
`toISOString()` form only), `buildListQuery`, `buildCreatePayload`,
`buildFindByHashQuery` (`page_size: 10`),
`buildCopyUpdatePayload(currentCount, nowIso)`, `parseNotionPage`,
`isValidPageId`, `isValidPromptRecordShape(page)` (recomputes
normalize+hash from stored Prompt Text, exact match required; validates
Created/Last Used via `isValidIso8601`). **Mode 1**:
`tests/notion.test.js` — chunking incl. surrogate-pair boundary, hash
determinism, `parseCount` accept/reject incl. unsafe integers, size
threshold, `buildCopyUpdatePayload` both-fields assertion,
`isValidPromptRecordShape` accept/reject, `readBodyWithLimit`
oversized/error rejection, `isSameOrigin`/`expectedOrigin` accept/reject
incl. the scheme-vs-bare-host case, `isValidIso8601`'s exact-form
requirement.

**`api/prompts.js`** — `export const config = { api: { bodyParser: false
} }`. `GET`: bounded pagination (50 pages/5,000 records, `truncated`
flag), per-record shape+consistency check + try/catch (fold into
`skippedCount`), full-response size guard (`503`, actionable message).
`POST`: `Content-Type` check FIRST (415, parameter-tolerant) →
`isSameOrigin` (403 CSRF) → `readBodyWithLimit` (streaming 413) → JSON
body validation, non-empty + ≤20,000 code points BEFORE any chunking
(400s) → compute hash → 10-candidate hash lookup, verify each → return
existing page if duplicate, else create
(`duplicateCheckIncomplete: true` in the response if candidates existed
but none verified). 405 on other methods; bounded generic error
messages; clean 500 if env vars unset. **Mode 2**:
`tests/api-prompts.test.js`, mocked `fetch`.

**`api/prompts/[id]/copy.js`** — method check FIRST (POST-only, 405).
`isSameOrigin` (403 CSRF). Validate `id`. `GET /v1/pages/{id}` →
database membership + record-shape/consistency/date check → 404 if any
fail → `parseCount`, reject if `count >= Number.MAX_SAFE_INTEGER` →
`PATCH` via `buildCopyUpdatePayload(count + 1, nowIso)` → response
includes new count. **Mode 2**: `tests/api-copy.test.js` — full
enforcement chain.

**`index.html`** — library view (rows sorted by count, ~60-char preview,
visible notes for `skippedCount`/`truncated`; "+ Create new" disabled +
warning when truncated), live search, active-prompt panel or create-new
affordance, Copy button (await clipboard → on success, await POST →
"Copied!" or "Copied! (tracking failed)"; optimistic count reconciliation;
disabled while in-flight); a brief note when a create response carries
`duplicateCheckIncomplete: true`. **All prompt-derived rendering via
`textContent`/DOM node creation exclusively.** Comment block citing all
closed-by-authority decisions and declined items. **Mode 1** extracted
decision logic; **Mode 2** grep-based innerHTML check; **Mode 3**
remaining DOM/fetch/clipboard wiring.

**`styles.css`** — minimal. **Mode 3**.
**`vercel.json`** — static + `/api` functions. **Mode 2**.
**`package.json`** — `"test": "node --test tests/"`. **Mode 3**.
**`README.md`** — MANUAL STEPS + explicit per-property post-setup
verification checklist (round 14), all FOUR formal accepted-limitation
records, Deployment-Protection scoping guidance, data-handling note,
named env vars, CSRF note. **Mode 3**.
**`.gitignore`** — `node_modules/`, `.vercel/`. **Mode 3**.

## Deliverable-boundary wording (final)

This session authors all code/content: database schema (PU Gate G1) and
full app source (PU Gate G2). The empty GitHub repository container
required Mose's own action (live-discovered PAT-scope limitation). Once
it exists, this session pushes all code. Mose separately creates the
Notion integration credential, shares the database, imports the repo as
a Vercel project, sets the three named environment variables,
configures Deployment Protection, and runs the README's per-property
verification checklist.

## Cost & Concurrency Plan (unchanged since rev 2)

Small, mostly-sequential build; no genuine parallel-session opportunity.
~12 new source/test files, one Notion DB creation, one GitHub repo push
(container blocked pending Mose — 14 rounds now).

## Test files (final list)

`tests/matching.test.js`, `tests/notion.test.js`,
`tests/api-prompts.test.js`, `tests/api-copy.test.js` — zero-dependency
`node:test`, `node --test tests/`, no `npm install` required.
