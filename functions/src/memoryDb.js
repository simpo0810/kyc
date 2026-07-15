const { OPEN_STATUSES } = require("./firestoreDb");

// In-memory implementation of the same async db interface as firestoreDb.
// Used by the test suite so app logic is tested without a Firestore emulator.
function makeMemoryDb() {
  const bySessionId = new Map();

  return {
    async createVerification({ handle, sessionId, sessionUrl, flags, flagged }) {
      const now = new Date().toISOString();
      bySessionId.set(sessionId, {
        handle,
        session_id: sessionId,
        session_url: sessionUrl,
        status: "Not Started",
        flags: flags || {},
        flagged: Boolean(flagged),
        last_event_at: null,
        created_at: now,
        updated_at: now,
      });
    },

    async findOpenByHandle(handle) {
      const open = [...bySessionId.values()].filter(
        (r) => r.handle === handle && OPEN_STATUSES.includes(r.status)
      );
      open.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return open[0];
    },

    async getBySessionId(sessionId) {
      return bySessionId.get(sessionId);
    },

    async mergeFlags({ sessionId, flags }) {
      const current = bySessionId.get(sessionId);
      if (!current) return;
      for (const [k, v] of Object.entries(flags)) current.flags[k] = current.flags[k] || v;
      current.flagged = Object.values(current.flags).some(Boolean);
      current.updated_at = new Date().toISOString();
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
