const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { makeMemoryDb } = require("../src/memoryDb");
const { createApp } = require("../src/app");

const SECRET = "test_webhook_secret";
const STATUS_KEY = "a-sufficiently-long-status-key";

const NO_FLAGS = { q_coached: "no", q_third_party: "no", q_promised_profit: "no" };

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

test("GET / serves the intake form with handle field and three questions", async () => {
  const res = await fetch(baseUrl + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Binance P2P username/);
  assert.match(html, /q_coached/);
  assert.match(html, /q_third_party/);
  assert.match(html, /q_promised_profit/);
});

test("CSP allows form submissions to redirect to Didit", async () => {
  const res = await fetch(baseUrl + "/");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /form-action 'self' https:\/\/verify\.didit\.me/);
});

test("root on the status.* domain redirects to /status, preserving the key", async () => {
  const res = await fetch(baseUrl + "/?key=abc", {
    headers: { "X-Forwarded-Host": "status.example.com" },
    redirect: "manual",
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/status?key=abc");

  const plain = await fetch(baseUrl + "/", {
    headers: { "X-Forwarded-Host": "status.example.com" },
    redirect: "manual",
  });
  assert.equal(plain.headers.get("location"), "/status");
});

test("GET /health responds ok", async () => {
  const res = await fetch(baseUrl + "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("POST /sessions creates a tagged session and redirects to Didit", async () => {
  const res = await postForm("/sessions", { handle: "buyer_one", ...NO_FLAGS });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /^https:\/\/verify\.didit\.me\/session\//);
  assert.equal(diditCalls.length, 1);
  assert.equal(diditCalls[0].vendorData, "handle:buyer_one");

  const record = await db.findOpenByHandle("buyer_one");
  assert.equal(record.status, "Not Started");
  assert.equal(record.flagged, false);
});

test("POST /sessions reuses an open session for the same buyer (no double spend)", async () => {
  const first = await postForm("/sessions", { handle: "buyer_two", ...NO_FLAGS });
  const firstUrl = first.headers.get("location");

  const second = await postForm("/sessions", { handle: "buyer_two", ...NO_FLAGS });
  assert.equal(second.status, 303);
  assert.equal(second.headers.get("location"), firstUrl);
  assert.equal(diditCalls.length, 1, "second submit must not create a second Didit session");
});

test("POST /sessions rejects invalid handles", async () => {
  for (const bad of ["", "ab", "has spaces", "x".repeat(31), "<script>"]) {
    const res = await postForm("/sessions", { handle: bad, ...NO_FLAGS });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
  assert.equal(diditCalls.length, 0);
});

test("POST /sessions requires all three questions answered", async () => {
  const missing = await postForm("/sessions", { handle: "buyer_three" });
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /answer all three questions/);

  const partial = await postForm("/sessions", { handle: "buyer_three", q_coached: "no" });
  assert.equal(partial.status, 400);

  const tampered = await postForm("/sessions", {
    handle: "buyer_three",
    q_coached: "maybe",
    q_third_party: "no",
    q_promised_profit: "no",
  });
  assert.equal(tampered.status, 400, "answers other than yes/no are rejected");
  assert.equal(diditCalls.length, 0);
});

test("a yes answer stores screening flags but does not block the buyer", async () => {
  const res = await postForm("/sessions", {
    handle: "coached_buyer",
    q_coached: "yes",
    q_third_party: "no",
    q_promised_profit: "yes",
  });
  assert.equal(res.status, 303, "flagged buyers still proceed to verification");

  const record = await db.findOpenByHandle("coached_buyer");
  assert.equal(record.flagged, true);
  assert.deepEqual(record.flags, { coached: true, third_party: false, promised_profit: true });
});

test("resubmitting with different answers cannot clear an existing flag", async () => {
  await postForm("/sessions", {
    handle: "flip_flopper",
    q_coached: "yes",
    q_third_party: "no",
    q_promised_profit: "no",
  });

  // Same buyer retries, now answering no to everything.
  await postForm("/sessions", { handle: "flip_flopper", ...NO_FLAGS });

  const record = await db.findOpenByHandle("flip_flopper");
  assert.equal(record.flagged, true, "flag must survive a clean resubmission");
  assert.equal(record.flags.coached, true);
  assert.equal(diditCalls.length, 1, "still only one paid session");
});

test("POST /sessions returns 502 with a friendly page when Didit is down", async () => {
  diditFail = true;
  const res = await postForm("/sessions", { handle: "buyer_four", ...NO_FLAGS });
  assert.equal(res.status, 502);
  assert.match(await res.text(), /try again shortly/);
});

test("webhook with a valid signature updates status and notifies", async () => {
  await postForm("/sessions", { handle: "buyer_five", ...NO_FLAGS });
  const { session_id } = diditCalls[0];

  const body = {
    session_id,
    status: "Approved",
    vendor_data: "handle:buyer_five",
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
  assert.match(notifications[0], /buyer_five/);
  assert.match(notifications[0], /Approved/);
  assert.ok(!notifications[0].includes("Screening flags"), "clean buyers have no flag line");
});

test("notification for a flagged buyer includes the screening flags", async () => {
  await postForm("/sessions", {
    handle: "flagged_buyer",
    q_coached: "no",
    q_third_party: "yes",
    q_promised_profit: "no",
  });
  const { session_id } = diditCalls[0];

  const body = { session_id, status: "Approved", created_at: Math.floor(Date.now() / 1000) };
  await fetch(baseUrl + "/webhooks/didit", {
    method: "POST",
    headers: signedHeaders(body),
    body: JSON.stringify(body),
  });

  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /⚠ Screening flags: buying for someone else/);
});

test("webhook with a bad signature is rejected and changes nothing", async () => {
  await postForm("/sessions", { handle: "buyer_six", ...NO_FLAGS });
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
  await postForm("/sessions", { handle: "buyer_seven", ...NO_FLAGS });
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
  await postForm("/sessions", { handle: "buyer_eight", ...NO_FLAGS });
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

test("GET /status shows screening flags for flagged buyers", async () => {
  await postForm("/sessions", {
    handle: "status_flagged",
    q_coached: "yes",
    q_third_party: "no",
    q_promised_profit: "no",
  });
  const res = await fetch(baseUrl + `/status?key=${STATUS_KEY}`);
  const html = await res.text();
  assert.match(html, /status_flagged/);
  assert.match(html, /⚠ being guided by someone/);
});

test("GET /status escapes stored values", async () => {
  await db.createVerification({
    handle: '<img src=x onerror=alert(1)>',
    sessionId: "sess-xss",
    sessionUrl: "https://verify.didit.me/session/sess-xss",
    flags: {},
    flagged: false,
  });
  const res = await fetch(baseUrl + `/status?key=${STATUS_KEY}`);
  const html = await res.text();
  assert.ok(!html.includes("<img src=x"), "raw HTML must not appear in the status page");
  assert.match(html, /&lt;img src=x/);
});

test("unknown routes return 404", async () => {
  assert.equal((await fetch(baseUrl + "/nope")).status, 404);
});
