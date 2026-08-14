// api/prompts.js — Prompt Tracker
//
// GET  /api/prompts        — list all tracked prompts
// POST /api/prompts {text} — find-or-create a prompt by normalized text
//
// Vercel Serverless Function (Node.js runtime). Opts out of Vercel's
// default body parser so `readBodyWithLimit` can genuinely enforce a
// streaming byte limit (round 9/10 finding: a Content-Length header
// check alone is spoofable/bypassable).

const {
  MAX_RESPONSE_BYTES,
  MAX_BODY_BYTES,
  PayloadTooLargeError,
  BodyReadError,
  parseCount,
  serializedSizeBytes,
  readBodyWithLimit,
  isSameOrigin,
  nowIso,
  isValidPageId,
  buildListQuery,
  buildCreatePayload,
  buildFindByHashQuery,
  parseNotionPage,
  isValidPromptRecordShape,
} = require("../lib/notion.js");
const { sha256Hex } = require("../lib/notion.js");

const config = { api: { bodyParser: false } };

const MAX_PAGES = 50; // safety cap: 50 pages x 100 = 5,000 records
const MAX_PROMPT_LEN = 20000; // Unicode code points, checked BEFORE any
// chunking ever runs — this is the aggregate limit, not a per-chunk one.

function notionHeaders() {
  return {
    Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": require("../lib/notion.js").NOTION_API_VERSION,
    "Content-Type": "application/json",
  };
}

function envConfigured() {
  return Boolean(process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID);
}

// Wraps the fetch call itself, not just JSON parsing — a network-level
// failure (DNS, connection refused, TLS error) throws inside `fetch()`
// itself, not a rejected/non-2xx response, and would otherwise propagate
// as an unhandled exception all the way out of the exported handler
// (diff-review round 1 P1 finding). Converts it into the same
// `{ok: false, json: null}` shape a non-2xx HTTP response already
// produces, so every existing `!ok || !json` call site handles both
// uniformly with no other change needed.
async function notionRequest(path, body) {
  let res;
  try {
    res = await fetch(`https://api.notion.com/v1${path}`, {
      method: "POST",
      headers: notionHeaders(),
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("Notion request transport failure", path, e.message);
    return { ok: false, status: 0, json: null };
  }
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

async function handleGet(req, res) {
  const databaseId = process.env.NOTION_DATABASE_ID;
  let cursor;
  let page = 0;
  let truncated = false;
  const records = [];
  let skippedCount = 0;

  while (page < MAX_PAGES) {
    const query = buildListQuery(cursor);
    const { ok, status, json } = await notionRequest(
      `/databases/${databaseId}/query`,
      query
    );
    if (!ok || !json) {
      console.error("Notion query-database failed", status, json && json.message);
      res.status(502).json({ error: "Failed to reach the prompt database." });
      return;
    }
    for (const rawPage of json.results || []) {
      try {
        if (!isValidPromptRecordShape(rawPage)) {
          skippedCount++;
          continue;
        }
        records.push(parseNotionPage(rawPage));
      } catch (e) {
        skippedCount++;
      }
    }
    page++;
    if (json.has_more) {
      cursor = json.next_cursor;
      if (page >= MAX_PAGES) {
        // Hit the safety cap with more still remaining upstream.
        truncated = true;
      }
    } else {
      break;
    }
  }

  records.sort((a, b) => b.count - a.count);

  const responseBody = { prompts: records, skippedCount, truncated };

  if (serializedSizeBytes(responseBody) > MAX_RESPONSE_BYTES) {
    res.status(503).json({
      error:
        "Library too large to return in one response — contact the operator to raise the internal size limit or reduce the number of stored prompts.",
    });
    return;
  }

  res.status(200).json(responseBody);
}

async function handlePost(req, res) {
  // Content-Type check FIRST, before reading any body bytes at all —
  // strictly cheaper and faster-failing than reading first.
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
  // Aggregate length check — strictly before any chunking is ever
  // attempted. Unicode-code-point-based, matching chunkRichText's own
  // code-point-safe splitting.
  if (Array.from(text).length > MAX_PROMPT_LEN) {
    res.status(400).json({ error: `text too long (max ${MAX_PROMPT_LEN} characters).` });
    return;
  }

  const databaseId = process.env.NOTION_DATABASE_ID;
  const normalizedText = trimmed.toLowerCase();
  const hash = sha256Hex(normalizedText);

  // Best-effort duplicate reduction (documented accepted limitation —
  // not atomic; see README). Query up to 10 hash-matching candidates,
  // verify each against the actual recomputed normalized text before
  // trusting it as a genuine duplicate.
  const findQuery = buildFindByHashQuery(hash);
  const findResult = await notionRequest(
    `/databases/${databaseId}/query`,
    findQuery
  );

  let duplicateCheckIncomplete = false;
  if (findResult.ok && findResult.json) {
    const candidates = findResult.json.results || [];
    for (const candidate of candidates) {
      try {
        const parsed = parseNotionPage(candidate);
        if (parsed.normalizedText === normalizedText) {
          res.status(200).json({ prompt: parsed, created: false });
          return;
        }
      } catch (e) {
        // malformed candidate, skip
      }
    }
    if (candidates.length > 0) {
      // Candidates existed under this hash but none verified — a real,
      // if rare, corruption-adjacent scenario. Signal it rather than
      // silently create.
      duplicateCheckIncomplete = true;
    }
  } else {
    console.error(
      "Notion duplicate-lookup query failed",
      findResult.status,
      findResult.json && findResult.json.message
    );
    // Fall through to create — a failed lookup shouldn't block the user
    // from saving their prompt. But the lookup genuinely didn't
    // complete, so this is exactly the same "couldn't verify uniqueness"
    // situation as the candidates-existed-but-none-verified case above —
    // it must be flagged the same way (diff-review round 1 P1 finding:
    // this branch previously fell through silently, contradicting the
    // README's documented "an incomplete lookup is flagged" contract).
    duplicateCheckIncomplete = true;
  }

  const createPayload = buildCreatePayload(text);
  const createResult = await notionRequest(`/pages`, {
    parent: { database_id: databaseId },
    ...createPayload,
  });

  if (!createResult.ok || !createResult.json) {
    console.error(
      "Notion page create failed",
      createResult.status,
      createResult.json && createResult.json.message
    );
    res.status(502).json({ error: "Failed to save the new prompt." });
    return;
  }

  // Validate the created page's own shape/consistency before trusting
  // it — the same check already applied to every record on read and to
  // the target of a copy. A malformed create response (schema drift,
  // an unconfirmed edge in Notion's own API behavior) must not enter
  // client state as a trusted record (diff-review round 1 P2 finding).
  // Only the page id is logged on failure, never the full response —
  // it embeds the actual prompt text (diff-review round 2 P1 finding:
  // the original version of this check logged createResult.json
  // wholesale, writing prompt content into platform logs).
  if (!isValidPromptRecordShape(createResult.json)) {
    console.error(
      "Notion page create returned a record that failed shape validation",
      createResult.json && createResult.json.id
    );
    res
      .status(502)
      .json({ error: "Failed to save the new prompt (unexpected response)." });
    return;
  }

  const parsed = parseNotionPage(createResult.json);

  // The response isn't just internally self-consistent — it must
  // actually represent what THIS request submitted, not some other
  // (also internally-consistent) page returned in error (diff-review
  // round 2 P1 finding).
  if (parsed.normalizedText !== normalizedText) {
    console.error(
      "Notion page create returned a record for different content than submitted",
      createResult.json && createResult.json.id
    );
    res
      .status(502)
      .json({ error: "Failed to save the new prompt (unexpected response)." });
    return;
  }
  const responseBody = { prompt: parsed, created: true };
  if (duplicateCheckIncomplete) {
    responseBody.duplicateCheckIncomplete = true;
  }
  res.status(201).json(responseBody);
}

module.exports = async function handler(req, res) {
  // No caching of prompt-content responses at any layer (diff-review
  // round 1 P1 finding) — set unconditionally, before any code path,
  // so every response (list, create, and every error) carries it.
  res.setHeader("Cache-Control", "no-store");

  if (!envConfigured()) {
    console.error("NOTION_API_KEY/NOTION_DATABASE_ID not set");
    res.status(500).json({ error: "Server is not configured." });
    return;
  }

  if (req.method === "GET") {
    await handleGet(req, res);
    return;
  }
  if (req.method === "POST") {
    await handlePost(req, res);
    return;
  }
  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "Method not allowed." });
};

module.exports.config = config;
