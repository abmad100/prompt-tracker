// tests/matching.test.js — Mode 1 (automated red/green) coverage for
// lib/matching.js, per the converged plan's own verification summary.
// Zero-dependency: Node's built-in node:test + node:assert, runnable via
// `node --test tests/` with no `npm install`.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalize,
  findExactMatch,
  filterPrompts,
  resolveSearchState,
  upsertById,
} = require("../lib/matching.js");

const PROMPTS = [
  {
    id: "1",
    promptText: "Summarize this document in three bullet points",
    normalizedText: "summarize this document in three bullet points",
    count: 3,
  },
  {
    id: "2",
    promptText: "Write a haiku about autumn leaves",
    normalizedText: "write a haiku about autumn leaves",
    count: 10,
  },
  {
    id: "3",
    promptText: "  Explain quantum entanglement to a five-year-old  ",
    normalizedText: "explain quantum entanglement to a five-year-old",
    count: 1,
  },
];

test("normalize trims and lowercases", () => {
  assert.equal(normalize("  Hello World  "), "hello world");
  assert.equal(normalize("ALREADY LOWER"), "already lower");
  assert.equal(normalize(""), "");
});

test("findExactMatch matches case-insensitively and trim-only", () => {
  const m = findExactMatch(PROMPTS, "WRITE A HAIKU ABOUT AUTUMN LEAVES");
  assert.equal(m.id, "2");
  const m2 = findExactMatch(PROMPTS, "  write a haiku about autumn leaves  ");
  assert.equal(m2.id, "2");
});

test("findExactMatch returns null on no match", () => {
  assert.equal(findExactMatch(PROMPTS, "something totally different"), null);
});

test("findExactMatch returns null on blank query", () => {
  assert.equal(findExactMatch(PROMPTS, ""), null);
  assert.equal(findExactMatch(PROMPTS, "   "), null);
});

test("filterPrompts matches full prompt text, not just a preview", () => {
  // "entanglement" only appears deep in prompt 3's full text.
  const results = filterPrompts(PROMPTS, "entanglement");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "3");
});

test("filterPrompts is case-insensitive substring, sorted by count desc", () => {
  const results = filterPrompts(PROMPTS, "a");
  // all three contain "a" somewhere; must be sorted by count descending
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((r) => r.id),
    ["2", "1", "3"]
  );
});

test("filterPrompts with blank query returns everything, sorted", () => {
  const results = filterPrompts(PROMPTS, "");
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((r) => r.id),
    ["2", "1", "3"]
  );
});

test("filterPrompts with no match returns empty array", () => {
  assert.deepEqual(filterPrompts(PROMPTS, "xyzzy-nonexistent"), []);
});

test("filterPrompts matches non-contiguous terms anywhere in the prompt, not just as a single typed phrase", () => {
  // "document" is the 6th word and "bullet" the 8th of prompt 1's text
  // ("Summarize this document in three bullet points") -- "document
  // bullet" is never a contiguous substring of it, but both terms are
  // present, so this must still match. Term order in the query doesn't
  // have to match word order in the prompt either.
  const results = filterPrompts(PROMPTS, "bullet document");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "1");
});

test("filterPrompts requires ALL query terms to be present (AND, not OR)", () => {
  // "haiku" only appears in prompt 2; "entanglement" only in prompt 3.
  // Requiring both must match neither.
  assert.deepEqual(filterPrompts(PROMPTS, "haiku entanglement"), []);
});

test("filterPrompts collapses repeated/irregular whitespace between query terms", () => {
  const results = filterPrompts(PROMPTS, "  bullet    document  ");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "1");
});

// Deliberate behavior lock, not a gap-filler: filterPrompts matches each
// query term as a plain substring, never as a whole token. That's an
// intentional, accepted tradeoff (see lib/matching.js's own docstring on
// filterPrompts) -- these two tests exist so a future edit that "fixes"
// this into strict word-boundary matching does so as a conscious,
// reviewed decision, not an accidental regression nobody notices.
test("filterPrompts intentionally matches a query term as a substring of a longer word, not just a whole word", () => {
  const prompts = [
    { id: "x", promptText: "Educate the user on best practices", count: 1 },
  ];
  // "cat" is not a standalone word anywhere in that prompt -- it only
  // occurs inside "edu-CAT-e". This must still match.
  assert.equal(filterPrompts(prompts, "cat").length, 1);
});

test("filterPrompts does NOT do stemming -- a query term must be a literal substring, not a shared word root", () => {
  const prompts = [{ id: "y", promptText: "Summarize the meeting notes", count: 1 }];
  // "summary" is not a literal substring of "summarize" (…mma-RY vs.
  // …mma-RIZE) despite sharing a root -- this must NOT match, and a
  // multi-term query where one term fails must reject the whole prompt.
  assert.deepEqual(filterPrompts(prompts, "summary"), []);
  assert.deepEqual(filterPrompts(prompts, "summary meeting"), []);
});

test("resolveSearchState: blank query is idle", () => {
  const r = resolveSearchState(PROMPTS, "");
  assert.equal(r.state, "idle");
  assert.equal(r.prompt, null);
});

test("resolveSearchState: exact match resolves to 'match' with the prompt", () => {
  const r = resolveSearchState(PROMPTS, "Write a haiku about autumn leaves");
  assert.equal(r.state, "match");
  assert.equal(r.prompt.id, "2");
});

test("resolveSearchState: no exact match resolves to 'create'", () => {
  const r = resolveSearchState(PROMPTS, "a brand new prompt nobody has saved yet");
  assert.equal(r.state, "create");
  assert.equal(r.prompt, null);
});

test("resolveSearchState: a non-empty substring match that isn't exact is still 'create'", () => {
  // "haiku" is a substring of prompt 2 but not an exact normalized match.
  const r = resolveSearchState(PROMPTS, "haiku");
  assert.equal(r.state, "create");
});

// ---------------------------------------------------------------------
// upsertById — diff-review round 8 P2: POST /api/prompts's create-
// response can report `created: false` (found an existing record
// instead of making a new one); index.html uses this to avoid pushing
// a duplicate row into the in-memory library.
// ---------------------------------------------------------------------

test("upsertById appends when no existing entry shares the id", () => {
  const next = upsertById(PROMPTS, { id: "4", promptText: "new one", count: 0 });
  assert.equal(next.length, 4);
  assert.equal(next[3].id, "4");
});

test("upsertById replaces (not duplicates) an existing entry with the same id", () => {
  const updated = { id: "2", promptText: "Write a haiku about autumn leaves", count: 11 };
  const next = upsertById(PROMPTS, updated);
  assert.equal(next.length, 3); // NOT 4 — this is the exact bug this fix closes
  const entry = next.find((p) => p.id === "2");
  assert.equal(entry.count, 11);
});

test("upsertById does not mutate the input array or its objects", () => {
  const original = PROMPTS.slice();
  const originalP2 = PROMPTS[1];
  upsertById(PROMPTS, { id: "2", promptText: "changed", count: 999 });
  assert.deepEqual(PROMPTS, original);
  assert.equal(PROMPTS[1], originalP2);
  assert.equal(originalP2.count, 10);
});

test("upsertById on an empty list appends as the only entry", () => {
  const next = upsertById([], { id: "1", promptText: "first", count: 0 });
  assert.equal(next.length, 1);
  assert.equal(next[0].id, "1");
});
