const { OPEN_STATUSES } = require("./firestoreDb");

// In-memory implementation of the same async db interface as firestoreDb.
// Used by the test suite so app logic is tested without a Firestore emulator.
function makeMemoryDb() {
  const bySessionId = new Map();

  return {
    async createVerification({ orderRef, buyerContact, sessionId, sessionUrl }) {
      const now = new Date().toISOString();
      bySessionId.set(sessionId, {
        order_ref: orderRef,
        buyer_contact: buyerContact || null,
        session_id: sessionId,
        session_url: sessionUrl,
        status: "Not Started",
        last_event_at: null,
        created_at: now,
        updated_at: now,
      });
    },

    async findOpenByOrderRef(orderRef) {
      const open = [...bySessionId.values()].filter(
        (r) => r.order_ref === orderRef && OPEN_STATUSES.includes(r.status)
      );
      open.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return open[0];
    },

    async getBySessionId(sessionId) {
      return bySessionId.get(sessionId);
    },

    async applyStatusEvent({ sessionId, status, eventAt }) {
      const current = bySessionId.get(sessionId);
      if (!current) return false;
      const evt = eventAt || 0;
      if (current.last_event_at !== null && current.last_event_at > evt) return false;
      current.status = status;
      current.last_event_at = evt;
      current.updated_at = new Date().toISOString();
      return true;
    },

    async listAll() {
      return [...bySessionId.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    },
  };
}

module.exports = { makeMemoryDb };
