// api/prompts/[id]/copy.js — Prompt Tracker
//
// POST /api/prompts/:id/copy — increments the target prompt's Count and
// sets Last Used to now. Vercel's filesystem-based routing maps this
// file to that exact path with `id` available via req.query.id.

const {
  NOTION_API_VERSION,
  parseCount,
  isSameOrigin,
  nowIso,
  sameMinute,
  isValidPageId,
  buildCopyUpdatePayload,
  isValidPromptRecordShape,
  parseNotionPage,
} = require("../../../lib/notion.js");

function notionHeaders() {
  return {
    Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json",
  };
}

function envConfigured() {
  return Boolean(process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID);
}

function normalizeDbId(id) {
  return (id || "").replace(/-/g, "").toLowerCase();
}

// Shared by both the GET (fetch the target) and PATCH (confirm the
// update) response checks — a page in the wrong database is rejected
// identically at either point (diff-review round 3 P1 finding: the
// PATCH response wasn't checked against the database at all).
function belongsToConfiguredDatabase(page) {
  const pageDbId =
    page && page.parent && page.parent.type === "database_id"
      ? page.parent.database_id
      : null;
  return Boolean(
    pageDbId &&
      normalizeDbId(pageDbId) === normalizeDbId(process.env.NOTION_DATABASE_ID)
  );
}

// Wraps the fetch call itself (network-level failures throw inside
// fetch(), not as a rejected/non-2xx response — diff-review round 1 P1
// finding, same class as api/prompts.js's notionRequest). Converts any
// transport failure into the same {ok:false, json:null} shape a bad
// HTTP status already produces.
async function notionFetch(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    console.error("Notion request transport failure", url, e.message);
    return { ok: false, status: 0, json: null };
  }
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

module.exports = async function handler(req, res) {
  // No caching of prompt-content responses at any layer (diff-review
  // round 1 P1 finding) — set unconditionally, before any early return,
  // so every response path (success and every error) carries it.
  res.setHeader("Cache-Control", "no-store");

  // Method check FIRST, before any Notion call.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  if (!envConfigured()) {
    console.error("NOTION_API_KEY/NOTION_DATABASE_ID not set");
    res.status(500).json({ error: "Server is not configured." });
    return;
  }

  // CSRF check.
  if (!isSameOrigin(req)) {
    res.status(403).json({ error: "Request origin not allowed." });
    return;
  }

  const id = req.query && req.query.id;
  if (!isValidPageId(id)) {
    res.status(400).json({ error: "Invalid prompt id." });
    return;
  }

  const getResult = await notionFetch(`https://api.notion.com/v1/pages/${id}`, {
    method: "GET",
    headers: notionHeaders(),
  });
  const page = getResult.json;

  // Only a genuine Notion 404 is reported as "not found" — Notion's
  // own API deliberately returns 404 (not 403) both for a truly
  // nonexistent page AND one the integration lacks access to, so this
  // still correctly covers the access-denied case too. Every OTHER
  // failure (transport error, 429, 5xx) previously collapsed into the
  // same bare 404, misrepresenting an outage/rate-limit as "this
  // prompt doesn't exist" (diff-review round 4 P2 finding) — those
  // now map to 502 instead, matching how every other Notion-call
  // failure in this app is already reported.
  if (getResult.status === 404) {
    res.status(404).json({ error: "Prompt not found." });
    return;
  }
  if (!getResult.ok || !page) {
    console.error(
      "Notion page retrieval (copy) failed",
      getResult.status,
      getResult.json && getResult.json.message
    );
    res.status(502).json({ error: "Failed to reach the prompt database." });
    return;
  }

  // Database-ownership check: the page must genuinely belong to this
  // app's own configured database, not just be some other page the
  // integration happens to be able to reach.
  if (!belongsToConfiguredDatabase(page)) {
    res.status(404).json({ error: "Prompt not found." });
    return;
  }

  // Full record-shape/consistency check — not just database membership.
  // A page in the right database but with the wrong shape, or an
  // internally-inconsistent (tampered/corrupted) record, is rejected the
  // same way.
  if (!isValidPromptRecordShape(page)) {
    res.status(404).json({ error: "Prompt not found." });
    return;
  }

  const currentCount = parseCount(page.properties.Count.number);
  if (currentCount === null) {
    res.status(500).json({ error: "Stored count is invalid." });
    return;
  }
  if (currentCount >= Number.MAX_SAFE_INTEGER) {
    res.status(409).json({ error: "Count is at its maximum safe value." });
    return;
  }

  const ts = nowIso();
  const payload = buildCopyUpdatePayload(currentCount, ts);

  const patchResult = await notionFetch(`https://api.notion.com/v1/pages/${id}`, {
    method: "PATCH",
    headers: notionHeaders(),
    body: JSON.stringify(payload),
  });

  if (!patchResult.ok || !patchResult.json) {
    console.error(
      "Notion page update (copy) failed",
      patchResult.status,
      patchResult.json && patchResult.json.message
    );
    res.status(502).json({ error: "Failed to update usage count." });
    return;
  }

  // Verify the PATCH response itself rather than blindly trusting the
  // locally-computed values (diff-review round 2 P2 finding) — report
  // what Notion's own response actually confirms landed, not just what
  // we expected to have written. This doesn't change the app's already-
  // documented, accepted read-modify-write concurrency limitation (a
  // genuinely concurrent second write can still land after this one) —
  // it only ensures a SUCCESSFUL response is never based on an
  // unvalidated, wrong-page, or self-inconsistent PATCH result.
  //
  // Round 2's version of this check only verified general shape and
  // non-null count/lastUsed — not that the response is genuinely THE
  // SAME page (round 3 P1 finding), still in the configured database,
  // or that it reflects EXACTLY the increment/timestamp this request
  // asked for (an unrelated-but-shape-valid response could otherwise
  // have been silently trusted and its own count/timestamp reported as
  // if they were this request's own result).
  const patchedPage = patchResult.json;
  if (
    !patchedPage ||
    // isValidPageId() accepts both hyphenated and non-hyphenated `id`
    // query values, but Notion's own response always uses the
    // hyphenated canonical form — normalize both sides (normalizeDbId
    // just strips hyphens/lowercases, works for any Notion object id,
    // not only database ids) before comparing.
    normalizeDbId(patchedPage.id) !== normalizeDbId(id) ||
    !belongsToConfiguredDatabase(patchedPage) ||
    !isValidPromptRecordShape(patchedPage)
  ) {
    console.error(
      "Notion page update (copy) returned an unexpected or invalid record",
      patchedPage && patchedPage.id
    );
    res.status(502).json({ error: "Failed to confirm the usage count update." });
    return;
  }

  const patched = parseNotionPage(patchedPage);
  // Minute-floored comparison, not exact-instant. Two real production
  // findings, both confirmed live 2026-08-15, layered here: (1)
  // isValidIso8601 (called inside isValidPromptRecordShape, above)
  // deliberately accepts TWO valid notations for the same UTC instant
  // ("Z" and "+00:00") since Notion's PATCH response echoes this app's
  // own "Z"-form write back in "+00:00" form — sameInstant() alone
  // handles that. (2) Notion's "date" property also discards any
  // sub-minute precision on write regardless of notation — confirmed
  // via a live database read showing every real Last Used value ends
  // in exactly ":00.000", never the true seconds/milliseconds this app
  // actually sent. sameInstant()'s exact-millisecond comparison could
  // therefore never pass against a value that's round-tripped through
  // Notion at all, even after fix (1) landed. sameMinute() (see its own
  // comment in lib/notion.js) accounts for both: it floors to the
  // minute before comparing, which is the finest granularity Notion can
  // actually confirm survived the round trip.
  if (patched.count !== currentCount + 1 || !sameMinute(patched.lastUsed, ts)) {
    console.error(
      "Notion page update (copy) response does not match the requested update",
      patchedPage.id
    );
    res.status(502).json({ error: "Failed to confirm the usage count update." });
    return;
  }

  res.status(200).json({ count: patched.count, lastUsed: patched.lastUsed });
};
