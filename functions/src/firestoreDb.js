const OPEN_STATUSES = ["Not Started", "In Progress", "Awaiting User", "Resubmitted"];

// Documents are keyed by session_id. Only non-PII trade-tracking fields are
// stored; all documents/selfies stay with Didit.
function makeFirestoreDb(firestore) {
  const col = firestore.collection("verifications");

  return {
    async createVerification({ handle, sessionId, sessionUrl, flags, flagged }) {
      const now = new Date().toISOString();
      await col.doc(sessionId).set({
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
      // Single-field filter avoids needing a composite index; a buyer has
      // at most a handful of sessions, so in-memory filtering is fine.
      const snap = await col.where("handle", "==", handle).get();
      const open = snap.docs.map((d) => d.data()).filter((r) => OPEN_STATUSES.includes(r.status));
      open.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return open[0];
    },

    async getBySessionId(sessionId) {
      const snap = await col.doc(sessionId).get();
      return snap.exists ? snap.data() : undefined;
    },

    // OR-merges screening flags: once a session is flagged, resubmitting the
    // form with different answers can't clear it.
    async mergeFlags({ sessionId, flags }) {
      const ref = col.doc(sessionId);
      await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const current = snap.data();
        const merged = { ...current.flags };
        for (const [k, v] of Object.entries(flags)) merged[k] = merged[k] || v;
        tx.update(ref, {
          flags: merged,
          flagged: Object.values(merged).some(Boolean),
          updated_at: new Date().toISOString(),
        });
      });
    },

    // Returns true if the event was applied, false if it was stale or the
    // session is unknown. Transaction keeps the out-of-order guard atomic.
    async applyStatusEvent({ sessionId, status, eventAt }) {
      const ref = col.doc(sessionId);
      return firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        const current = snap.data();
        const evt = eventAt || 0;
        if (current.last_event_at !== null && current.last_event_at > evt) return false;
        tx.update(ref, { status, last_event_at: evt, updated_at: new Date().toISOString() });
        return true;
      });
    },

    async listAll() {
      const snap = await col.orderBy("updated_at", "desc").limit(500).get();
      return snap.docs.map((d) => d.data());
    },
  };
}

module.exports = { makeFirestoreDb, OPEN_STATUSES };
