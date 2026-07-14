# P2P KYC Gate

One reusable link you paste into every Binance P2P chat. The buyer fills in
their order number, gets redirected into Didit's hosted verification flow,
and you get a Telegram ping (plus a simple status page) when a result is in.

```
buyer opens link ─► intake form (order # + optional contact)
                 ─► POST /sessions ─► Didit session created, tagged via vendor_data
                 ─► buyer redirected to Didit hosted verification
Didit ─► POST /webhooks/didit (X-Signature-V2 verified) ─► status stored
      ─► Telegram notification on Approved / Declined / In Review
you  ─► GET /status?key=... before releasing the trade
```

## What this does NOT do

- No accounts, no buyer registration, no marketplace.
- No document/selfie storage — Didit holds all PII. This app stores only:
  order reference, optional contact, session id + url, status, timestamps.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | Buyer intake form (the link you share) |
| `POST /sessions` | Creates a tagged Didit session, redirects buyer into it. Rate-limited per IP; reuses an open session for the same order so double-clicks don't create paid duplicates |
| `GET /verify/complete` | Post-verification landing page. Query-string status is ignored — the webhook is the only source of truth |
| `POST /webhooks/didit` | Didit status webhook. HMAC-SHA256 over canonical JSON (`X-Signature-V2`) + timestamp freshness (`X-Timestamp`, 300s window) verified before anything is trusted. Out-of-order retries can't regress a final status |
| `GET /status?key=...` | Status table, gated by `STATUS_KEY` (timing-safe compare) |
| `GET /healthz` | Health check for the platform load balancer |

## 1. Didit Business Console setup

1. Create a workflow under **Console → Workflows**. Start with
   ID Verification + Liveness + Face Match. Whether to add AML/sanctions
   screening (and above what trade size) is a business/risk decision for
   you — it is deliberately not assumed here.
2. Under **API & Webhooks**: copy the API key → `DIDIT_API_KEY` and the
   workflow UUID → `DIDIT_WORKFLOW_ID`.
3. Create a webhook destination pointing at
   `https://<your-deployed-url>/webhooks/didit`. The `secret_shared_key`
   it shows **once** → `DIDIT_WEBHOOK_SECRET`.

## 2. Telegram notifications (optional)

1. Message [@BotFather](https://t.me/BotFather), `/newbot`, token →
   `TELEGRAM_BOT_TOKEN`.
2. Message your new bot once, then read `chat.id` from
   `https://api.telegram.org/bot<token>/getUpdates` → `TELEGRAM_CHAT_ID`.

Skip it and results are still visible at `/status?key=...`. Only
actionable statuses notify (Approved / Declined / In Review / Expired /
Abandoned); intermediate churn doesn't ping you.

## 3. Configure

Copy `.env.example` → `.env` and fill it in. The server fails fast at boot
with a clear message if anything required is missing. Generate `STATUS_KEY`
with:

```
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## 4. Run locally

```
npm ci
npm test     # 23 tests: signature verification, routes, rate limit, XSS escaping
npm start
```

To exercise the full loop locally (Didit needs a public webhook URL), run a
tunnel — `ngrok http 3000` — and use the tunnel URL as `BASE_URL` and the
webhook destination.

## 5. Deploy

**Render (recommended):** `render.yaml` is included — create a Blueprint
from the repo, then fill the `sync: false` env vars in the dashboard. The
service uses a persistent disk at `/data` for SQLite; after the first
deploy, set `BASE_URL` to the service URL and point the Didit webhook at
`https://<service>.onrender.com/webhooks/didit`.

**Docker (any host):**

```
docker build -t p2p-kyc-gate .
docker run -p 3000:3000 -v kyc-data:/data --env-file .env p2p-kyc-gate
```

The server handles SIGTERM gracefully (finishes in-flight requests, closes
the DB), so platform redeploys don't drop buyers mid-request.

## Operational notes

- **Cost control:** `POST /sessions` is the only endpoint that spends money
  (one Didit session ≈ $0.15–0.33). It's rate-limited
  (`SESSION_RATE_LIMIT`, default 10/IP/15min) and duplicate submissions for
  an order that already has an open session reuse the existing link.
- **Backups:** the SQLite file (`DB_PATH`) is the only state. It's small;
  snapshot the disk or copy the file periodically. Losing it loses your
  status history but nothing at Didit — sessions remain queryable in the
  Business Console.
- **Compliance:** whether you're legally required to run KYC/AML on
  individual P2P crypto sales, and at what size/frequency, is a
  jurisdiction-specific question for a professional — not something this
  code answers.

## Day to day

Paste `https://<your-url>/` into the Binance P2P chat for every new buyer.
When the Telegram ping arrives (or `/status` shows it), confirm the status
is **Approved** before releasing the trade.
