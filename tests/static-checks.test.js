// tests/static-checks.test.js — Mode 2 (deterministic static check)
// coverage per the Claude Code Handoff's own Step 4 requirement.
//
// The handoff explicitly named "prove it via Mode 1 (automated red/
// green test), Mode 2 (deterministic static check), or Mode 3
// (documented non-testable rationale)" for core correctness paths.
// The XSS finding from diff-review round 2 (all prompt-derived text
// must render via textContent/DOM node creation, never innerHTML) was
// verified manually by grep/code-tracing at every round since, per the
// comments already in index.html itself -- but that verification was
// never codified as a standing, automated guard against a FUTURE
// accidental reintroduction. This file closes that gap: a real,
// permanent Mode 2 static check, not a one-time manual pass.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const INDEX_HTML_PATH = path.join(__dirname, "..", "index.html");

test("index.html never uses innerHTML (Mode 2 static check, diff-review round 2 XSS finding)", () => {
  const content = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  // Matches only real property-access syntax (.innerHTML), not the bare
  // word "innerHTML" -- which appears legitimately several times in this
  // file's OWN explanatory comments ("never innerHTML", documenting this
  // exact fix). A bare-word check would false-fail on the clean file
  // (self-caught while first writing this test, verified via direct
  // execution before trusting it -- see the LL doc's closeout entry).
  assert.ok(
    !/\.innerHTML\b/.test(content),
    "index.html must render all prompt-derived text via textContent/DOM " +
      "node creation only -- innerHTML with untrusted content was a real " +
      "XSS finding (diff-review round 2) and must never be reintroduced"
  );
});

test("index.html never uses insertAdjacentHTML (same XSS risk class as innerHTML)", () => {
  const content = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  assert.ok(
    !/\.insertAdjacentHTML\b/.test(content),
    "insertAdjacentHTML carries the exact same untrusted-HTML-injection " +
      "risk as innerHTML and must never be used for prompt-derived content"
  );
});

test("index.html uses textContent for rendering prompt-derived data (positive control -- proves the check above isn't vacuous)", () => {
  const content = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  const matches = content.match(/\.textContent\s*=/g) || [];
  // A dozen-plus real assignments exist (library rows, active panel,
  // copy status, create button). A low count here would suggest the
  // app stopped using textContent entirely -- itself a red flag worth
  // this positive control catching, not just the negative innerHTML
  // check above (which would pass vacuously on an app using neither).
  assert.ok(
    matches.length >= 5,
    `expected multiple .textContent assignments in index.html, found ${matches.length}`
  );
});
