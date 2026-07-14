const { test } = require("node:test");
const assert = require("node:assert/strict");
const { openDb } = require("../src/db");
const { createApp } = require("../src/app");

const quietLogger = { info() {}, warn() {}, error() {} };

test("POST /sessions is rate-limited per IP", async () => {
  const db = openDb(":memory:");
  let calls = 0;

  const app = createApp({
    config: {
      baseUrl: null,
      diditWebhookSecret: "secret",
      statusKey: "a-sufficiently-long-status-key",
      sessionRateLimit: 2,
    },
    db,
    didit: {
      async createSession() {
        calls += 1;
        return { session_id: `sess-${calls}`, url: `https://verify.didit.me/session/${calls}` };
      },
    },
    notifier: { enabled: false, async notify() {} },
    logger: quietLogger,
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.on("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const post = (orderRef) =>
      fetch(baseUrl + "/sessions", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ orderRef }).toString(),
        redirect: "manual",
      });

    assert.equal((await post("ORDER-A1")).status, 303);
    assert.equal((await post("ORDER-A2")).status, 303);
    assert.equal((await post("ORDER-A3")).status, 429, "third request within the window is throttled");
    assert.equal(calls, 2, "throttled request must not reach Didit");
  } finally {
    server.close();
    db.close();
  }
});
