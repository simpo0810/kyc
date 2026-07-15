function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 40px auto; padding: 0 20px 60px; color: #1a1a1a; }
    h1 { font-size: 1.3rem; }
    label.field { display: block; margin-top: 20px; font-weight: 600; font-size: 0.95rem; }
    input[type="text"] { width: 100%; padding: 12px; margin-top: 8px; box-sizing: border-box; font-size: 1rem; border: 1px solid #ccc; border-radius: 8px; }
    button { margin-top: 28px; width: 100%; padding: 14px; font-size: 1rem; font-weight: 600; background: #111; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
    p.hint { color: #666; font-size: 0.9rem; }
    p.error { color: #b00020; font-weight: 600; }
    fieldset.q { border: none; padding: 0; margin: 22px 0 0; }
    fieldset.q legend { font-weight: 600; font-size: 0.95rem; padding: 0; margin-bottom: 10px; }
    .pills { display: flex; gap: 10px; }
    .pills input[type="radio"] { position: absolute; opacity: 0; width: 0; height: 0; }
    .pills label { flex: 1; text-align: center; padding: 12px 0; border: 1.5px solid #ccc; border-radius: 8px; cursor: pointer; font-size: 1rem; user-select: none; }
    .pills input[value="no"]:checked + label { border-color: #111; background: #111; color: #fff; }
    .pills input[value="yes"]:checked + label { border-color: #b45309; background: #b45309; color: #fff; }
    .pills input[type="radio"]:focus-visible + label { outline: 2px solid #2563eb; outline-offset: 2px; }
    .warn { display: none; margin: 10px 0 0; padding: 10px 12px; background: #fef3c7; border-left: 3px solid #b45309; border-radius: 6px; font-size: 0.88rem; color: #78350f; }
    fieldset.q:has(input[value="yes"]:checked) .warn { display: block; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #ddd; font-size: 0.9rem; }
    th { background: #f5f5f5; }
    td.flagged { color: #b45309; font-weight: 600; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

// Questions shown on the intake form. key = form field suffix and storage
// key; warn = scam warning shown to the buyer the moment they answer "yes".
const FRAUD_QUESTIONS = [
  {
    key: "coached",
    text: "Is anyone guiding you through this purchase or telling you what to do — for example a “support agent”, broker, employer, or someone you met online?",
    warn: "Legitimate companies and real romantic partners never direct people to buy crypto for them. If someone told you how to answer these questions, this trade may be a scam targeting you.",
  },
  {
    key: "third_party",
    text: "Are you buying this crypto for someone else, or sending it to a wallet that isn’t yours?",
    warn: "Buying crypto on someone else’s behalf is the most common way scammers use innocent people. Money sent this way is almost never recovered.",
  },
  {
    key: "promised_profit",
    text: "Has anyone promised you profits, investment returns, or a job connected to this purchase?",
    warn: "Guaranteed returns and “crypto jobs” that require you to buy crypto first are classic scams. Please pause and reconsider before continuing.",
  },
];

// Short labels the seller sees on the status page and in notifications.
const FLAG_LABELS = {
  coached: "being guided by someone",
  third_party: "buying for someone else",
  promised_profit: "promised profits/job",
};

function questionHtml(q, index) {
  const id = `q_${q.key}`;
  return `  <fieldset class="q">
    <legend>${index + 1}. ${escapeHtml(q.text)}</legend>
    <div class="pills">
      <input type="radio" id="${id}_yes" name="${id}" value="yes" required />
      <label for="${id}_yes">Yes</label>
      <input type="radio" id="${id}_no" name="${id}" value="no" />
      <label for="${id}_no">No</label>
    </div>
    <p class="warn">${escapeHtml(q.warn)}</p>
  </fieldset>`;
}

function intakeForm({ error } = {}) {
  return page(
    "Identity Verification",
    `  <h1>Quick check before we trade</h1>
  <p class="hint">Takes about a minute: three quick questions, then an ID scan with our verification partner Didit. Your documents go only to Didit — we never see or store them.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="/sessions">
    <label class="field" for="handle">Your Binance P2P username</label>
    <input id="handle" type="text" name="handle" required maxlength="30" pattern="[A-Za-z0-9_.\\-]{3,30}" placeholder="exactly as it appears in our trade chat" />
${FRAUD_QUESTIONS.map(questionHtml).join("\n")}
    <button type="submit">Continue to ID verification</button>
  </form>`
  );
}

function completePage() {
  return page(
    "Verification submitted",
    `  <h1>Thanks - you're done here</h1>
  <p>Your verification has been submitted. The seller will confirm the result and continue the trade in the Binance chat shortly.</p>`
  );
}

function flagSummary(flags) {
  if (!flags) return "";
  return Object.keys(FLAG_LABELS)
    .filter((k) => flags[k])
    .map((k) => FLAG_LABELS[k])
    .join(", ");
}

function statusPage(rows) {
  const rowsHtml = rows
    .map((r) => {
      const flagText = flagSummary(r.flags);
      return `<tr>
        <td>${escapeHtml(r.handle || r.order_ref || "")}</td>
        <td class="${flagText ? "flagged" : ""}">${flagText ? "⚠ " + escapeHtml(flagText) : "—"}</td>
        <td>${escapeHtml(r.status)}</td>
        <td>${escapeHtml(r.updated_at)}</td>
      </tr>`;
    })
    .join("\n");

  return page(
    "Verification status",
    `  <h1>Verification status</h1>
  <table>
    <thead><tr><th>Buyer</th><th>Screening flags</th><th>Status</th><th>Updated (UTC)</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>`
  );
}

module.exports = { intakeForm, completePage, statusPage, escapeHtml, FRAUD_QUESTIONS, flagSummary };
