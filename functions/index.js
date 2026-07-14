const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");

const { createApp } = require("./src/app");
const { makeFirestoreDb } = require("./src/firestoreDb");
const { makeDiditClient } = require("./src/didit");
const { makeTelegramNotifier } = require("./src/telegram");

// Secrets live in Google Secret Manager — the CLI prompts for any unset
// value on first deploy (`firebase functions:secrets:set NAME` to change).
const diditApiKey = defineSecret("DIDIT_API_KEY");
const diditWebhookSecret = defineSecret("DIDIT_WEBHOOK_SECRET");
const statusKey = defineSecret("STATUS_KEY");

// Non-secret settings come from functions/.env (see .env.example).
const diditWorkflowId = defineString("DIDIT_WORKFLOW_ID");
const baseUrl = defineString("BASE_URL", { default: "" });
const telegramBotToken = defineString("TELEGRAM_BOT_TOKEN", { default: "" });
const telegramChatId = defineString("TELEGRAM_CHAT_ID", { default: "" });

admin.initializeApp();

// Built lazily on first request: params are only readable at runtime.
let app;

exports.kyc = onRequest(
  {
    // us-central1 is required for Firebase Hosting rewrites to functions.
    region: "us-central1",
    secrets: [diditApiKey, diditWebhookSecret, statusKey],
    // Bounds worst-case cost; this workload never needs parallel instances.
    maxInstances: 2,
  },
  (req, res) => {
    if (!app) {
      app = createApp({
        config: {
          baseUrl: baseUrl.value().replace(/\/+$/, "") || null,
          diditWebhookSecret: diditWebhookSecret.value(),
          statusKey: statusKey.value(),
          sessionRateLimit: 10,
        },
        db: makeFirestoreDb(admin.firestore()),
        didit: makeDiditClient({
          apiKey: diditApiKey.value(),
          workflowId: diditWorkflowId.value(),
        }),
        notifier: makeTelegramNotifier({
          botToken: telegramBotToken.value() || null,
          chatId: telegramChatId.value() || null,
        }),
      });
    }
    return app(req, res);
  }
);
