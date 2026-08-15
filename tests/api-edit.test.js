// tests/api-edit.test.js — Mode 2 (deterministic mocked-integration)
// coverage for api/prompts/[id]/edit.js. Mocks global fetch — no live
// Notion credentials needed or used.

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

// Combines copy.js's own fakeReq shape (query.id) with prompts.js's own
// EventEmitter-based streaming-body shape (readBodyWithLimit reads via
// req.on("data"/"end"/...)) -- api/prompts/[id]/edit.js needs both.
function fakeReq({ method, headers = {}, query = {} }) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.query = query;
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

function realPage({
  promptText = "hello world",
  count = 3,
  dbId = "db-1234-hyphen",
  id = "abcdef12-3456-7890-abcd-ef1234567890",
  lastUsedIso = null,
  createdIso = "2026-08-14T09:00:00.000Z",
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
      Created: { date: { start: createdIso } },
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
  delete require.cache[require.resolve("../api/prompts/[id]/edit.js")];
  return require("../api/prompts/[id]/edit.js");
}

// Builds a realistic PATCH response: echoes back the submitted new text
// (recomputing Normalized Text/Hash from it, matching what a real
// successful Notion update returns) while preserving Count/Last Used/
// Created from the pre-edit page, unless overridden by `overrides` --
// used both for the happy-path test and, with an override, for each of
// the "response changed something it must not" safety tests.
function patchedPageEchoingNewText(preEditPage, newText, overrides = {}) {
  const normalized = newText.trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
  return {
    ...preEditPage,
    properties: {
      ...preEditPage.properties,
      "Prompt Text": { title: [{ type: "text", text: { content: newText } }] },
      "Normalized Text": { rich_text: [{ type: "text", text: { content: normalized } }] },
      "Normalized Hash": { rich_text: [{ type: "text", text: { content: hash } }] },
      ...overrides,
    },
  };
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

test("every response carries Cache-Control: no-store, set before the method check", async () => {
  await withEnv(ENV, async () => {
    const handler = loadHandler();
    const req = fakeReq({ method: "GET", query: { id: VALID_ID } });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers["Cache-Control"], "no-store");
  });
});

test("rejects a wrong Content-Type without reading the body", async () => {
  await withEnv(ENV, async () => {
    const handler = loadHandler();
    const req = fakeReq({
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://example.vercel.app" },
      query: { id: VALID_ID },
    });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 415);
  });
});

test("rejects a cross-origin request (CSRF), before reading the body", async () => {
  await withEnv(ENV, async () => {
    const handler = loadHandler();
    const req = fakeReq({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.net" },
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
      headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      query: { id: "not-a-real-id" },
    });
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  });
});

test("rejects malformed JSON in the body", async () => {
  await withEnv(ENV, async () => {
    const handler = loadHandler();
    const req = fakeReq({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      query: { id: VALID_ID },
    });
    const res = fakeRes();
    const promise = handler(req, res);
    emitBody(req, "{not valid json");
    await promise;
    assert.equal(res.statusCode, 400);
  });
});

test("rejects a missing/non-string text field", async () => {
  await withEnv(ENV, async () => {
    const handler = loadHandler();
    const req = fakeReq({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      query: { id: VALID_ID },
    });
    const res = fakeRes();
    const promise = handler(req, res);
    emitBody(req, JSON.stringify({ text: 42 }));
    await promise;
    assert.equal(res.statusCode, 400);
  });
});

test("rejects whitespace-only text, before any Notion call", async () => {
  await withEnv(ENV, async () => {
    const handler = loadHandler();
    const req = fakeReq({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      query: { id: VALID_ID },
    });
    const res = fakeRes();
    const promise = handler(req, res);
    emitBody(req, JSON.stringify({ text: "   " }));
    await promise;
    assert.equal(res.statusCode, 400);
  });
});

test("rejects text over MAX_PROMPT_LEN, before any Notion call", async () => {
  await withEnv(ENV, async () => {
    const handler = loadHandler();
    const req = fakeReq({
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
      query: { id: VALID_ID },
    });
    const res = fakeRes();
    const promise = handler(req, res);
    emitBody(req, JSON.stringify({ text: "a".repeat(20001) }));
    await promise;
    assert.equal(res.statusCode, 400);
  });
});

test("a Notion GET 404 (page truly doesn't exist) surfaces as a clean 404, no PATCH ever attempted", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    let patchCalled = false;
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        patchCalled = true;
        throw new Error("must not PATCH after a 404 on the pre-edit GET");
      }
      return { ok: false, status: 404, json: async () => ({ message: "not found" }) };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 404);
      assert.equal(patchCalled, false);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("a non-404 upstream GET failure degrades to a clean 502, distinct from a genuine 404", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ message: "rate limited" }) });
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (404) when the pre-edit GET target belongs to a different database, before any PATCH", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    let patchCalled = false;
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        patchCalled = true;
        throw new Error("must not PATCH a page from the wrong database");
      }
      return { ok: true, status: 200, json: async () => realPage({ dbId: "some-other-database-id" }) };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 404);
      assert.equal(patchCalled, false);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (404) when the pre-edit GET target fails shape validation, before any PATCH", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    let patchCalled = false;
    const page = realPage({});
    page.properties["Normalized Text"].rich_text[0].text.content = "tampered";
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        patchCalled = true;
        throw new Error("must not PATCH a shape-invalid page");
      }
      return { ok: true, status: 200, json: async () => page };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 404);
      assert.equal(patchCalled, false);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("happy path: PATCH payload has no Count/Last Used/Created keys, and the response reports the new text with Count/Last Used/Created intact", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const preEdit = realPage({ promptText: "original prompt", count: 7, lastUsedIso: "2026-08-14T10:00:00.000Z" });
    let patchBody = null;
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        patchBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => patchedPageEchoingNewText(preEdit, "improved prompt"),
        };
      }
      return { ok: true, status: 200, json: async () => preEdit };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "improved prompt" }));
      await promise;

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.prompt.promptText, "improved prompt");
      assert.equal(res.body.prompt.normalizedText, "improved prompt");
      assert.equal(res.body.prompt.count, 7); // unchanged
      assert.equal(res.body.prompt.lastUsed, "2026-08-14T10:00:00.000Z"); // unchanged
      assert.equal(res.body.prompt.created, "2026-08-14T09:00:00.000Z"); // unchanged

      // THE mechanism, not just the outcome: prove the actual PATCH
      // request sent to Notion never mentioned Count/Last Used/Created
      // at all.
      assert.equal("Count" in patchBody.properties, false);
      assert.equal("Last Used" in patchBody.properties, false);
      assert.equal("Created" in patchBody.properties, false);
      assert.ok(patchBody.properties["Prompt Text"]);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("a transport-level failure on the PATCH degrades to a clean 502, never crashes", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const preEdit = realPage({});
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        throw new Error("socket hang up");
      }
      return { ok: true, status: 200, json: async () => preEdit };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (502) a PATCH response for a DIFFERENT page id", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const preEdit = realPage({});
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        const other = patchedPageEchoingNewText(preEdit, "an improved version");
        other.id = "11111111-2222-3333-4444-555555555555";
        return { ok: true, status: 200, json: async () => other };
      }
      return { ok: true, status: 200, json: async () => preEdit };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (502) a PATCH response from a DIFFERENT database", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const preEdit = realPage({});
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        const other = patchedPageEchoingNewText(preEdit, "an improved version");
        other.parent = { type: "database_id", database_id: "some-other-database-id" };
        return { ok: true, status: 200, json: async () => other };
      }
      return { ok: true, status: 200, json: async () => preEdit };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (502) a shape-invalid PATCH response instead of trusting locally-computed values", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const preEdit = realPage({});
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        return { ok: true, status: 200, json: async () => ({ id: preEdit.id, properties: {} }) };
      }
      return { ok: true, status: 200, json: async () => preEdit };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (502) a PATCH response whose content doesn't reflect the submitted text", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const preEdit = realPage({});
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        // Shape-valid, right id/database -- but echoes back completely
        // different content than what was submitted.
        return { ok: true, status: 200, json: async () => patchedPageEchoingNewText(preEdit, "totally unrelated content") };
      }
      return { ok: true, status: 200, json: async () => preEdit };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

// The three safety tests below are THE core requirement this whole
// endpoint exists to guarantee -- each proves a PATCH response that
// otherwise looks completely valid (right id, right database, right
// shape, correctly reflects the submitted new text) is still REJECTED
// if Count, Last Used, or Created differs even slightly from the
// pre-edit snapshot, rather than being trusted just because everything
// else checks out.

test("rejects (502) a PATCH response reporting a CHANGED Count, even though everything else is valid", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const preEdit = realPage({ count: 7 });
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        return {
          ok: true,
          status: 200,
          json: async () =>
            patchedPageEchoingNewText(preEdit, "an improved version", { Count: { number: 8 } }),
        };
      }
      return { ok: true, status: 200, json: async () => preEdit };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (502) a PATCH response reporting a CHANGED Last Used, even though everything else is valid", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const preEdit = realPage({ lastUsedIso: "2026-08-14T10:00:00.000Z" });
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        return {
          ok: true,
          status: 200,
          json: async () =>
            patchedPageEchoingNewText(preEdit, "an improved version", {
              "Last Used": { date: { start: "2026-08-15T00:00:00.000Z" } },
            }),
        };
      }
      return { ok: true, status: 200, json: async () => preEdit };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("rejects (502) a PATCH response reporting a CHANGED Created, even though everything else is valid", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const preEdit = realPage({ createdIso: "2026-08-14T09:00:00.000Z" });
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        return {
          ok: true,
          status: 200,
          json: async () =>
            patchedPageEchoingNewText(preEdit, "an improved version", {
              Created: { date: { start: "2026-08-15T00:00:00.000Z" } },
            }),
        };
      }
      return { ok: true, status: 200, json: async () => preEdit };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.vercel.app" },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 502);
    } finally {
      global.fetch = origFetch;
    }
  });
});

test("accepts application/json with a charset parameter", async () => {
  await withEnv(ENV, async () => {
    const origFetch = global.fetch;
    const preEdit = realPage({});
    global.fetch = async (url, opts) => {
      if (opts && opts.method === "PATCH") {
        return { ok: true, status: 200, json: async () => patchedPageEchoingNewText(preEdit, "an improved version") };
      }
      return { ok: true, status: 200, json: async () => preEdit };
    };
    try {
      const handler = loadHandler();
      const req = fakeReq({
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          origin: "https://example.vercel.app",
        },
        query: { id: VALID_ID },
      });
      const res = fakeRes();
      const promise = handler(req, res);
      emitBody(req, JSON.stringify({ text: "an improved version" }));
      await promise;
      assert.equal(res.statusCode, 200);
    } finally {
      global.fetch = origFetch;
    }
  });
});
