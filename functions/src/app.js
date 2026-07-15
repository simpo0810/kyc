const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { verifyWebhookSignature } = require("./verifyWebhook");
const views = require("./views");

const HANDLE_PATTERN = /^[A-Za-z0-9_.\-]{3,30}$/;

// Statuses worth pinging the seller about; intermediate churn
// ("In Progress", "Awaiting User") stays visible on /status but doesn't notify.
const NOTIFY_STATUSES = new Set(["Approved", "Declined", "In Review", "Expired", "Abandoned"]);

function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createApp({ config, db, didit, notifier, logger = console }) {
  const app = express();

  app.set("trust proxy", 1); // Render/Fly/Railway terminate TLS at a proxy
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Chrome applies form-action to the redirect target of a form
          // submission; without this the 303 to Didit is silently blocked.
          formAction: ["'self'", "https://verify.didit.me"],
        },
      },
    })
  );
  app.use(express.urlencoded({ extended: false, limit: "10kb" }));
  app.use(express.json({ limit: "100kb" }));

  // Request log line per response; skip health checks to keep logs readable.
  app.use((req, res, next) => {
    if (req.path === "/health") return next();
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  });

  app.get("/health", (req, res) => {
    res.status(200).json({ ok: true });
  });

  // Buyer-facing intake form. Same link every time — paste this URL into
  // the Binance P2P chat for every new buyer. On the status.* domain the
  // root goes straight to the status table instead (key still required).
  app.get("/", (req, res) => {
    if (req.hostname && req.hostname.startsWith("status.")) {
      const q = req.originalUrl.indexOf("?");
      return res.redirect(302, "/status" + (q === -1 ? "" : req.originalUrl.slice(q)));
    }
    res.type("html").send(views.intakeForm());
  });

  // Each successful call costs money (a Didit session), so this endpoint is
  // rate-limited and reuses an existing open session for the same order.
  const sessionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.sessionRateLimit || 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: "Too many attempts. Please wait a few minutes and try again.",
  });

  app.post("/sessions", sessionLimiter, async (req, res) => {
    const handle = typeof req.body.handle === "string" ? req.body.handle.trim() : "";

    if (!HANDLE_PATTERN.test(handle)) {
      return res
        .status(400)
        .type("html")
        .send(views.intakeForm({ error: "Username must be 3-30 letters, digits, dots, dashes or underscores." }));
    }

    // Every question must be answered explicitly yes or no.
    const flags = {};
    for (const q of views.FRAUD_QUESTIONS) {
      const answer = req.body[`q_${q.key}`];
      if (answer !== "yes" && answer !== "no") {
        return res
          .status(400)
          .type("html")
          .send(views.intakeForm({ error: "Please answer all three questions." }));
      }
      flags[q.key] = answer === "yes";
    }
    const flagged = Object.values(flags).some(Boolean);

    try {
      // Double-click / lost-link protection: an open session for this buyer
      // is reused instead of paying for a new one. Flags are OR-merged so a
      // "yes" can't be erased by resubmitting with different answers.
      const existing = await db.findOpenByHandle(handle);
      if (existing && existing.session_url) {
        if (flagged) {
          await db.mergeFlags({ sessionId: existing.session_id, flags });
        }
        return res.redirect(303, existing.session_url);
      }

      const callbackUrl = config.baseUrl ? `${config.baseUrl}/verify/complete` : undefined;

      const session = await didit.createSession({ vendorData: `handle:${handle}`, callbackUrl });

      await db.createVerification({
        handle,
        sessionId: session.session_id,
        sessionUrl: session.url,
        flags,
        flagged,
      });

      res.redirect(303, session.url);
    } catch (err) {
      logger.error("Session creation failed:", err.message);
      res
        .status(502)
        .type("html")
        .send(views.intakeForm({ error: "Could not start verification. Please try again shortly." }));
    }
  });

  // Didit redirects the buyer back here after they finish. Nothing in the
  // query string is trusted — the webhook below is the source of truth.
  app.get("/verify/complete", (req, res) => {
    res.type("html").send(views.completePage());
  });

  // Didit webhook: fires on every status change. Signature verified before
  // anything in the payload is trusted.
  app.post("/webhooks/didit", async (req, res) => {
    const valid = verifyWebhookSignature(
      req.body,
      req.header("X-Signature-V2"),
      req.header("X-Timestamp"),
      config.diditWebhookSecret
    );

    if (!valid) {
      logger.warn("Webhook rejected: invalid signature or stale timestamp");
      return res.status(401).send("Invalid signature");
    }

    try {
      const { session_id, status, vendor_data, created_at } = req.body;
      if (typeof session_id === "string" && typeof status === "string") {
        const applied = await db.applyStatusEvent({
          sessionId: session_id,
          status,
          eventAt: Number(created_at) || 0,
        });

        if (applied && NOTIFY_STATUSES.has(status)) {
          const record = await db.getBySessionId(session_id);
          const label = record ? record.handle : vendor_data || session_id;
          const flagLine = record && record.flagged ? `\n⚠ Screening flags: ${views.flagSummary(record.flags)}` : "";
          // Awaited: in serverless the instance freezes once we respond,
          // so fire-and-forget notifications would be silently dropped.
          await notifier.notify(`Verification update\nBuyer: ${label}\nStatus: ${status}${flagLine}`);
        } else if (!applied) {
          logger.info(`Webhook for session ${session_id} ignored (stale event or unknown session)`);
        }
      }

      // Always 200 on verified payloads so Didit doesn't retry forever.
      res.status(200).send("ok");
    } catch (err) {
      logger.error("Webhook processing failed:", err.message);
      // 500 so Didit retries — the event was authentic but we failed to apply it.
      res.status(500).send("processing error");
    }
  });

  // Simple status list, gated by a shared key so it isn't wide open on the
  // public host. Not a dashboard — just enough to check before you trade.
  app.get("/status", async (req, res) => {
    const key = typeof req.query.key === "string" ? req.query.key : "";
    if (!timingSafeEqualStr(key, config.statusKey)) {
      return res.status(403).send("Forbidden");
    }
    try {
      res.type("html").send(views.statusPage(await db.listAll()));
    } catch (err) {
      logger.error("Status list failed:", err.message);
      res.status(500).send("Internal error");
    }
  });

  app.use((req, res) => {
    res.status(404).send("Not found");
  });

  // Final error handler: never leak stack traces to buyers.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error("Unhandled error:", err);
    res.status(500).send("Internal error");
  });

  return app;
}

module.exports = { createApp };
