// tests/notion.test.js — Mode 1 coverage for lib/notion.js.
// Zero-dependency: node:test + node:assert.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const notion = require("../lib/notion.js");

// ---------------------------------------------------------------------
// chunkRichText — including the round-9 surrogate-pair boundary case
// ---------------------------------------------------------------------

test("chunkRichText: short text is a single chunk", () => {
  const chunks = notion.chunkRichText("hello world", 2000);
  assert.deepEqual(chunks, ["hello world"]);
});

test("chunkRichText: splits at exact code-point boundaries", () => {
  const text = "a".repeat(4500);
  const chunks = notion.chunkRichText(text, 2000);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 2000);
  assert.equal(chunks[1].length, 2000);
  assert.equal(chunks[2].length, 500);
  assert.equal(chunks.join(""), text);
});

test("chunkRichText: never splits a surrogate pair (emoji boundary case)", () => {
  // Build a string where an astral character (an emoji, which is a
  // UTF-16 surrogate pair, 2 code units but 1 code point) sits exactly
  // at what would be a naive raw-index chunk boundary.
  const filler = "x".repeat(1999); // 1999 code points
  const emoji = "\u{1F600}"; // 😀 — one code point, two UTF-16 units
  const text = filler + emoji + "y".repeat(10);
  const chunks = notion.chunkRichText(text, 2000);
  // The emoji must appear whole in exactly one chunk, never split.
  const rejoined = chunks.join("");
  assert.equal(rejoined, text);
  assert.ok(chunks.some((c) => c.includes(emoji)));
  // Confirm no chunk contains a lone unpaired surrogate.
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const code = c.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        // high surrogate — must be immediately followed by a low surrogate
        // within the SAME chunk
        assert.ok(
          i + 1 < c.length && c.charCodeAt(i + 1) >= 0xdc00 && c.charCodeAt(i + 1) <= 0xdfff,
          "found an unpaired high surrogate at a chunk boundary"
        );
      }
    }
  }
});

test("chunkRichText: empty string produces one empty chunk", () => {
  assert.deepEqual(notion.chunkRichText("", 2000), [""]);
});

test("chunkRichText: astral-heavy content never produces a chunk exceeding maxLen in UTF-16 length (diff-review round 1 P2 finding)", () => {
  const emoji = "\u{1F600}"; // 😀 — 1 code point, 2 UTF-16 units
  const text = emoji.repeat(1500); // 1500 code points, 3000 UTF-16 units
  const chunks = notion.chunkRichText(text, 2000);
  for (const c of chunks) {
    assert.ok(c.length <= 2000, `chunk exceeded 2000 UTF-16 units: got ${c.length}`);
  }
  assert.equal(chunks.join(""), text); // reassembly still exact
  // A code-point-COUNT-based chunker (the pre-fix design: 2000 code
  // points per chunk) would put all 1500 code points into a SINGLE
  // 3000-UTF-16-unit chunk here, since 1500 < 2000 — confirm this
  // implementation genuinely splits it instead.
  assert.ok(chunks.length > 1);
});

// ---------------------------------------------------------------------
// sha256Hex — determinism
// ---------------------------------------------------------------------

test("sha256Hex is deterministic and 64 hex chars", () => {
  const h1 = notion.sha256Hex("hello");
  const h2 = notion.sha256Hex("hello");
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.notEqual(notion.sha256Hex("hello"), notion.sha256Hex("world"));
});

// ---------------------------------------------------------------------
// parseCount — full accept/reject matrix, incl. unsafe integers
// ---------------------------------------------------------------------

test("parseCount accepts finite non-negative safe integers", () => {
  assert.equal(notion.parseCount(0), 0);
  assert.equal(notion.parseCount(42), 42);
  assert.equal(notion.parseCount(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test("parseCount rejects null/undefined/non-number", () => {
  assert.equal(notion.parseCount(null), null);
  assert.equal(notion.parseCount(undefined), null);
  assert.equal(notion.parseCount("5"), null);
  assert.equal(notion.parseCount({}), null);
});

test("parseCount rejects negative, NaN, Infinity", () => {
  assert.equal(notion.parseCount(-1), null);
  assert.equal(notion.parseCount(NaN), null);
  assert.equal(notion.parseCount(Infinity), null);
});

test("parseCount rejects non-integer and unsafe-integer values", () => {
  assert.equal(notion.parseCount(3.5), null);
  assert.equal(notion.parseCount(Number.MAX_SAFE_INTEGER + 10), null);
});

// ---------------------------------------------------------------------
// serializedSizeBytes — threshold behavior
// ---------------------------------------------------------------------

test("serializedSizeBytes measures the full object, not just an inner array", () => {
  const small = { prompts: [{ a: 1 }] };
  const big = { prompts: [{ a: "x".repeat(1000) }] };
  assert.ok(notion.serializedSizeBytes(big) > notion.serializedSizeBytes(small));
});

// ---------------------------------------------------------------------
// buildCopyUpdatePayload — round 5 both-fields assertion
// ---------------------------------------------------------------------

test("buildCopyUpdatePayload sets BOTH Count and Last Used", () => {
  const payload = notion.buildCopyUpdatePayload(5, "2026-08-14T09:00:00.000Z");
  assert.equal(payload.properties.Count.number, 6);
  assert.equal(payload.properties["Last Used"].date.start, "2026-08-14T09:00:00.000Z");
});

// ---------------------------------------------------------------------
// buildCreatePayload / buildFindByHashQuery
// ---------------------------------------------------------------------

test("buildCreatePayload chunks and hashes correctly, preserves original casing", () => {
  const payload = notion.buildCreatePayload("  Hello World  ");
  const titleText = payload.properties["Prompt Text"].title
    .map((t) => t.text.content)
    .join("");
  assert.equal(titleText, "  Hello World  "); // original casing preserved, not trimmed
  const normText = payload.properties["Normalized Text"].rich_text
    .map((t) => t.text.content)
    .join("");
  assert.equal(normText, "hello world");
  const hash = payload.properties["Normalized Hash"].rich_text[0].text.content;
  assert.equal(hash, notion.sha256Hex("hello world"));
  assert.equal(payload.properties.Count.number, 0);
  assert.ok(payload.properties.Created.date.start);
  // Last Used deliberately not set at creation.
  assert.equal(payload.properties["Last Used"], undefined);
});

test("buildFindByHashQuery requests page_size 10 and filters by hash equality", () => {
  const q = notion.buildFindByHashQuery("abc123");
  assert.equal(q.page_size, 10);
  assert.equal(q.filter.property, "Normalized Hash");
  assert.equal(q.filter.rich_text.equals, "abc123");
});

// ---------------------------------------------------------------------
// parseNotionPage / isValidPromptRecordShape
// ---------------------------------------------------------------------

function fakePage(overrides = {}) {
  const promptText = overrides.promptText ?? "Hello World";
  const normalizedText = promptText.trim().toLowerCase();
  const hash = notion.sha256Hex(normalizedText);
  const properties = {
    "Prompt Text": {
      title: [{ type: "text", text: { content: promptText } }],
    },
    "Normalized Text": {
      rich_text: [{ type: "text", text: { content: normalizedText } }],
    },
    "Normalized Hash": {
      rich_text: [{ type: "text", text: { content: hash } }],
    },
    Count: { number: overrides.count ?? 0 },
    Created: { date: { start: overrides.created ?? "2026-08-14T09:00:00.000Z" } },
  };
  // By default, "Last Used" is PRESENT with a null date — the real
  // shape Notion's own API returns for a genuinely never-copied record
  // (the property key always exists on a real page in a database that
  // has that column; only its value is null when unset). Pass
  // `omitLastUsed: true` to instead model a database whose schema is
  // missing the column entirely — a distinct, invalid shape (diff-
  // review round 1 P1 finding).
  if (!overrides.omitLastUsed) {
    properties["Last Used"] = {
      date: overrides.lastUsed ? { start: overrides.lastUsed } : null,
    };
  }
  return {
    id: overrides.id ?? "abcdef12-3456-7890-abcd-ef1234567890",
    properties,
  };
}

test("parseNotionPage extracts all fields correctly", () => {
  const page = fakePage({ count: 7, lastUsed: "2026-08-14T10:00:00.000Z" });
  const parsed = notion.parseNotionPage(page);
  assert.equal(parsed.promptText, "Hello World");
  assert.equal(parsed.normalizedText, "hello world");
  assert.equal(parsed.count, 7);
  assert.equal(parsed.lastUsed, "2026-08-14T10:00:00.000Z");
});

test("isValidPromptRecordShape accepts a genuine, consistent record", () => {
  assert.equal(notion.isValidPromptRecordShape(fakePage()), true);
});

test("isValidPromptRecordShape accepts a never-copied record (Last Used present, null date)", () => {
  const page = fakePage();
  assert.equal(notion.isValidPromptRecordShape(page), true);
});

test("isValidPromptRecordShape rejects a record whose Last Used property is missing from the schema entirely", () => {
  const page = fakePage({ omitLastUsed: true });
  assert.equal(notion.isValidPromptRecordShape(page), false);
});

test("isValidPromptRecordShape rejects a Last Used property with no date key at all (wrong property type)", () => {
  const page = fakePage();
  page.properties["Last Used"] = { rich_text: [] };
  assert.equal(notion.isValidPromptRecordShape(page), false);
});

test("isValidPromptRecordShape rejects a non-canonical Last Used date", () => {
  const page = fakePage({ lastUsed: "2026-02-30T00:00:00.000Z" });
  assert.equal(notion.isValidPromptRecordShape(page), false);
});

test("isValidPromptRecordShape rejects a record whose own id is malformed, even if every property is otherwise valid (diff-review round 6 P1)", () => {
  const page = fakePage();
  page.id = "not-a-real-id";
  assert.equal(notion.isValidPromptRecordShape(page), false);
});

test("isValidPromptRecordShape rejects a record with no id at all, without crashing", () => {
  const page = fakePage();
  delete page.id;
  assert.equal(notion.isValidPromptRecordShape(page), false);
});

test("isValidPromptRecordShape accepts a genuine record whose id is the non-hyphenated UUID form", () => {
  const page = fakePage();
  page.id = "abcdef1234567890abcdef1234567890";
  assert.equal(notion.isValidPromptRecordShape(page), true);
});

test("isValidPromptRecordShape rejects a tampered record (normalized text doesn't match recomputation)", () => {
  const page = fakePage();
  // Corrupt the stored Normalized Text without updating Prompt Text.
  page.properties["Normalized Text"].rich_text[0].text.content = "totally different";
  assert.equal(notion.isValidPromptRecordShape(page), false);
});

test("isValidPromptRecordShape rejects a record whose hash doesn't match its own normalized text", () => {
  const page = fakePage();
  page.properties["Normalized Hash"].rich_text[0].text.content = "0".repeat(64);
  assert.equal(notion.isValidPromptRecordShape(page), false);
});

test("isValidPromptRecordShape rejects missing/wrong-typed properties", () => {
  const page = fakePage();
  delete page.properties.Count;
  assert.equal(notion.isValidPromptRecordShape(page), false);
});

test("isValidPromptRecordShape rejects a non-canonical (rollover) date", () => {
  const page = fakePage({ created: "2026-02-30T00:00:00.000Z" });
  assert.equal(notion.isValidPromptRecordShape(page), false);
});

test("isValidPromptRecordShape rejects a record whose Prompt Text is empty, even though it's internally consistent (diff-review round 8 P2 finding)", () => {
  // fakePage() computes Normalized Text/Normalized Hash FROM promptText,
  // so an empty promptText produces a record that is genuinely
  // self-consistent (matching hash of the empty string) — every check
  // in isValidPromptRecordShape except the emptiness check itself would
  // otherwise accept it. POST /api/prompts rejects a blank prompt at
  // creation time; a record like this could only exist via a manual
  // edit made directly in Notion, and would violate the "every prompt
  // has real content" assumption the rest of the app makes.
  const page = fakePage({ promptText: "" });
  assert.equal(notion.isValidPromptRecordShape(page), false);
});

test("isValidPromptRecordShape rejects a Prompt Text that's whitespace-only after normalization", () => {
  const page = fakePage({ promptText: "   \t\n  " });
  assert.equal(notion.isValidPromptRecordShape(page), false);
});

test("isValidPromptRecordShape accepts a genuine record whose Created date uses Notion's real +00:00 form (confirmed live 2026-08-15 -- the exact record that first triggered README's 'record(s) could not be loaded' warning in production)", () => {
  const page = fakePage({ created: "2026-08-15T01:17:00.000+00:00" });
  assert.equal(notion.isValidPromptRecordShape(page), true);
});

// ---------------------------------------------------------------------
// isValidIso8601 — exact canonical form + rollover rejection
// ---------------------------------------------------------------------

test("isValidIso8601 accepts the exact toISOString() form", () => {
  assert.equal(notion.isValidIso8601(new Date().toISOString()), true);
  assert.equal(notion.isValidIso8601("2026-08-14T09:00:00.000Z"), true);
});

test("isValidIso8601 rejects non-canonical forms", () => {
  assert.equal(notion.isValidIso8601("2026-08-14"), false); // date-only
  assert.equal(notion.isValidIso8601("2026-08-14T09:00:00-04:00"), false); // offset, no ms
  assert.equal(notion.isValidIso8601("not a date"), false);
  assert.equal(notion.isValidIso8601(null), false);
});

test("isValidIso8601 rejects a rollover value via round-trip check", () => {
  // Feb 30 doesn't exist; Date silently rolls it over to March.
  assert.equal(notion.isValidIso8601("2026-02-30T00:00:00.000Z"), false);
});

test("isValidIso8601 accepts Notion's real +00:00 read-back form (confirmed live 2026-08-15, first real production write)", () => {
  assert.equal(notion.isValidIso8601("2026-08-15T01:17:00.000+00:00"), true);
});

test("isValidIso8601 rejects a rollover value in +00:00 form too (round-trip check must apply to both forms)", () => {
  assert.equal(notion.isValidIso8601("2026-02-30T00:00:00.000+00:00"), false);
});

test("isValidIso8601 rejects a genuinely non-zero offset, even with correct millisecond formatting (only Z/+00:00 represent the same instant)", () => {
  assert.equal(notion.isValidIso8601("2026-08-14T09:00:00.000+05:00"), false);
  assert.equal(notion.isValidIso8601("2026-08-14T09:00:00.000-04:00"), false);
});

// ---------------------------------------------------------------------
// sameInstant -- confirmed live 2026-08-15: isValidIso8601 accepting
// two notations for the same instant broke a downstream exact-string
// comparison in api/prompts/[id]/copy.js, causing a genuinely
// successful Notion write to report as "tracking failed."
// ---------------------------------------------------------------------

test("sameInstant treats the identical instant in Z and +00:00 form as equal", () => {
  assert.equal(
    notion.sameInstant("2026-08-15T01:17:00.000Z", "2026-08-15T01:17:00.000+00:00"),
    true
  );
  assert.equal(
    notion.sameInstant("2026-08-15T01:17:00.000+00:00", "2026-08-15T01:17:00.000Z"),
    true
  );
});

test("sameInstant treats the identical string as equal (trivial case)", () => {
  assert.equal(
    notion.sameInstant("2026-08-15T01:17:00.000Z", "2026-08-15T01:17:00.000Z"),
    true
  );
});

test("sameInstant correctly rejects genuinely different instants, even in the same notation", () => {
  assert.equal(
    notion.sameInstant("2026-08-15T01:17:00.000Z", "2020-01-01T00:00:00.000Z"),
    false
  );
  assert.equal(
    notion.sameInstant("2026-08-15T01:17:00.000Z", "2026-08-15T01:17:00.001Z"),
    false
  );
});

// ---------------------------------------------------------------------
// readBodyWithLimit — streaming, single-response-safe
// ---------------------------------------------------------------------

function fakeReq() {
  const req = new EventEmitter();
  req.destroy = () => {
    req._destroyed = true;
  };
  return req;
}

test("readBodyWithLimit resolves with the full body under the limit", async () => {
  const req = fakeReq();
  const promise = notion.readBodyWithLimit(req, 1000);
  req.emit("data", Buffer.from('{"text":"hi"}'));
  req.emit("end");
  const body = await promise;
  assert.equal(body, '{"text":"hi"}');
});

test("readBodyWithLimit rejects with PayloadTooLargeError on overflow, WITHOUT destroying the stream (diff-review round 3 P1)", async () => {
  const req = fakeReq();
  const promise = notion.readBodyWithLimit(req, 10);
  req.emit("data", Buffer.from("this is definitely more than ten bytes"));
  await assert.rejects(promise, notion.PayloadTooLargeError);
  // req.destroy() tears down the connection the caller's own response
  // needs to be sent back over — must never be called (previously WAS
  // called here; the pre-fix code genuinely destroyed the stream).
  assert.equal(req._destroyed, undefined);
});

test("readBodyWithLimit keeps ignoring further data after overflow, without pushing it into the buffered result (memory stays bounded without destroying anything)", async () => {
  const req = fakeReq();
  const promise = notion.readBodyWithLimit(req, 10);
  req.emit("data", Buffer.from("this is definitely more than ten bytes"));
  await assert.rejects(promise, notion.PayloadTooLargeError);
  // A further chunk arriving after rejection (the stream draining
  // naturally, since it's no longer destroyed) must be silently
  // ignored, not somehow reopen or double-settle the promise.
  assert.doesNotThrow(() => req.emit("data", Buffer.from("more bytes after rejection")));
  assert.doesNotThrow(() => req.emit("end"));
});

test("readBodyWithLimit rejects with BodyReadError on a stream error, exactly once", async () => {
  const req = fakeReq();
  const promise = notion.readBodyWithLimit(req, 1000);
  req.emit("error", new Error("connection reset"));
  // A late 'end' after an error must not also settle the promise again.
  req.emit("end");
  await assert.rejects(promise, notion.BodyReadError);
});

test("readBodyWithLimit rejects (doesn't hang forever) when the client aborts mid-upload, before end (diff-review round 4 P2)", async () => {
  const req = fakeReq();
  const promise = notion.readBodyWithLimit(req, 1000);
  req.emit("data", Buffer.from("partial body, then the client vanishes"));
  req.emit("aborted");
  await assert.rejects(promise, notion.BodyReadError);
});

test("readBodyWithLimit rejects (doesn't hang forever) when the connection closes before end (diff-review round 4 P2)", async () => {
  const req = fakeReq();
  const promise = notion.readBodyWithLimit(req, 1000);
  req.emit("data", Buffer.from("partial body"));
  req.emit("close");
  await assert.rejects(promise, notion.BodyReadError);
});

test("readBodyWithLimit's normal completion is unaffected by a 'close' firing after 'end' (no double-settle, no spurious rejection)", async () => {
  const req = fakeReq();
  const promise = notion.readBodyWithLimit(req, 1000);
  req.emit("data", Buffer.from('{"text":"hi"}'));
  req.emit("end");
  req.emit("close"); // fires after 'end' in Node's real stream lifecycle
  const body = await promise;
  assert.equal(body, '{"text":"hi"}');
});

// ---------------------------------------------------------------------
// expectedOrigin / isSameOrigin — the round-13 self-caught bug's own
// regression test: VERCEL_URL is a bare host, Origin is scheme-qualified
// ---------------------------------------------------------------------

test("expectedOrigin normalizes a bare VERCEL_URL host into a full origin", () => {
  const prevAllowed = process.env.ALLOWED_ORIGIN;
  const prevVercel = process.env.VERCEL_URL;
  delete process.env.ALLOWED_ORIGIN;
  process.env.VERCEL_URL = "my-app-abc123.vercel.app";
  try {
    assert.equal(notion.expectedOrigin(), "https://my-app-abc123.vercel.app");
  } finally {
    if (prevAllowed !== undefined) process.env.ALLOWED_ORIGIN = prevAllowed;
    else delete process.env.ALLOWED_ORIGIN;
    if (prevVercel !== undefined) process.env.VERCEL_URL = prevVercel;
    else delete process.env.VERCEL_URL;
  }
});

test("isSameOrigin: a real scheme-qualified Origin header matches a bare-host VERCEL_URL (round 13 regression)", () => {
  const prevAllowed = process.env.ALLOWED_ORIGIN;
  const prevVercel = process.env.VERCEL_URL;
  delete process.env.ALLOWED_ORIGIN;
  process.env.VERCEL_URL = "my-app.vercel.app";
  try {
    const req = { headers: { origin: "https://my-app.vercel.app" } };
    assert.equal(notion.isSameOrigin(req), true);
  } finally {
    if (prevAllowed !== undefined) process.env.ALLOWED_ORIGIN = prevAllowed;
    else delete process.env.ALLOWED_ORIGIN;
    if (prevVercel !== undefined) process.env.VERCEL_URL = prevVercel;
    else delete process.env.VERCEL_URL;
  }
});

test("isSameOrigin fails closed on absent Origin header", () => {
  process.env.ALLOWED_ORIGIN = "https://example.com";
  const req = { headers: {} };
  assert.equal(notion.isSameOrigin(req), false);
  delete process.env.ALLOWED_ORIGIN;
});

test("isSameOrigin fails closed on malformed Origin header", () => {
  process.env.ALLOWED_ORIGIN = "https://example.com";
  const req = { headers: { origin: "not-a-url" } };
  assert.equal(notion.isSameOrigin(req), false);
  delete process.env.ALLOWED_ORIGIN;
});

test("isSameOrigin rejects a mismatched (attacker) origin", () => {
  process.env.ALLOWED_ORIGIN = "https://example.com";
  const req = { headers: { origin: "https://evil.example.net" } };
  assert.equal(notion.isSameOrigin(req), false);
  delete process.env.ALLOWED_ORIGIN;
});

test("isSameOrigin logs a distinct configuration error (not just a bare rejection) when the trusted origin can't be determined (diff-review round 2 P2)", () => {
  const prevAllowed = process.env.ALLOWED_ORIGIN;
  const prevVercel = process.env.VERCEL_URL;
  // A malformed configured value (not just "unset") hits the exact same
  // catch branch as neither var being set at all — both reach
  // expectedOrigin()'s own `new URL(raw)` throw.
  process.env.ALLOWED_ORIGIN = "not a valid url";
  delete process.env.VERCEL_URL;
  const origError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    const req = { headers: { origin: "https://example.com" } };
    assert.equal(notion.isSameOrigin(req), false); // behavior unchanged: still fails closed
    assert.ok(
      calls.some((args) => String(args[0]).includes("isSameOrigin")),
      "expected a distinct isSameOrigin() configuration-error log line"
    );
  } finally {
    console.error = origError;
    if (prevAllowed === undefined) delete process.env.ALLOWED_ORIGIN;
    else process.env.ALLOWED_ORIGIN = prevAllowed;
    if (prevVercel === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = prevVercel;
  }
});

// ---------------------------------------------------------------------
// isValidPageId
// ---------------------------------------------------------------------

test("isValidPageId accepts hyphenated and non-hyphenated UUIDs", () => {
  assert.equal(notion.isValidPageId("abcdef12-3456-7890-abcd-ef1234567890"), true);
  assert.equal(notion.isValidPageId("abcdef1234567890abcdef1234567890"), true);
});

test("isValidPageId rejects garbage", () => {
  assert.equal(notion.isValidPageId("not-an-id"), false);
  assert.equal(notion.isValidPageId(""), false);
  assert.equal(notion.isValidPageId(null), false);
});

// ---------------------------------------------------------------------
// isValidQueryResponseShape (diff-review round 5 P1)
// ---------------------------------------------------------------------

test("isValidQueryResponseShape accepts a genuine empty result set", () => {
  assert.equal(notion.isValidQueryResponseShape({ results: [], has_more: false }), true);
});

test("isValidQueryResponseShape accepts a genuine non-empty page with has_more:false", () => {
  assert.equal(
    notion.isValidQueryResponseShape({ results: [{ id: "a" }], has_more: false }),
    true
  );
});

test("isValidQueryResponseShape accepts has_more:true with a real next_cursor", () => {
  assert.equal(
    notion.isValidQueryResponseShape({ results: [{ id: "a" }], has_more: true, next_cursor: "abc123" }),
    true
  );
});

test("isValidQueryResponseShape rejects a null/undefined response", () => {
  assert.equal(notion.isValidQueryResponseShape(null), false);
  assert.equal(notion.isValidQueryResponseShape(undefined), false);
});

test("isValidQueryResponseShape rejects a missing results field", () => {
  assert.equal(notion.isValidQueryResponseShape({}), false);
});

test("isValidQueryResponseShape rejects a non-array results field", () => {
  assert.equal(notion.isValidQueryResponseShape({ results: null }), false);
  assert.equal(notion.isValidQueryResponseShape({ results: "oops" }), false);
  assert.equal(notion.isValidQueryResponseShape({ results: {} }), false);
});

test("isValidQueryResponseShape rejects has_more:true with a missing/empty next_cursor", () => {
  assert.equal(notion.isValidQueryResponseShape({ results: [], has_more: true }), false);
  assert.equal(
    notion.isValidQueryResponseShape({ results: [], has_more: true, next_cursor: "" }),
    false
  );
  assert.equal(
    notion.isValidQueryResponseShape({ results: [], has_more: true, next_cursor: null }),
    false
  );
});

test("isValidQueryResponseShape rejects a non-boolean has_more, even if falsy (diff-review round 7 P1)", () => {
  assert.equal(notion.isValidQueryResponseShape({ results: [], has_more: "false" }), false);
  assert.equal(notion.isValidQueryResponseShape({ results: [], has_more: 0 }), false);
  assert.equal(notion.isValidQueryResponseShape({ results: [] }), false); // has_more absent entirely
});
