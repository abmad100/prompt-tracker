// tests/api-copy.test.js — Mode 2 coverage for
// api/prompts/[id]/copy.js. Mocks global fetch.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
  };
  return res;
}

function fakeReq({ method, headers = {}, query = {} }) {
  return { method, headers, query };
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    process.env[k] = vars[k];
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(vars)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  })();
}

function realPage({
  promptText = "hello world",
  count = 3,
  dbId = "db-1234-hyphen",
  id = "abcdef12-3456-7890-abcd-ef1234567890",
  lastUsedIso = null,
} = {}) {
  const normalized = promptText.trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
  return {
    id,
    parent: { type: "database_id", database_id: dbId },
    properties: {
      "Prompt Text": { title: [{ type: "text", text: { content: promptText } }] },
      "Normalized Text": { rich_text: [{ type: "text", text: { content: normalized } }] },
      "Normalized Hash": { rich_text: [{ type: "text", text: { content: hash } }] },
      Count: { number: count },
      Created: { date: { start: "2026-08-14T09:00:00.000Z" } },
      // See tests/api-prompts.test.js's realDatabasePage — a real
      // Notion date property always carries the "date" key, even when
      // unset. Required now that isValidPromptRecordShape enforces its
      // presence (diff-review round 1 P1 finding).
      "Last Used": { date: lastUsedIso ? { start: lastUsedIso } : null },
    },
  };
}

const ENV = {
  NOTION_API_KEY: "test-key",
  NOTION_DATABASE_ID: "db-1234-hyphen",
  ALLOWED_ORIGIN: "https://example.vercel.app",
};

const VALID_ID = "abcdef12-3456-7890-abcd-ef1234567890";

function loadHandler() {
  delete require.cache[require.resolve("../api/prompts/[id]/copy.js")];
  return require("../api/prompts/[id]/copy.js");
}

test("rejects non-POST with 405 and Allow header, before any Notion call", async () => {
  await withEnv(ENV, async () => {
    const handler = loadHandler();
    const req = fakeReq({ method: "GET", query: { id: VALID_ID } });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.Allow, "POST");
  });
});

test("rejects a cross-origin request (CSRF)", async () => {
  await withEnv(ENV, async () => {
    const handler = loadHandler();
    const req = fakeReq({
      method: "POST",
      headers: { origin: "https://evil.example.net" },
      query: { id: VALID_ID },
    });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
  });
});

test("rejects an invalid id shape", async () => {
  await withEnv(ENV, async () => {
    const handler = loadHandler();
    const req = fakeReq({
      method: "POST",
      headers: { origin: "https://example.vercel.app" },
      query: { id: "not-a-real-id" },
    });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  });
});

test("rejects when the page belongs to a different database", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => realPage({ dbId: "some-other-database-id" }),
    });
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 404);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects a record that fails shape/consistency validation", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const page = realPage({});
    page.properties["Normalized Text"].rich_text[0].text.content = "tampered";
    global.fetch = async () => ({ ok: true, status: 200, json: async () => page });
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 404);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects a malformed Count", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const page = realPage({});
    page.properties.Count.number = -5;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => page });
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 404); // shape check catches it first (Count invalid -> parseCount check downstream also would, but shape check already fails since parseCount is used in isValidPromptRecordShape too)
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects at the MAX_SAFE_INTEGER boundary before incrementing", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const page = realPage({ count: Number.MAX_SAFE_INTEGER });
    let patchCalled = false;
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        patchCalled = true;
        throw new Error("must not PATCH at the safe-integer boundary");
      }
      return { ok: true, status: 200, json: async () => page };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 409);
      assert.equal(patchCalled, false);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("read-then-increment-then-write: PATCH payload sets Count+1 and Last Used, response includes new count", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const page = realPage({ count: 4 });
    let patchBody = null;
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        patchBody = JSON.parse(opts.body);
        // Realistic PATCH response: the properties the request actually
        // asked to change (Count, Last Used) genuinely reflect the new
        // values — matching what a real successful Notion update
        // returns. copy.js now verifies and reports FROM this response
        // (diff-review round 2 P2 finding), not from local computation.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...page,
            properties: {
              ...page.properties,
              Count: { number: 5 },
              "Last Used": { date: { start: patchBody.properties["Last Used"].date.start } },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => page };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.count, 5);
      assert.ok(res.body.lastUsed);
      assert.equal(patchBody.properties.Count.number, 5);
      assert.ok(patchBody.properties["Last Used"].date.start);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("a transport-level failure on the GET (fetch throws, not just a bad status) degrades to a clean 404, never crashes (diff-review round 1 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 404);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("a transport-level failure on the PATCH degrades to a clean 502, never crashes (diff-review round 1 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const page = realPage({});
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        throw new Error("socket hang up");
      }
      return { ok: true, status: 200, json: async () => page };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("every response carries Cache-Control: no-store, set before the method check (diff-review round 1 P1)", async () => {
  await withEnv(ENV, async () => {
    const handler = loadHandler();
    const req = fakeReq({ method: "GET", query: { id: VALID_ID } });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405); // GET is rejected...
    assert.equal(res.headers["Cache-Control"], "no-store"); // ...but the header is still set
  });
});

test("rejects (502) a PATCH response for a DIFFERENT page id, even if otherwise shape-valid (diff-review round 3 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const page = realPage({ count: 4 });
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        // Echo back the request's OWN exact count/timestamp on a
        // DIFFERENT page id — so this test genuinely isolates the id
        // check: every other check (shape, exact count, exact
        // timestamp) would pass if the id check didn't exist (self-
        // caught during round-3 mutation testing: an earlier version
        // of this fixture used a hardcoded, non-matching Last Used, so
        // it accidentally passed via the exact-timestamp check
        // instead of the id check it was meant to prove).
        const sentBody = JSON.parse(opts.body);
        const other = realPage({ id: "11111111-2222-3333-4444-555555555555" });
        other.properties.Count = { number: sentBody.properties.Count.number };
        other.properties["Last Used"] = {
          date: { start: sentBody.properties["Last Used"].date.start },
        };
        return { ok: true, status: 200, json: async () => other };
      }
      return { ok: true, status: 200, json: async () => page };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (502) a PATCH response from a DIFFERENT database (diff-review round 3 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const page = realPage({ count: 4 });
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        // Echo back the request's OWN exact count/timestamp on the
        // right page id but a DIFFERENT database — isolates the
        // database-membership check specifically (self-caught during
        // round-3 mutation testing: a hardcoded, non-matching Last
        // Used here would let this test pass via the exact-timestamp
        // check instead of the database check it's meant to prove).
        const sentBody = JSON.parse(opts.body);
        const other = realPage({ id: VALID_ID, dbId: "some-other-database-id" });
        other.properties.Count = { number: sentBody.properties.Count.number };
        other.properties["Last Used"] = {
          date: { start: sentBody.properties["Last Used"].date.start },
        };
        return { ok: true, status: 200, json: async () => other };
      }
      return { ok: true, status: 200, json: async () => page };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (502) a PATCH response whose count doesn't equal currentCount+1 exactly (diff-review round 3 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const page = realPage({ count: 4 });
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        // Shape-valid, right page/database, right Last Used shape —
        // but the count is 6, not the expected 5 (e.g. a concurrent
        // write already landed a different value).
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...page,
            properties: { ...page.properties, Count: { number: 6 }, "Last Used": { date: { start: "2026-08-14T10:00:00.000Z" } } },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => page };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (502) a PATCH response whose Last Used doesn't exactly match the timestamp this request sent (diff-review round 3 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const page = realPage({ count: 4 });
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        // Right id/database/count — but a stale/different Last Used
        // than the timestamp this specific request generated.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...page,
            properties: { ...page.properties, Count: { number: 5 }, "Last Used": { date: { start: "2020-01-01T00:00:00.000Z" } } },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => page };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("a Notion GET 404 (page truly doesn't exist) surfaces as a clean 404", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ message: "not found" }) });
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 404);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (502) a PATCH response that fails shape validation instead of trusting locally-computed values (diff-review round 2 P2)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const page = realPage({ count: 4 });
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        // Transport-level success, but the returned page is malformed
        // (missing required properties) — must not be trusted.
        return { ok: true, status: 200, json: async () => ({ id: page.id, properties: {} }) };
      }
      return { ok: true, status: 200, json: async () => page };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (502) a shape-valid PATCH response whose Last Used is still null (update didn't actually land) (diff-review round 2 P2)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const page = realPage({ count: 4 });
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        // Shape-valid, but Last Used is still null — the update the
        // request asked for didn't actually land in what Notion
        // returned, despite a 200.
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...page, properties: { ...page.properties, Count: { number: 5 } } }),
        };
      }
      return { ok: true, status: 200, json: async () => page };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});
