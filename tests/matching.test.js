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
