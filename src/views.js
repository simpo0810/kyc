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
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 1.3rem; }
    label { display: block; margin-top: 16px; font-weight: 600; font-size: 0.9rem; }
    input { width: 100%; padding: 10px; margin-top: 6px; box-sizing: border-box; font-size: 1rem; border: 1px solid #ccc; border-radius: 6px; }
    button { margin-top: 24px; width: 100%; padding: 12px; font-size: 1rem; background: #111; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
    p.hint { color: #666; font-size: 0.85rem; }
    p.error { color: #b00020; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #ddd; font-size: 0.9rem; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function intakeForm({ error } = {}) {
  return page(
    "Identity Verification",
    `  <h1>Verify your identity to continue the trade</h1>
  <p class="hint">This takes about a minute. You'll be redirected to Didit, our verification partner, to scan your ID and take a quick selfie.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="/sessions">
    <label for="orderRef">Binance order number</label>
    <input id="orderRef" type="text" name="orderRef" required maxlength="64" pattern="[A-Za-z0-9\\-_]{4,64}" placeholder="e.g. 20250714123456" />
    <label for="buyerContact">Contact (Telegram/WhatsApp/email) - optional</label>
    <input id="buyerContact" type="text" name="buyerContact" maxlength="128" placeholder="so we can reach you if needed" />
    <button type="submit">Start verification</button>
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

function statusPage(rows) {
  const rowsHtml = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.order_ref)}</td>
        <td>${escapeHtml(r.buyer_contact || "")}</td>
        <td>${escapeHtml(r.status)}</td>
        <td>${escapeHtml(r.updated_at)}</td>
      </tr>`
    )
    .join("\n");

  return page(
    "Verification status",
    `  <h1>Verification status</h1>
  <table>
    <thead><tr><th>Order</th><th>Contact</th><th>Status</th><th>Updated (UTC)</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>`
  );
}

module.exports = { intakeForm, completePage, statusPage, escapeHtml };
