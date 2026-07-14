const REQUEST_TIMEOUT_MS = 10_000;

function makeTelegramNotifier({ botToken, chatId }) {
  if (!botToken || !chatId) {
    return {
      enabled: false,
      async notify() {},
    };
  }

  return {
    enabled: true,
    async notify(text) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          console.error("Telegram notify failed:", res.status, await res.text().catch(() => ""));
        }
      } catch (err) {
        // Notifications must never take down webhook processing.
        console.error("Telegram notify error:", err.message);
      }
    },
  };
}

module.exports = { makeTelegramNotifier };
