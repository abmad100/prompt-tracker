// lib/matching.js — Prompt Tracker
//
// Pure, side-effect-free prompt-matching/search logic. No I/O, no Notion
// calls, no DOM access. Loaded two different ways depending on
// environment, per the converged plan's own resolution of a real
// /gpt-review finding (round 1 P2: "inline script importing
// lib/matching.js" is not a coherent loading mechanism — a plain inline
// <script> can't `import`, and UMD needs a separate script tag loaded
// first):
//   - Node (tests/matching.test.js): `require('../lib/matching.js')`
//     hits the `module.exports` branch below.
//   - Browser (index.html): loaded via a plain, non-module
//     `<script src="lib/matching.js"></script>` tag BEFORE the page's
//     own inline <script>, which then reads `window.PromptMatching`.
// Exactly one set of functions, two load paths — no dual maintenance.

function normalize(text) {
  return text.trim().toLowerCase();
}

function findExactMatch(prompts, query) {
  const normalizedQuery = normalize(query);
  if (normalizedQuery === "") return null;
  for (const p of prompts) {
    if (p.normalizedText === normalizedQuery) return p;
  }
  return null;
}

// Matches against the FULL prompt text (not just the ~60-char preview
// shown in the library view), case-insensitive. The query is tokenized
// into individual whitespace-separated words, and a prompt matches only
// if EVERY query word appears somewhere in its text — each word checked
// independently, not as one contiguous phrase. This is deliberately an
// AND-of-words match, not a single includes() on the whole query string:
// a plain whole-string substring check only succeeds when the typed text
// happens to appear verbatim and contiguous, which in practice mostly
// only works for a prefix of the prompt (what you naturally type first)
// — a query like "summary meeting" would never match "Summarize the
// meeting notes" under that scheme, even though both words are present.
// Word order and position within the prompt don't matter here. Sorted by
// count descending, matching the library view's own default sort.
function filterPrompts(prompts, query) {
  const words = normalize(query)
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const matches =
    words.length === 0
      ? prompts.slice()
      : prompts.filter((p) => {
          const normalizedText = normalize(p.promptText);
          return words.every((w) => normalizedText.includes(w));
        });
  return matches.slice().sort((a, b) => b.count - a.count);
}

// Resolves what state the UI should be in for a given query, per the
// BUILD SPEC's exact-match / create-new logic. Extracted as its own pure
// function (round 5 of the plan-review loop) so this decision is
// automated-test-covered (Mode 1) rather than left as untested inline
// DOM/event-handler logic.
//   - idle: query is blank
//   - match: an exact (case-insensitive, trim-only) match exists
//   - create: no exact match — the "+ Create new prompt with this text"
//     affordance should show
function resolveSearchState(prompts, query) {
  const normalizedQuery = normalize(query);
  if (normalizedQuery === "") {
    return { state: "idle", prompt: null };
  }
  const match = findExactMatch(prompts, query);
  if (match) {
    return { state: "match", prompt: match };
  }
  return { state: "create", prompt: null };
}

// Upserts `prompt` into `prompts` by id — replaces an existing entry
// sharing the same id, or appends if none is found. Returns a NEW
// array; does not mutate the input, matching this module's existing
// pure-function style. Extracted (same reasoning as
// resolveSearchState above — round 5) so it's automated-test-covered
// rather than left as untested inline DOM logic (diff-review round 8
// P2 finding): POST /api/prompts's find-or-create response can return
// `created: false` (the server found an existing record instead of
// making a new one) — blindly appending its `prompt` in that case can
// add a duplicate row whenever the client's own list is stale,
// truncated, or otherwise doesn't already contain that record.
function upsertById(prompts, prompt) {
  const index = prompts.findIndex((p) => p.id === prompt.id);
  if (index === -1) {
    return prompts.concat([prompt]);
  }
  const next = prompts.slice();
  next[index] = prompt;
  return next;
}

const PromptMatching = {
  normalize,
  findExactMatch,
  filterPrompts,
  resolveSearchState,
  upsertById,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = PromptMatching;
} else {
  window.PromptMatching = PromptMatching;
}
