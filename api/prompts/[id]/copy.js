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
  isValidPageId,
  buildCopyUpdatePayload,
  isValidPromptRecordShape,
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

  if (!getResult.ok || !page) {
    res.status(404).json({ error: "Prompt not found." });
    return;
  }

  // Database-ownership check: the page must genuinely belong to this
  // app's own configured database, not just be some other page the
  // integration happens to be able to reach.
  const pageDbId =
    page.parent && page.parent.type === "database_id"
      ? page.parent.database_id
      : null;
  if (
    !pageDbId ||
    normalizeDbId(pageDbId) !== normalizeDbId(process.env.NOTION_DATABASE_ID)
  ) {
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

  res.status(200).json({ count: currentCount + 1, lastUsed: ts });
};
