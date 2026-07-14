const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { verifyWebhookSignature } = require("./verifyWebhook");
const views = require("./views");

const ORDER_REF_PATTERN = /^[A-Za-z0-9\-_]{4,64}$/;
const MAX_CONTACT_LENGTH = 128;

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
  app.use(helmet());
  app.use(express.urlencoded({ extended: false, limit: "10kb" }));
  app.use(express.json({ limit: "100kb" }));

  // Request log line per response; skip health checks to keep logs readable.
  app.use((req, res, next) => {
    if (req.path === "/healthz") return next();
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  });

  app.get("/healthz", (req, res) => {
    res.status(200).json({ ok: true });
  });

  // Buyer-facing intake form. Same link every time — paste this URL into
  // the Binance P2P chat for every new buyer.
  app.get("/", (req, res) => {
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
    const orderRef = typeof req.body.orderRef === "string" ? req.body.orderRef.trim() : "";
    const buyerContact =
      typeof req.body.buyerContact === "string" ? req.body.buyerContact.trim().slice(0, MAX_CONTACT_LENGTH) : "";

    if (!ORDER_REF_PATTERN.test(orderRef)) {
      return res
        .status(400)
        .type("html")
        .send(views.intakeForm({ error: "Order number must be 4-64 letters, digits, dashes or underscores." }));
    }

    try {
      // Double-click / lost-link protection: an open session for this order
      // is reused instead of paying for a new one.
      const existing = db.findOpenByOrderRef(orderRef);
      if (existing && existing.session_url) {
        return res.redirect(303, existing.session_url);
      }

      const vendorData = buyerContact ? `order:${orderRef}|contact:${buyerContact}` : `order:${orderRef}`;
      const callbackUrl = config.baseUrl ? `${config.baseUrl}/verify/complete` : undefined;

      const session = await didit.createSession({ vendorData, callbackUrl });

      db.createVerification({
        orderRef,
        buyerContact: buyerContact || null,
        sessionId: session.session_id,
        sessionUrl: session.url,
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
  app.post("/webhooks/didit", (req, res) => {
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

    const { session_id, status, vendor_data, created_at } = req.body;
    if (typeof session_id === "string" && typeof status === "string") {
      const applied = db.applyStatusEvent({
        sessionId: session_id,
        status,
        eventAt: Number(created_at) || 0,
      });

      if (applied && NOTIFY_STATUSES.has(status)) {
        const record = db.getBySessionId(session_id);
        const label = record ? record.order_ref : vendor_data || session_id;
        notifier.notify(`Verification update\nOrder: ${label}\nStatus: ${status}`);
      } else if (!applied) {
        logger.info(`Webhook for session ${session_id} ignored (stale event or unknown session)`);
      }
    }

    // Always 200 on verified payloads so Didit doesn't retry forever.
    res.status(200).send("ok");
  });

  // Simple status list, gated by a shared key so it isn't wide open on the
  // public host. Not a dashboard — just enough to check before you trade.
  app.get("/status", (req, res) => {
    const key = typeof req.query.key === "string" ? req.query.key : "";
    if (!timingSafeEqualStr(key, config.statusKey)) {
      return res.status(403).send("Forbidden");
    }
    res.type("html").send(views.statusPage(db.listAll()));
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
