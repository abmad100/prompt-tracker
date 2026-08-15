// api/prompts/[id]/edit.js — Prompt Tracker
//
// POST /api/prompts/:id/edit {text} — updates the target prompt's own
// Prompt Text / Normalized Text / Normalized Hash to reflect an edited
// (improved/corrected) version of the same prompt, WITHOUT touching
// Count, Last Used, or Created. Vercel's filesystem-based routing maps
// this file to that exact path with `id` available via req.query.id.
//
// Deliberately does NOT check for a duplicate-hash collision against
// OTHER records. api/prompts.js's own create path already treats
// duplicate detection as a best-effort, non-atomic reduction (see
// README.md's "Known limitations") -- a racing create can already
// produce two records sharing the same hash today, and editing into an
// accidental collision with an existing record is the same risk shape,
// not a new one. Building cross-record merge/redirect behavior for
// that is real, separate scope beyond what this feature was asked for.

const {
  NOTION_API_VERSION,
  MAX_PROMPT_LEN,
  MAX_BODY_BYTES,
  PayloadTooLargeError,
  BodyReadError,
  isSameOrigin,
  readBodyWithLimit,
  isValidPageId,
  buildEditUpdatePayload,
  isValidPromptRecordShape,
  parseNotionPage,
} = require("../../../lib/notion.js");

const config = { api: { bodyParser: false } };

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

// Same shape/reasoning as copy.js's own belongsToConfiguredDatabase --
// a page in the wrong database is rejected identically whether it's
// the initial GET target or the PATCH response.
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

// Same transport-failure-safety wrapper as copy.js's own notionFetch --
// a network-level failure throws inside fetch() itself, not as a
// rejected/non-2xx response.
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
  // No caching of prompt-content responses at any layer, set
  // unconditionally before any early return -- matches every other
  // route in this app.
  res.setHeader("Cache-Control", "no-store");

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

  // Content-Type check FIRST, before reading any body bytes at all --
  // matches api/prompts.js's create path (strictly cheaper/faster-
  // failing than reading first).
  const contentType = (req.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    res.status(415).json({ error: "Content-Type must be application/json." });
    return;
  }

  // CSRF check before consuming any body.
  if (!isSameOrigin(req)) {
    res.status(403).json({ error: "Request origin not allowed." });
    return;
  }

  const id = req.query && req.query.id;
  if (!isValidPageId(id)) {
    res.status(400).json({ error: "Invalid prompt id." });
    return;
  }

  let raw;
  try {
    raw = await readBodyWithLimit(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof PayloadTooLargeError) {
      res.status(413).json({ error: "Request body too large." });
      return;
    }
    if (e instanceof BodyReadError) {
      res.status(400).json({ error: "Failed to read request body." });
      return;
    }
    console.error("Unexpected body-read error", e);
    res.status(500).json({ error: "Internal error." });
    return;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    res.status(400).json({ error: "Request body is not valid JSON." });
    return;
  }

  if (!body || typeof body.text !== "string") {
    res.status(400).json({ error: "A string 'text' field is required." });
    return;
  }

  const text = body.text;
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    res.status(400).json({ error: "text is required." });
    return;
  }
  // Aggregate length check, strictly before any chunking -- same limit
  // and same Unicode-code-point counting as the create path (MAX_PROMPT_LEN
  // now lives in lib/notion.js specifically so both paths share it).
  if (Array.from(text).length > MAX_PROMPT_LEN) {
    res.status(400).json({ error: `text too long (max ${MAX_PROMPT_LEN} characters).` });
    return;
  }

  // Fetch the target page FIRST -- confirms it genuinely exists,
  // belongs to THIS app's own configured database, and has a valid
  // record shape, before ever PATCHing arbitrary caller-supplied text
  // into a Notion page id that came straight from req.query.id (an
  // attacker-controlled value). Skipping this would let the endpoint
  // write into any Notion page id the integration's own credentials
  // happen to reach, without confirming it's actually one of this
  // app's own prompt records -- the identical reasoning copy.js already
  // applies to its own GET-before-PATCH sequence.
  const getResult = await notionFetch(`https://api.notion.com/v1/pages/${id}`, {
    method: "GET",
    headers: notionHeaders(),
  });
  const page = getResult.json;

  if (getResult.status === 404) {
    res.status(404).json({ error: "Prompt not found." });
    return;
  }
  if (!getResult.ok || !page) {
    console.error(
      "Notion page retrieval (edit) failed",
      getResult.status,
      getResult.json && getResult.json.message
    );
    res.status(502).json({ error: "Failed to reach the prompt database." });
    return;
  }
  if (!belongsToConfiguredDatabase(page)) {
    res.status(404).json({ error: "Prompt not found." });
    return;
  }
  if (!isValidPromptRecordShape(page)) {
    res.status(404).json({ error: "Prompt not found." });
    return;
  }

  // Snapshot the fields this edit is explicitly forbidden from
  // changing, straight from the pre-edit record -- this is what the
  // post-PATCH response gets checked against below. Capturing it here
  // (rather than assuming "the payload doesn't mention them, so
  // they're safe") is defense in depth: it verifies what actually
  // happened, not just what was asked for.
  const before = parseNotionPage(page);

  const editPayload = buildEditUpdatePayload(text);
  const patchResult = await notionFetch(`https://api.notion.com/v1/pages/${id}`, {
    method: "PATCH",
    headers: notionHeaders(),
    body: JSON.stringify(editPayload),
  });

  if (!patchResult.ok || !patchResult.json) {
    console.error(
      "Notion page update (edit) failed",
      patchResult.status,
      patchResult.json && patchResult.json.message
    );
    res.status(502).json({ error: "Failed to save the edited prompt." });
    return;
  }

  const patchedPage = patchResult.json;
  if (
    !patchedPage ||
    normalizeDbId(patchedPage.id) !== normalizeDbId(id) ||
    !belongsToConfiguredDatabase(patchedPage) ||
    !isValidPromptRecordShape(patchedPage)
  ) {
    console.error(
      "Notion page update (edit) returned an unexpected or invalid record",
      patchedPage && patchedPage.id
    );
    res.status(502).json({ error: "Failed to confirm the prompt edit." });
    return;
  }

  const after = parseNotionPage(patchedPage);

  // The response must reflect THIS request's own submitted text, not
  // some other (also internally-consistent) content -- same reasoning
  // as api/prompts.js's own create-path response-identity check.
  const submittedNormalizedText = trimmed.toLowerCase();
  if (after.normalizedText !== submittedNormalizedText) {
    console.error(
      "Notion page update (edit) returned a record for different content than submitted",
      patchedPage.id
    );
    res.status(502).json({ error: "Failed to confirm the prompt edit." });
    return;
  }

  // THE core requirement this whole endpoint exists to guarantee:
  // Count/Last Used/Created must be byte-identical to what they were
  // BEFORE this edit. buildEditUpdatePayload() already omits these
  // three properties from the PATCH body entirely -- Notion's own
  // partial-update semantics mean that alone should already leave them
  // untouched. This check verifies that actually held, rather than
  // just trusting the omission -- catching a genuine Notion-side
  // anomaly or an unexpected concurrent write in between the GET and
  // the PATCH, instead of silently reporting success either way. No
  // date-precision reconciliation is needed here (unlike copy.js's own
  // Last Used comparison): Last Used/Created were never re-written by
  // this request, so Notion has no reason to re-derive or re-format
  // them -- a plain string comparison against the pre-edit snapshot is
  // the correct check, not a semantic-instant one.
  if (
    after.count !== before.count ||
    after.lastUsed !== before.lastUsed ||
    after.created !== before.created
  ) {
    console.error(
      "Notion page update (edit) altered Count/Last Used/Created -- refusing to report success",
      patchedPage.id
    );
    res.status(502).json({
      error:
        "The edit may not have been applied safely (usage count or timestamps " +
        "changed unexpectedly) -- check the library, or the Notion database " +
        "directly, before retrying.",
    });
    return;
  }

  res.status(200).json({ prompt: after });
};

module.exports.config = config;
