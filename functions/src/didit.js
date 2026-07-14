const DIDIT_API_BASE = "https://verification.didit.me";
const REQUEST_TIMEOUT_MS = 15_000;

function makeDiditClient({ apiKey, workflowId }) {
  return {
    async createSession({ vendorData, callbackUrl }) {
      const res = await fetch(`${DIDIT_API_BASE}/v3/session/`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workflow_id: workflowId,
          vendor_data: vendorData,
          ...(callbackUrl ? { callback: callbackUrl } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Didit session creation failed (${res.status}): ${body.slice(0, 500)}`);
      }

      const data = await res.json();
      if (!data.session_id || !data.url) {
        throw new Error("Didit session response missing session_id or url");
      }
      return data;
    },
  };
}

module.exports = { makeDiditClient };
