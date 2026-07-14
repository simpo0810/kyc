# P2P KYC Gate (Firebase)

One reusable link you paste into every Binance P2P chat. The buyer fills in
their order number, gets redirected into Didit's hosted verification flow,
and you get a Telegram ping (plus a simple status page) when a result is in.

Runs as a single Cloud Function behind Firebase Hosting, with Firestore for
state. At a few trades a day this fits comfortably inside Firebase's free
quotas — expected hosting cost ≈ $0/month (Didit checks billed separately).

```
buyer opens link ─► intake form (order # + optional contact)
                 ─► POST /sessions ─► Didit session created, tagged via vendor_data
                 ─► buyer redirected to Didit hosted verification
Didit ─► POST /webhooks/didit (X-Signature-V2 verified) ─► status in Firestore
      ─► Telegram notification on Approved / Declined / In Review
you  ─► GET /status?key=... before releasing the trade
```

## What this does NOT do

- No accounts, no buyer registration, no marketplace.
- No document/selfie storage — Didit holds all PII. Firestore stores only:
  order reference, optional contact, session id + url, status, timestamps.
- Firestore is locked to `allow read, write: if false` — only the function's
  Admin SDK can touch it.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | Buyer intake form (the link you share) |
| `POST /sessions` | Creates a tagged Didit session, redirects buyer into it. Rate-limited per IP; reuses an open session for the same order so double-clicks don't create paid duplicates |
| `GET /verify/complete` | Post-verification landing page. Query-string status is ignored — the webhook is the only source of truth |
| `POST /webhooks/didit` | Didit status webhook. HMAC-SHA256 over canonical JSON (`X-Signature-V2`) + timestamp freshness (`X-Timestamp`, 300s window) verified before anything is trusted. Out-of-order retries can't regress a final status (Firestore transaction) |
| `GET /status?key=...` | Status table, gated by `STATUS_KEY` (timing-safe compare) |
| `GET /healthz` | Health check |

## One-time setup

### 1. Firebase project

1. [console.firebase.google.com](https://console.firebase.google.com) →
   **Add project** (Analytics not needed).
2. **Upgrade to the Blaze plan** (pay-as-you-go). Required for outbound API
   calls from functions; actual cost at this volume is ~$0. Set a budget
   alert (e.g. $5) while you're there.
3. In the console: **Build → Firestore Database → Create database**
   (production mode, any region).
4. Install the CLI and link the project:

```
npm install -g firebase-tools
firebase login
firebase use --add        # pick your project, alias "default"
```

### 2. Didit Business Console

1. Create a workflow (**Console → Workflows**): ID Verification + Liveness
   + Face Match. Adding AML/sanctions screening (and above what trade size)
   is a business/risk decision for you — deliberately not assumed here.
2. Copy the workflow UUID into `functions/.env` → `DIDIT_WORKFLOW_ID`.
3. Keep the API key handy — the deploy prompts for it (stored in Google
   Secret Manager, never in files).

### 3. First deploy

```
cd functions && npm ci && cd ..
firebase deploy --only functions,hosting,firestore
```

The CLI prompts for the three secrets on first deploy:

- `DIDIT_API_KEY` — from the Didit console
- `DIDIT_WEBHOOK_SECRET` — **not known yet**; enter `placeholder` for now
- `STATUS_KEY` — a long random string; generate with
  `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

### 4. Wire up the webhook (after first deploy)

Your site is now at `https://<project-id>.web.app`.

1. Put that URL in `functions/.env` → `BASE_URL`.
2. Didit console → **API & Webhooks** → create a webhook destination
   pointing at `https://<project-id>.web.app/webhooks/didit`. Copy the
   `secret_shared_key` it shows **once**, then:

```
firebase functions:secrets:set DIDIT_WEBHOOK_SECRET   # paste the key
firebase deploy --only functions
```

### 5. Telegram notifications (optional)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → token into
   `functions/.env` → `TELEGRAM_BOT_TOKEN`.
2. Message your new bot once, read `chat.id` from
   `https://api.telegram.org/bot<token>/getUpdates` →
   `TELEGRAM_CHAT_ID`. Redeploy functions.

Skip it and results are still visible at `/status?key=...`. Only actionable
statuses notify (Approved / Declined / In Review / Expired / Abandoned).

## Development

```
cd functions
npm ci
npm test        # 23 tests: signature verification, routes, rate limit, XSS escaping
```

Tests run against an in-memory db — no emulator needed. To run the full
stack locally: `npm run serve` (Firebase emulators).

## Operational notes

- **Cost control:** `POST /sessions` is the only endpoint that spends money
  (one Didit session ≈ $0.15–0.33). It's rate-limited per IP and duplicate
  submissions for an order with an open session reuse the existing link.
  `maxInstances: 2` on the function bounds worst-case platform cost.
- **Rate-limit caveat:** the limiter is in-memory per function instance;
  with `maxInstances: 2` the effective ceiling is at most double the
  configured limit. Fine at this scale.
- **Compliance:** whether you're legally required to run KYC/AML on
  individual P2P crypto sales, and at what size/frequency, is a
  jurisdiction-specific question for a professional — not something this
  code answers.

## Day to day

Paste `https://<project-id>.web.app/` into the Binance P2P chat for every
new buyer. When the Telegram ping arrives (or `/status?key=...` shows it),
confirm the status is **Approved** before releasing the trade.
