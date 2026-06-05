# Stripe Subscription Gating — Setup Guide

TinyChat gates premium models and enforces per-tier **credit** budgets using
Stripe subscriptions. The backend is **stateless**: Stripe is the source of
truth for subscription state. There is no local database, no SQLite, and no
volumes — the backend resolves a user's tier by querying Stripe and caches the
result in memory for 5 minutes. See `docs/credits.md` for the credit economy
(peg, ladder, budget rationale).

This guide covers the exact Stripe dashboard steps and the env vars required.

---

## Tiers

| Tier | Price (display) | Credit budget | Window | Models |
|------|-----------------|---------------|--------|--------|
| Free | $0 | 500 credits | per UTC **day** | `openai/gpt-5-mini`, `anthropic/claude-3.5-haiku` |
| Plus | $10/mo · $96/yr | 12,000 credits | per **week**, anchored to subscription start | all `openai/*` + `anthropic/*` |
| Pro  | $20/mo · $192/yr | 28,000 credits | per **week**, anchored to subscription start | **all** models, incl. `phala/*` (TEE) |

Tier definitions live in `backend/src/billing/tiers.ts` (single source of truth).
Free is env-overridable with `CREDIT_BUDGET_FREE`; paid budgets with
`CREDIT_BUDGET_PLUS_WEEKLY` / `CREDIT_BUDGET_PRO_WEEKLY`. The legacy
`CREDIT_BUDGET_PLUS` / `CREDIT_BUDGET_PRO` names (which used to mean per-month)
are deliberately **not read** — a stale monthly value in deploy config must
never silently apply to the new weekly window; leave them unset and the
defaults apply. Model allowance is decided by **prefix matching** against the
requested model id.

### A note on units (cents)

All money is in **integer cents**, everywhere:

- The display prices in `tiers.ts` / `GET /api/billing/config` are cents
  (`plus.priceMonthly = 1000` = $10.00). The frontend divides by 100 to render
  dollars.
- Stripe's price `unit_amount` is **also** in cents, so the two stay consistent.
  When you create the prices below, enter the dollar amount in the dashboard
  (Stripe shows a dollar field) — it is stored as cents internally.

---

## 1. Create the products and prices

In the Stripe dashboard (start in **Test mode** — toggle top-right):

1. **Products → Add product** → name it **Plus**.
   - Add a **recurring** price: **$10.00 USD**, billing period **Monthly**. Save.
   - Add a second recurring price to the same product: **$96.00 USD**, period
     **Yearly**. Save.
2. **Products → Add product** → name it **Pro**.
   - Recurring price **$20.00 USD**, **Monthly**.
   - Recurring price **$192.00 USD**, **Yearly**.
3. For each of the four prices, open it and copy the **Price ID** (`price_…`).
   These map to the env vars:

   | Env var | Price |
   |---------|-------|
   | `STRIPE_PRICE_PLUS_MONTHLY` | Plus / $10 monthly |
   | `STRIPE_PRICE_PLUS_YEARLY`  | Plus / $96 yearly  |
   | `STRIPE_PRICE_PRO_MONTHLY`  | Pro / $20 monthly  |
   | `STRIPE_PRICE_PRO_YEARLY`   | Pro / $192 yearly  |

> The actual charge amount comes from the Stripe price. The numbers in
> `tiers.ts` are display-only — keep them in sync with the dashboard, but Stripe
> is what charges the card.

## 2. API key

**Developers → API keys** → copy the **Secret key**.

- Test mode: `sk_test_…` → set as `STRIPE_SECRET_KEY` while testing.
- Live mode: `sk_live_…` for production.

## 3. Enable Customer Search

Tier resolution uses Stripe's **customer search** API
(`metadata['address']:'…'`). Search is enabled by default on most accounts; if
`resolveTier` throws a "search not enabled" error, enable it from the dashboard
(Customers → search) or contact Stripe support. The backend writes
`metadata.address` (lowercase wallet address) on every customer it creates at
checkout, which is what search keys on.

## 4. Configure the Customer Portal

**Settings → Billing → Customer portal** → enable it and allow customers to
**cancel** / **update** subscriptions. `POST /api/billing/portal` returns a
portal session URL for the signed-in user.

## 5. Webhook endpoint

**Developers → Webhooks → Add endpoint**:

- **Endpoint URL**: `https://api.tinycloud.chat/api/billing/webhook`
  (for local testing use the Stripe CLI — see below).
- **Events to send** — at minimum the subscription lifecycle:
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - (`customer.subscription.paused` / `resumed` are also handled — the backend
    reacts to any `customer.subscription.*` event by invalidating its cache.)
- After creating the endpoint, copy the **Signing secret** (`whsec_…`) into
  `STRIPE_WEBHOOK_SECRET`.

The webhook is **stateless**: on a subscription event it only invalidates the
in-memory tier cache for the affected customer's address, so the next tier
resolution re-reads live state from Stripe. Signatures are verified with
`STRIPE_WEBHOOK_SECRET`; unverified requests get `400`.

> Implementation note: the webhook route is mounted **before** the JSON body
> parser and the CSRF middleware in `backend/src/index.ts`, because Stripe
> signature verification needs the raw request bytes and Stripe does not send
> the `X-Requested-With` CSRF header.

## 6. Environment variables

Set these on the backend (see `backend/.env.example`):

```sh
# Master switch. Default false = NO gating (current behaviour). Flip to true
# only once everything below is filled in.
PAYWALL_ENABLED=true

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

STRIPE_PRICE_PLUS_MONTHLY=price_...
STRIPE_PRICE_PLUS_YEARLY=price_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
```

### Safe rollout

- `PAYWALL_ENABLED=false` (default): no gating at all. Every request behaves
  exactly as before and every user is treated as `free` with no limits
  enforced. Deploy with the paywall off, configure Stripe, then flip it on.
- `PAYWALL_ENABLED=true` **but** `STRIPE_SECRET_KEY` missing: everyone resolves
  to `free`, and `POST /api/billing/checkout` / `/portal` return
  `503 { "error": "billing_not_configured" }` so the misconfiguration is
  visible rather than silently broken.

## 7. Test the flow (test mode)

1. Start the backend with the test-mode env vars above and `PAYWALL_ENABLED=true`.
2. Forward webhooks locally with the Stripe CLI:
   ```sh
   stripe listen --forward-to https://localhost:3014/api/billing/webhook
   ```
   Use the `whsec_…` it prints as `STRIPE_WEBHOOK_SECRET`.
3. Sign in to the app, open the pricing UI, and start a Plus/Pro checkout.
4. On the Stripe Checkout page use the test card:
   - Number `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
5. After success you're redirected to `…/?billing=success`. `GET
   /api/billing/status` should now report the upgraded tier, and premium models
   stop returning `402`.
6. Manage/cancel via `POST /api/billing/portal`.

---

## API surface (for reference)

- `GET /api/billing/config` — public pricing `{ paywallEnabled, tiers[] }`
  (prices in cents).
- `GET /api/billing/status` (auth) — `{ tier, usage, subscription }`.
- `POST /api/billing/checkout` (auth) — `{ tier, interval }` → `{ url }`.
- `POST /api/billing/portal` (auth) → `{ url }`.
- `POST /api/billing/webhook` — Stripe-signed, raw body.
- `GET /api/billing/rates` — public per-model credit rates
  `{ baseline, models: [{ id, creditsPerKInput, creditsPerKOutput, multiplier }] }`.
- `POST /api/chat` returns `402` when gated:
  `{ error: "model_not_allowed", message, tier, requiredTier? }` or
  `{ error: "credit_budget_exceeded", message, tier, usage: { used, limit, resetsAt } }`.
- `GET /api/chat/models` annotates each model
  `{ id, allowed, requiredTier?, creditsPerKInput, creditsPerKOutput, multiplier }`.

---

## Known limitation: in-memory usage tracking

Credit usage (`backend/src/billing/usage.ts`) is tracked **in process memory**,
keyed by wallet address. The free-tier window is the UTC day; **paid tiers use
a rolling 7-day window anchored to the subscription's billing-cycle anchor**
(`subscription.billing_cycle_anchor`, falling back to `current_period_start`
then `created`). The window boundary is
`anchor + floor((now − anchor) / 7d) × 7d`, so it stays aligned to the user's
own subscription date instead of jumping per renewal. The anchor itself lives
in Stripe (durable), so window identity survives redeploys even though the
in-memory in-window count does not.

**This resets on redeploy.** A redeploy effectively forgives whatever a user has
consumed in the current window — i.e. it errs in the user's favour, never
against them. For the Phala TEE CVM deployment, where the process restarts on
each deploy, expect counters to reset then. This is an accepted trade-off of the
"no SQLite, no volumes / Stripe is the database" decision.

Credit counts are derived from the upstream stream's `usage` chunk
(`stream_options: { include_usage: true }`) — `prompt_tokens` and
`completion_tokens` are priced through the per-model rates from
`/api/billing/rates`. The raw SSE bytes are forwarded to the client unchanged;
the scanner only reads. If no usage chunk arrives, the backend falls back to a
chars/4 estimate over the request messages and the streamed completion text,
priced through the same rates.

### Follow-up: Stripe Billing Meters

The durable fix for usage tracking is **Stripe Billing Meters** (usage-based
billing). That moves credit accounting into Stripe itself — surviving redeploys,
working across multiple backend instances, and optionally enabling
metered/overage pricing. This is the recommended next step once the flat-rate
subscription tiers are validated. Until then, the in-memory tracker is
intentionally simple and stateless.
