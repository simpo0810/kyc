const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { makeMemoryDb } = require("../src/memoryDb");
const { createApp } = require("../src/app");

const SECRET = "test_webhook_secret";
const STATUS_KEY = "a-sufficiently-long-status-key";

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

function signedHeaders(body) {
  return {
    "content-type": "application/json",
    "X-Signature-V2": crypto.createHmac("sha256", SECRET).update(canonicalize(body)).digest("hex"),
    "X-Timestamp": String(Math.floor(Date.now() / 1000)),
  };
}

let server;
let baseUrl;
let db;
let diditCalls;
let notifications;
let diditFail = false;
let sessionCounter = 0;

const quietLogger = { info() {}, warn() {}, error() {} };

before(async () => {
  db = makeMemoryDb();

  const didit = {
    async createSession({ vendorData }) {
      if (diditFail) throw new Error("simulated Didit outage");
      sessionCounter += 1;
      const sessionId = `sess-${sessionCounter}`;
      diditCalls.push({ vendorData, session_id: sessionId });
      return { session_id: sessionId, url: `https://verify.didit.me/session/${sessionId}` };
    },
  };

  const notifier = {
    enabled: true,
    async notify(text) {
      notifications.push(text);
    },
  };

  const config = {
    baseUrl: "https://example.test",
    diditWebhookSecret: SECRET,
    statusKey: STATUS_KEY,
    sessionRateLimit: 1000,
  };

  const app = createApp({ config, db, didit, notifier, logger: quietLogger });
  server = app.listen(0);
  await new Promise((resolve) => server.on("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  diditCalls = [];
  notifications = [];
  diditFail = false;
});

function postForm(path, fields) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

test("GET / serves the intake form", async () => {
  const res = await fetch(baseUrl + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Binance order number/);
});

test("GET /healthz responds ok", async () => {
  const res = await fetch(baseUrl + "/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /sessions creates a tagged session and redirects to Didit", async () => {
  const res = await postForm("/sessions", { orderRef: "ORDER-1001", buyerContact: "tg:@buyer" });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /^https:\/\/verify\.didit\.me\/session\//);
  assert.equal(diditCalls.length, 1);
  assert.equal(diditCalls[0].vendorData, "order:ORDER-1001|contact:tg:@buyer");

  const record = await db.findOpenByOrderRef("ORDER-1001");
  assert.equal(record.status, "Not Started");
  assert.equal(record.buyer_contact, "tg:@buyer");
});

test("POST /sessions reuses an open session for the same order (no double spend)", async () => {
  const first = await postForm("/sessions", { orderRef: "ORDER-2002" });
  const firstUrl = first.headers.get("location");

  const second = await postForm("/sessions", { orderRef: "ORDER-2002" });
  assert.equal(second.status, 303);
  assert.equal(second.headers.get("location"), firstUrl);
  assert.equal(diditCalls.length, 1, "second submit must not create a second Didit session");
});

test("POST /sessions rejects invalid order refs", async () => {
  for (const bad of ["", "ab", "has spaces", "x".repeat(65), "<script>"]) {
    const res = await postForm("/sessions", { orderRef: bad });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
  assert.equal(diditCalls.length, 0);
});

test("POST /sessions returns 502 with a friendly page when Didit is down", async () => {
  diditFail = true;
  const res = await postForm("/sessions", { orderRef: "ORDER-3003" });
  assert.equal(res.status, 502);
  assert.match(await res.text(), /try again shortly/);
});

test("webhook with a valid signature updates status and notifies", async () => {
  await postForm("/sessions", { orderRef: "ORDER-4004" });
  const { session_id } = diditCalls[0];

  const body = {
    session_id,
    status: "Approved",
    vendor_data: "order:ORDER-4004",
    created_at: Math.floor(Date.now() / 1000),
  };
  const res = await fetch(baseUrl + "/webhooks/didit", {
    method: "POST",
    headers: signedHeaders(body),
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);

  assert.equal((await db.getBySessionId(session_id)).status, "Approved");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /ORDER-4004/);
  assert.match(notifications[0], /Approved/);
});

test("webhook with a bad signature is rejected and changes nothing", async () => {
  await postForm("/sessions", { orderRef: "ORDER-5005" });
  const { session_id } = diditCalls[0];

  const body = { session_id, status: "Approved", created_at: Math.floor(Date.now() / 1000) };
  const res = await fetch(baseUrl + "/webhooks/didit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Signature-V2": "0".repeat(64),
      "X-Timestamp": String(Math.floor(Date.now() / 1000)),
    },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 401);
  assert.equal((await db.getBySessionId(session_id)).status, "Not Started");
  assert.equal(notifications.length, 0);
});

test("out-of-order webhook events cannot regress a final status", async () => {
  await postForm("/sessions", { orderRef: "ORDER-6006" });
  const { session_id } = diditCalls[0];
  const now = Math.floor(Date.now() / 1000);

  const approved = { session_id, status: "Approved", created_at: now };
  await fetch(baseUrl + "/webhooks/didit", {
    method: "POST",
    headers: signedHeaders(approved),
    body: JSON.stringify(approved),
  });

  // A delayed retry of an older "In Progress" event arrives afterwards.
  const stale = { session_id, status: "In Progress", created_at: now - 60 };
  const res = await fetch(baseUrl + "/webhooks/didit", {
    method: "POST",
    headers: signedHeaders(stale),
    body: JSON.stringify(stale),
  });
  assert.equal(res.status, 200, "stale events still get 200 so Didit stops retrying");
  assert.equal((await db.getBySessionId(session_id)).status, "Approved");
});

test("intermediate statuses update the record but do not notify", async () => {
  await postForm("/sessions", { orderRef: "ORDER-7007" });
  const { session_id } = diditCalls[0];

  const body = { session_id, status: "In Progress", created_at: Math.floor(Date.now() / 1000) };
  await fetch(baseUrl + "/webhooks/didit", {
    method: "POST",
    headers: signedHeaders(body),
    body: JSON.stringify(body),
  });

  assert.equal((await db.getBySessionId(session_id)).status, "In Progress");
  assert.equal(notifications.length, 0);
});

test("GET /status requires the exact key", async () => {
  assert.equal((await fetch(baseUrl + "/status")).status, 403);
  assert.equal((await fetch(baseUrl + "/status?key=wrong")).status, 403);

  const ok = await fetch(baseUrl + `/status?key=${STATUS_KEY}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Verification status/);
});

test("GET /status escapes stored values", async () => {
  await db.createVerification({
    orderRef: "ORDER-XSS",
    buyerContact: '<img src=x onerror=alert(1)>',
    sessionId: "sess-xss",
    sessionUrl: "https://verify.didit.me/session/sess-xss",
  });
  const res = await fetch(baseUrl + `/status?key=${STATUS_KEY}`);
  const html = await res.text();
  assert.ok(!html.includes("<img src=x"), "raw HTML must not appear in the status page");
  assert.match(html, /&lt;img src=x/);
});

test("unknown routes return 404", async () => {
  assert.equal((await fetch(baseUrl + "/nope")).status, 404);
});
