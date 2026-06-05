// ── Stripe service ────────────────────────────────────────────────────────────
// Stateless subscription gating: Stripe is the database. We never persist
// subscription state locally — we resolve a user's tier by searching Stripe for
// a customer whose metadata.address matches and reading their active/trialing
// subscription. A short-lived in-memory cache (5 min TTL) keeps this off the hot
// path for repeated chat requests; the webhook invalidates entries on change.
//
// Rollout safety:
//   - PAYWALL_ENABLED (default false): when false, gating is bypassed entirely
//     and everyone is treated as `free` (current behaviour preserved).
//   - When PAYWALL_ENABLED is true but STRIPE_SECRET_KEY is missing, tier
//     resolution still returns `free` (no crash), and checkout/portal report
//     `billing_not_configured` (503) so the failure is visible, not silent.

import Stripe from "stripe";
import {
  type Interval,
  type PaidTierId,
  type TierId,
  priceIdFor,
  tierForPriceId,
} from "./tiers.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface SubscriptionInfo {
  status: string;
  interval: Interval | null;
  /** ISO timestamp of the current period end, or null. */
  currentPeriodEnd: string | null;
  /** ISO timestamp of the billing cycle anchor, or null. */
  anchor: string | null;
}

export interface TierResolution {
  tier: TierId;
  customerId: string | null;
  subscription: SubscriptionInfo | null;
}

interface CacheEntry extends TierResolution {
  fetchedAt: number;
}

export function paywallEnabled(): boolean {
  return process.env.PAYWALL_ENABLED === "true";
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

// ── Client (lazy singleton) ──────────────────────────────────────────────────

let client: Stripe | null = null;

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  if (!client) {
    // createFetchHttpClient keeps us on fetch (works under Bun and in the TEE).
    client = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
  }
  return client;
}

/** Reset the singleton + cache. Exposed for tests to inject a mock client. */
export function _setStripeClient(mock: Stripe | null): void {
  client = mock;
}

// ── Tier-resolution cache ─────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

export function invalidateAddress(address: string): void {
  cache.delete(address.toLowerCase());
}

export function _resetCache(): void {
  cache.clear();
}

// ── Tier resolution ───────────────────────────────────────────────────────────

const FREE_RESOLUTION: TierResolution = { tier: "free", customerId: null, subscription: null };

/**
 * Resolve a user's tier from Stripe (stateless). Returns `free` when the
 * paywall is off, Stripe is unconfigured, or no active subscription is found.
 */
export async function resolveTier(address: string): Promise<TierResolution> {
  const key = address.toLowerCase();

  if (!paywallEnabled() || !stripeConfigured()) {
    return FREE_RESOLUTION;
  }

  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { tier: cached.tier, customerId: cached.customerId, subscription: cached.subscription };
  }

  const resolution = await fetchTierFromStripe(key);
  cache.set(key, { ...resolution, fetchedAt: Date.now() });
  return resolution;
}

async function fetchTierFromStripe(address: string): Promise<TierResolution> {
  const stripe = getStripe();

  const customer = await findCustomerByAddress(stripe, address);
  if (!customer) return FREE_RESOLUTION;

  // List subscriptions and find the first active/trialing one we can map.
  const subs = await stripe.subscriptions.list({
    customer: customer.id,
    status: "all",
    limit: 100,
  });

  for (const sub of subs.data) {
    if (sub.status !== "active" && sub.status !== "trialing") continue;
    const priceId = sub.items.data[0]?.price?.id;
    if (!priceId) continue;
    const mapped = tierForPriceId(priceId);
    if (!mapped) continue;
    return {
      tier: mapped.tier,
      customerId: customer.id,
      subscription: {
        status: sub.status,
        interval: mapped.interval,
        currentPeriodEnd: periodEndIso(sub),
        anchor: billingAnchorIso(sub),
      },
    };
  }

  return { tier: "free", customerId: customer.id, subscription: null };
}

/** Find a customer by metadata.address, falling back to a list scan. */
async function findCustomerByAddress(
  stripe: Stripe,
  address: string,
): Promise<Stripe.Customer | null> {
  // Stripe customer search (requires search to be enabled on the account).
  const result = await stripe.customers.search({
    query: `metadata['address']:'${address}'`,
    limit: 1,
  });
  return result.data[0] ?? null;
}

function periodEndIso(sub: Stripe.Subscription): string | null {
  // current_period_end lives on the subscription (older API) or its first item.
  const fromSub = (sub as unknown as { current_period_end?: number }).current_period_end;
  const fromItem = sub.items?.data?.[0]?.current_period_end;
  const epoch = fromSub ?? fromItem;
  return typeof epoch === "number" ? new Date(epoch * 1000).toISOString() : null;
}

function billingAnchorIso(sub: Stripe.Subscription): string | null {
  // Precedence: billing_cycle_anchor → current_period_start (sub or first item,
  // version-dependent) → created. All are subscription-level epoch seconds.
  const anchor = (sub as unknown as { billing_cycle_anchor?: number }).billing_cycle_anchor;
  const startSub = (sub as unknown as { current_period_start?: number }).current_period_start;
  const startItem = sub.items?.data?.[0]?.current_period_start;
  const created = (sub as unknown as { created?: number }).created;
  const epoch = anchor ?? startSub ?? startItem ?? created;
  return typeof epoch === "number" ? new Date(epoch * 1000).toISOString() : null;
}

/** Resolve an address from a Stripe customer id (used by the webhook). */
export async function addressForCustomer(customerId: string): Promise<string | null> {
  if (!stripeConfigured()) return null;
  const stripe = getStripe();
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return null;
  const address = customer.metadata?.address;
  return typeof address === "string" ? address.toLowerCase() : null;
}

// ── Checkout & portal ─────────────────────────────────────────────────────────

function frontendUrl(): string {
  // FRONTEND_URL should be set explicitly wherever the paywall is enabled —
  // Stripe redirects the user here after checkout, and a scheme mismatch
  // (http fallback vs the https dev server) lands on an ERR_EMPTY_RESPONSE
  // page. The https default matches the dev setup's mkcert TLS (see index.ts).
  return process.env.FRONTEND_URL ?? "https://localhost:5186";
}

/** Reuse an existing customer for the address, or create one carrying metadata. */
async function ensureCustomer(stripe: Stripe, address: string): Promise<string> {
  const existing = await findCustomerByAddress(stripe, address);
  if (existing) return existing.id;
  const created = await stripe.customers.create({ metadata: { address } });
  return created.id;
}

export async function createCheckoutSession(
  address: string,
  tier: PaidTierId,
  interval: Interval,
): Promise<string> {
  const priceId = priceIdFor(tier, interval);
  if (!priceId) {
    throw new BillingNotConfiguredError(
      `No Stripe price id configured for ${tier}/${interval}`,
    );
  }

  const stripe = getStripe();
  const key = address.toLowerCase();
  const customerId = await ensureCustomer(stripe, key);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: key,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { metadata: { address: key } },
    success_url: `${frontendUrl()}/?billing=success`,
    cancel_url: `${frontendUrl()}/?billing=cancelled`,
  });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

export async function createPortalSession(address: string): Promise<string> {
  const stripe = getStripe();
  const key = address.toLowerCase();
  const customer = await findCustomerByAddress(stripe, key);
  if (!customer) {
    throw new BillingNotConfiguredError("No Stripe customer exists for this user");
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: customer.id,
    return_url: `${frontendUrl()}/?billing=portal`,
  });
  return session.url;
}

// ── Webhook ───────────────────────────────────────────────────────────────────

/** Verify and parse a Stripe webhook payload. Async for Web Crypto (Bun/TEE). */
export async function constructWebhookEvent(
  rawBody: Buffer | string,
  signature: string,
): Promise<Stripe.Event> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  const stripe = getStripe();
  return stripe.webhooks.constructEventAsync(
    rawBody,
    signature,
    secret,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class BillingNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingNotConfiguredError";
  }
}
