// lib/notion.js — Prompt Tracker
//
// Pure request/response-shaping functions for Notion's API, plus a few
// small standalone helpers (streaming body-read, CSRF origin check).
// Deliberately no network I/O of its own — the actual `fetch` calls live
// in the thin api/*.js route handlers, which is what makes this module
// fully testable (Mode 1) without live NOTION_API_KEY/NOTION_DATABASE_ID
// credentials. Every function/constant here traces back to a specific,
// numbered finding from the 16-round /gpt-review plan-convergence loop —
// see the workstream LL doc for the full round-by-round history:
// https://drive.google.com/file/d/1oCtGaFrMtgB_MC6Lc9q4SesuY5EXvXga/view

const crypto = require("node:crypto");

// Notion's original, still-fully-supported stable API version — every
// operation this app needs (database query, page create/retrieve/
// update) is covered by it; no need for the newer multi-data-source-view
// semantics a more recent version would add. Pinned once, here, rather
// than left as an undefined "recent stable version."
const NOTION_API_VERSION = "2022-06-28";

// Notion rich_text/title properties are arrays of objects, each capped
// at 2000 characters. Two distinct correctness risks here, both closed
// by the same design:
//
// 1. A naive index-based `.slice()` can split a UTF-16 surrogate pair
//    (e.g. an emoji) across two chunks, corrupting the reconstructed
//    text and silently breaking the hash round-trip check below
//    (round 9 P1 finding).
// 2. A fixed CODE-POINT count per chunk (the original fix for #1) can
//    still exceed Notion's documented 2000-*character* limit for
//    astral-plane content: an astral code point is 1 array element via
//    `Array.from` but serializes to 2 UTF-16 units, so a chunk of 2000
//    code points that's astral-heavy can be up to 4000 UTF-16 units —
//    Notion's real enforcement unit is not confirmed either way, and
//    this app has no live credentials to test it against (diff-review
//    round 1 P2 finding).
//
// Fixed by accumulating whole code points (never splitting a surrogate
// pair — closes #1) while tracking the cumulative UTF-16 (`.length`)
// size of the chunk being built, closing a chunk once the NEXT code
// point would push it past `maxLen` UTF-16 units (closes #2, safe
// regardless of which unit Notion actually measures by — this only
// ever makes chunks smaller/more conservative, never larger).
function chunkRichText(text, maxLen = 2000) {
  const codePoints = Array.from(text);
  const chunks = [];
  let current = "";
  for (const cp of codePoints) {
    if (current.length + cp.length > maxLen && current.length > 0) {
      chunks.push(current);
      current = "";
    }
    current += cp;
  }
  // Always push the final (possibly empty) chunk — Notion rich_text/
  // title arrays require at least one element, and a genuinely empty
  // string must still produce one (empty) chunk.
  chunks.push(current);
  return chunks;
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// Fails loud on anything but a finite, non-negative, JS-safe integer —
// deliberately never silently coerces a malformed value (round 3 P1: a
// silent reset to 0 would corrupt real usage data, worse than a loud
// failure; round 6 P2: Number.isSafeInteger guard).
function parseCount(raw) {
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    !Number.isSafeInteger(raw) ||
    raw < 0
  ) {
    return null;
  }
  return raw;
}

// Full-response size guard (round 4/5 P1/P2: must measure the complete
// serialized response, not just the records array, to actually protect
// against Vercel's real function response-size limit). 3.5MB threshold
// — comfortably under Vercel's own platform limit, with real margin.
const MAX_RESPONSE_BYTES = 3.5 * 1024 * 1024;

function serializedSizeBytes(fullResponseObj) {
  return Buffer.byteLength(JSON.stringify(fullResponseObj), "utf8");
}

// Streaming request-body reader with a genuine byte-limit enforced
// DURING reading (round 9 P1: a Content-Length header check alone is
// spoofable/absent-bypassable; round 10 P1: must guarantee a single-
// response state and properly destroy the stream on breach, not just
// discard further bytes). Rejects with a distinct marker error so the
// caller can map it to a clean 413, never falling through to a second
// response.
const MAX_BODY_BYTES = 100 * 1024; // 100KB — generous over any real
// single-prompt JSON payload (20,000 code points of text plus envelope
// overhead is nowhere close to this), comfortably below Vercel's own
// platform-level body limit.

class PayloadTooLargeError extends Error {}
class BodyReadError extends Error {}

function readBodyWithLimit(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let settled = false;

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Stop consuming further bytes immediately — don't just discard
        // them, actually destroy the connection.
        req.destroy();
        settle(reject, new PayloadTooLargeError("request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      settle(resolve, Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (err) => {
      settle(reject, new BodyReadError(err.message));
    });
  });
}

// CSRF: derive the single trusted origin ONCE, from configuration —
// never from an incoming request header (round 11 P1: deriving trust
// from a request-controlled value defeats the point). `ALLOWED_ORIGIN`,
// if set, must already be a full absolute origin (e.g.
// "https://my-app.example.com"); otherwise falls back to
// `https://${VERCEL_URL}` (VERCEL_URL is a bare host per Vercel's own
// docs — round 13 P1 self-caught bug: comparing a bare host directly
// against a browser's always-scheme-qualified Origin header would never
// match, breaking every legitimate request, not just blocking
// attackers). Both sides are normalized through the URL constructor and
// compared via their `.origin` property, never raw string equality.
function expectedOrigin() {
  const raw =
    process.env.ALLOWED_ORIGIN ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (!raw) {
    throw new Error(
      "expectedOrigin(): neither ALLOWED_ORIGIN nor VERCEL_URL is set — cannot determine the trusted origin"
    );
  }
  try {
    return new URL(raw).origin;
  } catch (e) {
    throw new Error(
      `expectedOrigin(): configured origin value "${raw}" is not a valid absolute URL`
    );
  }
}

// Fails closed: absent, malformed, or mismatched Origin all reject. No
// Referer fallback — a legitimate same-origin fetch() POST always sends
// Origin per the Fetch spec, so there's no case this app's own frontend
// needs a weaker fallback for.
function isSameOrigin(req) {
  const originHeader = req.headers.origin;
  if (!originHeader || typeof originHeader !== "string") return false;
  let actual;
  try {
    actual = new URL(originHeader).origin;
  } catch (e) {
    return false;
  }
  let expected;
  try {
    expected = expectedOrigin();
  } catch (e) {
    return false;
  }
  return actual === expected;
}

// Exact canonical form only — the precise output shape of
// `new Date().toISOString()` (YYYY-MM-DDTHH:mm:ss.sssZ). This app's own
// code never writes any other date form, so anything else (a date-only
// value, an offset form, a rollover-corrupted value like "2026-02-30")
// correctly fails validation as non-canonical — same disposition as any
// other malformed/foreign record (round 12/13 findings: "ISO 8601" alone
// is underspecified against Notion's broader format flexibility; a loose
// `Date.parse` can silently accept an invalid calendar value via
// rollover). Round-trip validated: parse, then reconstruct, then compare.
const ISO_8601_STRICT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isValidIso8601(str) {
  if (typeof str !== "string" || !ISO_8601_STRICT_RE.test(str)) return false;
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return false;
  // Round-trip: catches a rollover like "2026-02-30T00:00:00.000Z"
  // (JS silently normalizes this to March), which would otherwise pass
  // the regex + a bare Date.parse.
  return d.toISOString() === str;
}

function nowIso() {
  return new Date().toISOString();
}

function isValidPageId(id) {
  // Notion page IDs are UUIDs, with or without hyphens.
  return (
    typeof id === "string" &&
    /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(
      id
    )
  );
}

function textPropertyValue(text) {
  return chunkRichText(text).map((chunk) => ({
    type: "text",
    text: { content: chunk },
  }));
}

function buildListQuery(startCursor) {
  const body = {
    page_size: 100,
    sorts: [{ property: "Count", direction: "descending" }],
  };
  if (startCursor) body.start_cursor = startCursor;
  return body;
}

function buildCreatePayload(text) {
  const normalizedText = text.trim().toLowerCase();
  const hash = sha256Hex(normalizedText);
  const ts = nowIso();
  return {
    properties: {
      "Prompt Text": { title: textPropertyValue(text) },
      "Normalized Text": { rich_text: textPropertyValue(normalizedText) },
      "Normalized Hash": {
        rich_text: [{ type: "text", text: { content: hash } }],
      },
      Count: { number: 0 },
      Created: { date: { start: ts } },
    },
  };
}

// Bounded candidate lookup — page_size 10, first page only (round 9/10
// P2: hash collisions among distinct legitimate content are
// cryptographically near-impossible; 10 is generous headroom for a
// data-corruption edge case). If none of the (at most 10) candidates
// verify, the caller falls through to create-new by design — documented
// as an accepted best-effort limitation, not silently unconsidered.
function buildFindByHashQuery(hash) {
  return {
    page_size: 10,
    filter: {
      property: "Normalized Hash",
      rich_text: { equals: hash },
    },
  };
}

function buildCopyUpdatePayload(currentCount, nowIsoStr) {
  return {
    properties: {
      Count: { number: currentCount + 1 },
      "Last Used": { date: { start: nowIsoStr } },
    },
  };
}

function plainTextFromRichTextArray(arr) {
  if (!Array.isArray(arr)) return "";
  return arr.map((r) => (r && r.text && r.text.content) || "").join("");
}

function parseNotionPage(page) {
  const props = page.properties || {};
  const promptText = plainTextFromRichTextArray(
    props["Prompt Text"] && props["Prompt Text"].title
  );
  const normalizedText = plainTextFromRichTextArray(
    props["Normalized Text"] && props["Normalized Text"].rich_text
  );
  const normalizedHash = plainTextFromRichTextArray(
    props["Normalized Hash"] && props["Normalized Hash"].rich_text
  );
  const count = props.Count && typeof props.Count.number === "number"
    ? props.Count.number
    : null;
  const lastUsed =
    props["Last Used"] && props["Last Used"].date
      ? props["Last Used"].date.start
      : null;
  const created =
    props.Created && props.Created.date ? props.Created.date.start : null;
  return {
    id: page.id,
    promptText,
    normalizedText,
    normalizedHash,
    count,
    lastUsed,
    created,
  };
}

// Real record-integrity check, not just "does the right property exist"
// (round 6 P1: type-only checks let a corrupted/tampered record pass as
// valid; round 7 P1: must recompute normalize+hash from the ACTUAL
// stored Prompt Text and require exact match, not just trust stored
// values). Also validates Created/Last Used are the app's own exact
// canonical date form. The "Last Used" PROPERTY must always be present
// (a missing column is a schema defect, not a legitimate state — see
// below); its VALUE being null is explicitly valid on a record that's
// never been copied (round 9 P2 — Last Used is genuinely unset until
// the first copy-click, per the BUILD SPEC, not a defect).
function isValidPromptRecordShape(page) {
  const props = page.properties;
  if (!props) return false;

  const promptTitleProp = props["Prompt Text"];
  const normTextProp = props["Normalized Text"];
  const hashProp = props["Normalized Hash"];
  const countProp = props.Count;
  const createdProp = props.Created;
  const lastUsedProp = props["Last Used"];

  if (
    !promptTitleProp ||
    !Array.isArray(promptTitleProp.title) ||
    !normTextProp ||
    !Array.isArray(normTextProp.rich_text) ||
    !hashProp ||
    !Array.isArray(hashProp.rich_text) ||
    !countProp ||
    typeof countProp.number !== "number" ||
    !createdProp ||
    !createdProp.date
  ) {
    return false;
  }

  const promptText = plainTextFromRichTextArray(promptTitleProp.title);
  const storedNormalizedText = plainTextFromRichTextArray(
    normTextProp.rich_text
  );
  const storedHash = plainTextFromRichTextArray(hashProp.rich_text);

  const recomputedNormalizedText = promptText.trim().toLowerCase();
  if (recomputedNormalizedText !== storedNormalizedText) return false;

  const recomputedHash = sha256Hex(recomputedNormalizedText);
  if (recomputedHash !== storedHash) return false;

  if (parseCount(countProp.number) === null) return false;

  if (!isValidIso8601(createdProp.date.start)) return false;

  // Last Used: the PROPERTY itself must exist in the schema (a real
  // Notion date-property response always carries a `date` key, even
  // when unset — its value is `null`, not the key being absent). A
  // missing key here means the database is missing the "Last Used"
  // column entirely — a schema misconfiguration, not a legitimately
  // never-copied prompt (diff-review round 1 P1 finding: this used to
  // be silently accepted and only surfaced as a failure later, at the
  // moment of the first copy attempt). `lastUsedProp.date === null` is
  // explicitly VALID — that's the real shape of a genuinely unused
  // record; a present-but-non-date-typed property (no `date` key at
  // all) is rejected the same way a missing property is.
  if (!("Last Used" in props)) return false;
  if (!lastUsedProp || !("date" in lastUsedProp)) return false;
  if (lastUsedProp.date !== null) {
    if (!lastUsedProp.date || !isValidIso8601(lastUsedProp.date.start)) {
      return false;
    }
  }

  return true;
}

module.exports = {
  NOTION_API_VERSION,
  MAX_RESPONSE_BYTES,
  MAX_BODY_BYTES,
  PayloadTooLargeError,
  BodyReadError,
  chunkRichText,
  sha256Hex,
  parseCount,
  serializedSizeBytes,
  readBodyWithLimit,
  expectedOrigin,
  isSameOrigin,
  isValidIso8601,
  nowIso,
  isValidPageId,
  buildListQuery,
  buildCreatePayload,
  buildFindByHashQuery,
  buildCopyUpdatePayload,
  parseNotionPage,
  isValidPromptRecordShape,
};
