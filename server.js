require("dotenv").config();
const { loadConfig } = require("./src/config");
const { openDb } = require("./src/db");
const { makeDiditClient } = require("./src/didit");
const { makeTelegramNotifier } = require("./src/telegram");
const { createApp } = require("./src/app");

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
}

const db = openDb(process.env.DB_PATH);
const didit = makeDiditClient({ apiKey: config.diditApiKey, workflowId: config.diditWorkflowId });
const notifier = makeTelegramNotifier({
  botToken: config.telegramBotToken,
  chatId: config.telegramChatId,
});

const app = createApp({ config, db, didit, notifier });

const server = app.listen(config.port, () => {
  console.log(`Listening on port ${config.port}`);
  if (!config.baseUrl) {
    console.warn("BASE_URL is not set — post-verification redirect will fall back to the workflow default.");
  }
  if (!notifier.enabled) {
    console.warn("Telegram notifications disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set).");
  }
});

// Render sends SIGTERM on deploys; finish in-flight requests before exiting.
function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
