// tests/api-prompts.test.js — Mode 2 (deterministic mocked-integration)
// coverage for api/prompts.js. Mocks global fetch — no live Notion
// credentials needed or used.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
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

function fakeReq({ method, headers = {}, chunks = [] } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req._chunks = chunks;
  req.destroy = () => {
    req._destroyed = true;
  };
  return req;
}

function emitBody(req, str) {
  process.nextTick(() => {
    if (str) req.emit("data", Buffer.from(str));
    req.emit("end");
  });
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

function realDatabasePage(promptText, count, id) {
  const normalized = promptText.trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
  return {
    id: id || "abcdef12-3456-7890-abcd-ef1234567890",
    properties: {
      "Prompt Text": { title: [{ type: "text", text: { content: promptText } }] },
      "Normalized Text": { rich_text: [{ type: "text", text: { content: normalized } }] },
      "Normalized Hash": { rich_text: [{ type: "text", text: { content: hash } }] },
      Count: { number: count },
      Created: { date: { start: "2026-08-14T09:00:00.000Z" } },
      // A real Notion date property always carries the "date" key, even
      // when unset (its value is null) — matches lib/notion.js's
      // isValidPromptRecordShape, which now requires this property to
      // exist (diff-review round 1 P1 finding).
      "Last Used": { date: null },
    },
  };
}

const ENV = {
  NOTION_API_KEY: "test-key",
  NOTION_DATABASE_ID: "db-1234",
  ALLOWED_ORIGIN: "https://example.vercel.app",
};

test("GET returns paginated, mapped prompts sorted by count", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      assert.ok(url.includes("/databases/db-1234/query"));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            realDatabasePage("low", 1, "11111111-1111-1111-1111-111111111111"),
            realDatabasePage("high", 9, "22222222-2222-2222-2222-222222222222"),
          ],
          has_more: false,
        }),
      };
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({ method: "GET", headers: {} });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.prompts.length, 2);
      assert.equal(res.body.prompts[0].promptText, "high"); // sorted desc
      assert.equal(res.body.skippedCount, 0);
      assert.equal(res.body.truncated, false);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("GET folds malformed records into skippedCount, doesn't crash", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { id: "bad-1", properties: {} }, // deliberately malformed id AND properties
          realDatabasePage("ok", 2, "33333333-3333-3333-3333-333333333333"),
        ],
        has_more: false,
      }),
    });
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({ method: "GET", headers: {} });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.prompts.length, 1);
      assert.equal(res.body.skippedCount, 1);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("GET marks truncated when the page cap is hit with more remaining", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            realDatabasePage(
              `p${calls}`,
              calls,
              `44444444-4444-4444-4444-${String(calls).padStart(12, "0")}`
            ),
          ],
          has_more: true,
          next_cursor: `cursor-${calls}`,
        }),
      };
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({ method: "GET", headers: {} });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.truncated, true);
      assert.equal(calls, 50); // hit MAX_PAGES
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("GET rejects (502) a malformed query response (non-array results) instead of crashing on a non-iterable for...of (diff-review round 5 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: {} }), // truthy, non-array, non-iterable
    });
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({ method: "GET", headers: {} });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("GET rejects (502) has_more:true with no usable next_cursor instead of silently re-fetching page one forever (diff-review round 5 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [], has_more: true }), // no next_cursor at all
      };
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({ method: "GET", headers: {} });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
      // Must fail on the FIRST malformed response, not loop up to
      // MAX_PAGES re-requesting the same (cursor-less) page 1.
      assert.equal(calls, 1);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("POST falls through to create with duplicateCheckIncomplete when the lookup response has a malformed (non-array) results field (diff-review round 5 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes("/query")) {
        return { ok: true, status: 200, json: async () => ({ results: null }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => realDatabasePage("my new prompt", 0, "55555555-5555-5555-5555-555555555555"),
      };
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      });
      const res = fakeRes();
      const p = handler(req, res);
      emitBody(req, JSON.stringify({ text: "my new prompt" }));
      await p;
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.created, true);
      assert.equal(res.body.duplicateCheckIncomplete, true);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("POST rejects wrong Content-Type without reading the body", async () => {
  await withEnv(ENV, async () => {
    delete require.cache[require.resolve("../api/prompts.js")];
    const handler = require("../api/prompts.js");
    const req = fakeReq({ method: "POST", headers: { "content-type": "text/plain" } });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 415);
  });
});

test("POST accepts application/json with charset parameter", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes("/query")) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => realDatabasePage("brand new prompt", 0, "66666666-6666-6666-6666-666666666666"),
      };
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          origin: "https://example.vercel.app",
        },
      });
      const res = fakeRes();
      const p = handler(req, res);
      emitBody(req, JSON.stringify({ text: "brand new prompt" }));
      await p;
      assert.equal(res.statusCode, 201);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("POST rejects a cross-origin request (CSRF)", async () => {
  await withEnv(ENV, async () => {
    delete require.cache[require.resolve("../api/prompts.js")];
    const handler = require("../api/prompts.js");
    const req = fakeReq({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.net" },
    });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
  });
});

test("POST rejects a body over the 100KB limit with 413, via streaming enforcement, WITHOUT destroying the request (diff-review round 3 P1)", async () => {
  await withEnv(ENV, async () => {
    delete require.cache[require.resolve("../api/prompts.js")];
    const handler = require("../api/prompts.js");
    const req = fakeReq({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
    });
    const res = fakeRes();
    const p = handler(req, res);
    process.nextTick(() => {
      req.emit("data", Buffer.alloc(200 * 1024, "x")); // 200KB, over the 100KB cap
    });
    await p;
    assert.equal(res.statusCode, 413);
    // req.destroy() tears down the underlying connection this same
    // 413 is meant to be sent back over — must never be called.
    assert.equal(req._destroyed, undefined);
  });
});

test("POST rejects blank text", async () => {
  await withEnv(ENV, async () => {
    delete require.cache[require.resolve("../api/prompts.js")];
    const handler = require("../api/prompts.js");
    const req = fakeReq({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
    });
    const res = fakeRes();
    const p = handler(req, res);
    emitBody(req, JSON.stringify({ text: "   " }));
    await p;
    assert.equal(res.statusCode, 400);
  });
});

test("POST rejects text over 20,000 code points before any chunking/hashing", async () => {
  await withEnv(ENV, async () => {
    delete require.cache[require.resolve("../api/prompts.js")];
    const handler = require("../api/prompts.js");
    const req = fakeReq({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
    });
    const res = fakeRes();
    const p = handler(req, res);
    emitBody(req, JSON.stringify({ text: "a".repeat(20001) }));
    await p;
    assert.equal(res.statusCode, 400);
  });
});

test("POST returns the existing page (created:false) on a verified duplicate", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const existing = realDatabasePage("existing prompt", 5, "77777777-7777-7777-7777-777777777777");
    global.fetch = async (url) => {
      if (url.includes("/query")) {
        return { ok: true, status: 200, json: async () => ({ results: [existing] }) };
      }
      throw new Error("should not attempt to create when a duplicate is found");
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      });
      const res = fakeRes();
      const p = handler(req, res);
      emitBody(req, JSON.stringify({ text: "Existing Prompt" }));
      await p;
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.created, false);
      assert.equal(res.body.prompt.id, "77777777-7777-7777-7777-777777777777");
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("POST sets duplicateCheckIncomplete when candidates existed but none verified", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    // A candidate sharing the hash by coincidence/corruption, but whose
    // actual normalized text differs.
    const unrelated = realDatabasePage("totally unrelated text", 1, "88888888-8888-8888-8888-888888888888");
    global.fetch = async (url) => {
      if (url.includes("/query")) {
        return { ok: true, status: 200, json: async () => ({ results: [unrelated] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => realDatabasePage("my new prompt", 0, "55555555-5555-5555-5555-555555555555"),
      };
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      });
      const res = fakeRes();
      const p = handler(req, res);
      emitBody(req, JSON.stringify({ text: "my new prompt" }));
      await p;
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.created, true);
      assert.equal(res.body.duplicateCheckIncomplete, true);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("POST sets duplicateCheckIncomplete when the duplicate-lookup query itself fails (diff-review round 1 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes("/query")) {
        // The lookup call itself fails (non-2xx) — this must be treated
        // the same as "couldn't verify uniqueness," not silently ignored.
        return { ok: false, status: 500, json: async () => ({ message: "internal error" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => realDatabasePage("my new prompt", 0, "55555555-5555-5555-5555-555555555555"),
      };
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      });
      const res = fakeRes();
      const p = handler(req, res);
      emitBody(req, JSON.stringify({ text: "my new prompt" }));
      await p;
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.created, true);
      assert.equal(res.body.duplicateCheckIncomplete, true);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("a transport-level failure (fetch throws, not just a bad status) degrades to a clean 502, never crashes (diff-review round 1 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.notion.com");
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({ method: "GET", headers: {} });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("POST rejects a create response that fails shape validation instead of trusting it (diff-review round 1 P2)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes("/query")) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      // The create call "succeeds" transport-wise but the returned page
      // is missing required properties — must not be trusted as-is.
      return { ok: true, status: 200, json: async () => ({ id: "55555555-5555-5555-5555-555555555555", properties: {} }) };
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      });
      const res = fakeRes();
      const p = handler(req, res);
      emitBody(req, JSON.stringify({ text: "a brand new prompt" }));
      await p;
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("POST skips a shape-invalid duplicate candidate instead of trusting it, and still sets duplicateCheckIncomplete (diff-review round 4 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    // A candidate sharing the hash whose OWN Normalized Text would
    // match the request, but whose record is internally inconsistent
    // (Count is malformed) — must be skipped, not trusted as a
    // genuine duplicate, and must still be treated as an unverified
    // candidate.
    const malformedCandidate = realDatabasePage("my new prompt", 0, "99999999-9999-9999-9999-999999999999");
    malformedCandidate.properties.Count.number = -1;
    global.fetch = async (url) => {
      if (url.includes("/query")) {
        return { ok: true, status: 200, json: async () => ({ results: [malformedCandidate] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => realDatabasePage("my new prompt", 0, "55555555-5555-5555-5555-555555555555"),
      };
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      });
      const res = fakeRes();
      const p = handler(req, res);
      emitBody(req, JSON.stringify({ text: "my new prompt" }));
      await p;
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.created, true);
      assert.equal(res.body.prompt.id, "55555555-5555-5555-5555-555555555555"); // created fresh, NOT the malformed candidate
      assert.equal(res.body.duplicateCheckIncomplete, true);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("POST rejects a create response that's internally consistent but represents different content than submitted (diff-review round 2 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes("/query")) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      // The create call "succeeds" and the returned page is internally
      // shape-consistent (its own hash matches its own normalized
      // text) — but it's for TOTALLY DIFFERENT content than what this
      // request actually submitted. Must be rejected, not trusted.
      return {
        ok: true,
        status: 200,
        json: async () => realDatabasePage("some other prompt entirely", 0, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
      };
    };
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      });
      const res = fakeRes();
      const p = handler(req, res);
      emitBody(req, JSON.stringify({ text: "a brand new prompt" }));
      await p;
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("GET and POST responses carry Cache-Control: no-store (diff-review round 1 P1)", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
    try {
      delete require.cache[require.resolve("../api/prompts.js")];
      const handler = require("../api/prompts.js");
      const getReq = fakeReq({ method: "GET", headers: {} });
      const getRes = fakeRes();
      await handler(getReq, getRes);
      assert.equal(getRes.headers["Cache-Control"], "no-store");

      const errReq = fakeReq({ method: "DELETE", headers: {} });
      const errRes = fakeRes();
      await handler(errReq, errRes);
      assert.equal(errRes.headers["Cache-Control"], "no-store");
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("unsupported method returns 405 with Allow header", async () => {
  await withEnv(ENV, async () => {
    delete require.cache[require.resolve("../api/prompts.js")];
    const handler = require("../api/prompts.js");
    const req = fakeReq({ method: "DELETE", headers: {} });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.Allow, "GET, POST");
  });
});

test("missing env vars returns a clean 500 with no secret in the body", async () => {
  delete require.cache[require.resolve("../api/prompts.js")];
  const prevKey = process.env.NOTION_API_KEY;
  const prevDb = process.env.NOTION_DATABASE_ID;
  delete process.env.NOTION_API_KEY;
  delete process.env.NOTION_DATABASE_ID;
  try {
    const handler = require("../api/prompts.js");
    const req = fakeReq({ method: "GET", headers: {} });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 500);
    assert.ok(!JSON.stringify(res.body).includes("test-key"));
  } finally {
    if (prevKey !== undefined) process.env.NOTION_API_KEY = prevKey;
    if (prevDb !== undefined) process.env.NOTION_DATABASE_ID = prevDb;
  }
});
