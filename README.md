# Prompt Tracker

A small personal website for tracking reuse of saved prompts: a searchable
library with usage counts, live full-text search, exact-match detection that
surfaces the matched prompt for reuse, and a Copy button that copies the text
to your clipboard and increments its usage count in Notion.

Built per `PU-20260814-0809-7QK2` under the Hey Man Claude Code Handoff
Standard v0.29. Full design history (16 rounds of `/gpt-review` plan
convergence, every declined/accepted finding with reasoning) is in the
dedicated Lessons Learned doc:
https://drive.google.com/file/d/1oCtGaFrMtgB_MC6Lc9q4SesuY5EXvXga/view

## How it works

- The library and search UI are static files (`index.html`, `styles.css`,
  `lib/matching.js`) served directly by Vercel.
- Two serverless functions back the data:
  - `GET/POST /api/prompts` — list the library (paginated from Notion,
    capped at the first 5,000 records) or find-or-create a prompt by exact
    normalized text.
  - `POST /api/prompts/:id/copy` — increments a prompt's usage count and
    sets its "Last Used" timestamp.
- All data lives in a single Notion database — this app has no database of
  its own.

## Setup

1. Create a Notion internal integration and note its secret ("Internal
   Integration Secret").
2. Create a Notion database (or use an existing page as the parent) with
   exactly these properties:

   | Property | Type | Notes |
   |---|---|---|
   | Prompt Text | Title | The full prompt text, stored as one or more chunked rich-text runs under 2,000 chars each. |
   | Normalized Text | Rich text | `trim().toLowerCase()` of Prompt Text — used to detect exact matches. |
   | Normalized Hash | Rich text | SHA-256 hex digest of Normalized Text — used as a query-safe index for duplicate lookup (Notion's filter API has practical length limits that make filtering on the full text impractical). |
   | Count | Number | Times this prompt has been copied. Starts at 0. |
   | Last Used | Date | Set on every copy. Absent until the first copy. |
   | Created | Date | Set once, at creation. |

   Share the database with your integration.
3. Deploy this repo to Vercel. Set these environment variables in the
   Vercel project:
   - `NOTION_API_KEY` — the integration secret from step 1.
   - `NOTION_DATABASE_ID` — the database ID from step 2.
   - `ALLOWED_ORIGIN` — the exact origin serving this app (e.g.
     `https://prompt-tracker.vercel.app`). Used for CSRF protection on the
     write endpoints (`isSameOrigin` in `lib/notion.js`). If unset, the
     endpoints fall back to Vercel's own `VERCEL_URL` environment variable
     (a bare host, normalized to `https://<host>` before comparison).
4. **Turn on Vercel Deployment Protection for this project**, scoped to
   your own Vercel account/team only. This is the app's *only* access
   control — see "Security model" below. Without it, this deployment is a
   public website with no login.

## Security model (read this before deploying)

This app deliberately has **no application-level authentication**. Every
request that reaches a deployment is treated as trusted. Access control is
delegated entirely to **Vercel Deployment Protection**, scoped to your own
account. This was an explicit, reviewed decision (round 2 of the plan
review, restated and re-confirmed across the rest of the 16-round loop with
no new evidence changing the tradeoff) — for a single-user personal tool,
adding a second, app-level auth layer on top of Deployment Protection was
judged not proportionate to the risk it would close.

**What this means in practice:**
- If Deployment Protection is ever disabled, misconfigured, or the
  deployment URL is shared, anyone who reaches it can read your prompt
  library, create new prompts, and inflate copy counts. There is no
  secondary gate.
- The `Origin`-header check in `lib/notion.js` (`isSameOrigin`) is CSRF
  protection for browser-based cross-site requests — it is **not**
  authorization. A request with no `Origin` header, or one that doesn't
  match the configured value, is rejected — but a direct, non-browser
  caller that simply sets a matching `Origin` header is indistinguishable
  from a real browser request and passes this check just as easily.
- If you ever want to share this tool beyond your own account, add a real
  application-level auth layer first.

## Known limitations (accepted, not bugs)

- **Copy-count updates are read-modify-write, not atomic.** Two genuinely
  concurrent copy requests for the same prompt (e.g. two open browser tabs)
  can race and lose an increment. This was an explicit decision (round 4 of
  the plan review) — an event-log redesign was considered and declined as
  disproportionate for a personal single-user tool. The UI mitigates the
  most common case by disabling the Copy button while a request is in
  flight, but this does not close a true cross-tab/cross-device race.
- **Duplicate-prompt creation has the same non-atomic nature.** A race
  between two create requests for the same new prompt text can produce two
  separate records. Duplicate detection is hash-indexed and capped at the
  first 10 candidates sharing a hash; if a real duplicate exists beyond
  that cap, or the check can't complete, the response sets
  `duplicateCheckIncomplete: true` and the UI surfaces a note rather than
  silently guaranteeing uniqueness.
- **The library view is capped at the first 5,000 records** (50 pages of
  Notion's own page size). If your library grows past that, `truncated:
  true` is returned, a warning is shown, and creating new prompts is
  disabled from that state (since duplicate detection can't see beyond the
  loaded window) until the underlying library is pruned or this cap is
  revisited.
- **No rate limiting, per-caller audit logging, or request correlation
  IDs.** Generic Vercel platform logs are the only operational visibility.
  Considered and declined as disproportionate for a personal, Deployment-
  Protection-gated tool — see the plan LL doc for the full reasoning.

## Data handling

Prompt text is stored verbatim in your own Notion workspace — this app does
not have its own database. Treat prompt content the same way you'd treat
any other content in that Notion workspace: retention, deletion, export,
and access review are governed by your existing Notion workspace controls,
not by this app. Deleting a record in Notion directly is the supported way
to remove a prompt.

## Local development

```
npm test          # run the full test suite (node --test, zero external deps)
```

Tests use mocked `fetch` calls — no live Notion credentials or network
access are required to run them.

## Tech

- Vercel Serverless Functions (Node.js), no framework.
- Notion API v2022-06-28, called directly via `fetch` (no SDK dependency).
- Zero runtime npm dependencies. Tests use Node's built-in `node:test`
  runner.
