const path = require("path");
const Database = require("better-sqlite3");

const OPEN_STATUSES = ["Not Started", "In Progress", "Awaiting User", "Resubmitted"];

function openDb(filename) {
  const db = new Database(filename || path.join(__dirname, "..", "data.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_ref TEXT NOT NULL,
      buyer_contact TEXT,
      session_id TEXT UNIQUE NOT NULL,
      session_url TEXT,
      status TEXT NOT NULL DEFAULT 'Not Started',
      last_event_at INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_verifications_order_ref ON verifications(order_ref);
  `);

  const stmts = {
    insert: db.prepare(
      `INSERT INTO verifications (order_ref, buyer_contact, session_id, session_url)
       VALUES (@orderRef, @buyerContact, @sessionId, @sessionUrl)`
    ),
    findOpenByOrderRef: db.prepare(
      `SELECT * FROM verifications
       WHERE order_ref = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})
       ORDER BY id DESC LIMIT 1`
    ),
    getBySessionId: db.prepare(`SELECT * FROM verifications WHERE session_id = ?`),
    // Guard against out-of-order webhook delivery: only apply events at
    // least as new as the last one we applied for this session.
    updateStatus: db.prepare(
      `UPDATE verifications
       SET status = @status,
           last_event_at = @eventAt,
           updated_at = datetime('now')
       WHERE session_id = @sessionId
         AND (last_event_at IS NULL OR last_event_at <= @eventAt)`
    ),
    listAll: db.prepare(`SELECT * FROM verifications ORDER BY updated_at DESC LIMIT 500`),
  };

  return {
    createVerification({ orderRef, buyerContact, sessionId, sessionUrl }) {
      stmts.insert.run({ orderRef, buyerContact: buyerContact || null, sessionId, sessionUrl });
    },

    findOpenByOrderRef(orderRef) {
      return stmts.findOpenByOrderRef.get(orderRef, ...OPEN_STATUSES);
    },

    getBySessionId(sessionId) {
      return stmts.getBySessionId.get(sessionId);
    },

    // Returns true if the event was applied, false if it was stale or the
    // session is unknown.
    applyStatusEvent({ sessionId, status, eventAt }) {
      const result = stmts.updateStatus.run({ sessionId, status, eventAt: eventAt || 0 });
      return result.changes > 0;
    },

    listAll() {
      return stmts.listAll.all();
    },

    close() {
      db.close();
    },
  };
}

module.exports = { openDb, OPEN_STATUSES };
