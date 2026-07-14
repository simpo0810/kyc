const REQUIRED = ["DIDIT_API_KEY", "DIDIT_WORKFLOW_ID", "DIDIT_WEBHOOK_SECRET", "STATUS_KEY"];

function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || !env[k].trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  if (env.STATUS_KEY.trim().length < 16) {
    throw new Error("STATUS_KEY must be at least 16 characters — use a long random string.");
  }

  const baseUrl = env.BASE_URL ? env.BASE_URL.trim().replace(/\/+$/, "") : null;
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    throw new Error(`BASE_URL must be an absolute http(s) URL, got: ${baseUrl}`);
  }

  return {
    port: Number(env.PORT) || 3000,
    baseUrl,
    diditApiKey: env.DIDIT_API_KEY.trim(),
    diditWorkflowId: env.DIDIT_WORKFLOW_ID.trim(),
    diditWebhookSecret: env.DIDIT_WEBHOOK_SECRET.trim(),
    statusKey: env.STATUS_KEY.trim(),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.trim() : null,
    telegramChatId: env.TELEGRAM_CHAT_ID ? env.TELEGRAM_CHAT_ID.trim() : null,
    sessionRateLimit: Number(env.SESSION_RATE_LIMIT) || 10,
  };
}

module.exports = { loadConfig };
