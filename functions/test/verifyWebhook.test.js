const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyWebhookSignature } = require("../src/verifyWebhook");

const SECRET = "test_secret";

// Mirrors Didit's documented canonicalization: keys sorted recursively,
// compact separators, unicode preserved.
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

function sign(body, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(canonicalize(body)).digest("hex");
}

function nowTs() {
  return String(Math.floor(Date.now() / 1000));
}

test("accepts a correctly signed, fresh payload", () => {
  const body = { session_id: "abc", status: "Approved", vendor_data: "order:1" };
  assert.equal(verifyWebhookSignature(body, sign(body), nowTs(), SECRET), true);
});

test("sorts keys recursively before signing", () => {
  const body = { z: 1, a: { d: 4, c: 3 }, m: [{ y: 2, x: 1 }] };
  assert.equal(verifyWebhookSignature(body, sign(body), nowTs(), SECRET), true);
});

test("whole-valued floats collapse to integers (1.0 -> 1)", () => {
  // JSON.parse already collapses 1.0 to 1, matching Didit's rule; verify the
  // round-trip signature matches what a Python sender with sort_keys produces.
  const body = JSON.parse('{"amount": 1.0, "session_id": "abc"}');
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update('{"amount":1,"session_id":"abc"}')
    .digest("hex");
  assert.equal(verifyWebhookSignature(body, expected, nowTs(), SECRET), true);
});

test("unicode is preserved unescaped", () => {
  const body = { name: "José Müller", session_id: "abc" };
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update('{"name":"José Müller","session_id":"abc"}')
    .digest("hex");
  assert.equal(verifyWebhookSignature(body, expected, nowTs(), SECRET), true);
});

test("rejects a tampered body", () => {
  const body = { session_id: "abc", status: "Approved" };
  const sig = sign(body);
  assert.equal(verifyWebhookSignature({ ...body, status: "Declined" }, sig, nowTs(), SECRET), false);
});

test("rejects the wrong secret", () => {
  const body = { session_id: "abc", status: "Approved" };
  assert.equal(verifyWebhookSignature(body, sign(body, "other"), nowTs(), SECRET), false);
});

test("rejects a stale timestamp (> 300s skew)", () => {
  const body = { session_id: "abc", status: "Approved" };
  const stale = String(Math.floor(Date.now() / 1000) - 301);
  assert.equal(verifyWebhookSignature(body, sign(body), stale, SECRET), false);
});

test("rejects missing signature or timestamp headers", () => {
  const body = { session_id: "abc" };
  assert.equal(verifyWebhookSignature(body, undefined, nowTs(), SECRET), false);
  assert.equal(verifyWebhookSignature(body, sign(body), undefined, SECRET), false);
});

test("rejects a non-numeric timestamp", () => {
  const body = { session_id: "abc" };
  assert.equal(verifyWebhookSignature(body, sign(body), "not-a-number", SECRET), false);
});
