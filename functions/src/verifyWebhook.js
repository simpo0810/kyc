const crypto = require("crypto");

const MAX_CLOCK_SKEW_SECONDS = 300;

// Reproduces Didit's canonical JSON: keys sorted recursively, compact
// separators, no extra whitespace. JS's own number formatting already
// collapses whole-valued floats (1.0 -> 1), matching Didit's rule.
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

function verifyWebhookSignature(body, signatureHeader, timestampHeader, secret) {
  if (!signatureHeader || !timestampHeader) return false;

  const now = Math.floor(Date.now() / 1000);
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }

  const canonicalBody = canonicalize(body);
  const expected = crypto.createHmac("sha256", secret).update(canonicalBody).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

module.exports = { verifyWebhookSignature };
