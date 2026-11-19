import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import {
  TIERS,
  creditBudgetFor,
  type Interval,
  type PaidTierId,
  type TierConfig,
  type TierId,
} from "../billing/tiers.js";
import { getUsage, isOverBudget, type UsageSnapshot } from "../billing/usage.js";
import { evaluateLedgerGate, hasMissingWeeklyLedgerAnchor } from "../billing/ledger-gate.js";
import type { LedgerRehydrator } from "../billing/ledger-rehydrate.js";
import {
  BillingNotConfiguredError,
  createCheckoutSession,
  paywallEnabled,
  resolveTier,
  stripeConfigured,
} from "../billing/stripe.js";
import { CatalogFetchError, getCatalog } from "../billing/catalog.js";
import { multiplierFor, ratesForModel } from "../billing/credits.js";

interface BillingRoutesConfig {
  authMiddleware: RequestHandler;
  /** Present only when the ledger is configured; /status reads the same authority the chat gate does. */
  rehydrator?: LedgerRehydrator;
}

/**
 * Usage as the admission gate reports it. When the ledger is authoritative this is its committed credits and
 * limit (the same rehydrate-then-entitlement read chat uses); otherwise, or when the ledger gives no valid
 * reading, it is the local in-memory counter.
 */
async function gateUsage(
  address: string,
  tier: TierConfig,
  anchor: number | null,
  rehydrator: LedgerRehydrator | undefined,
): Promise<UsageSnapshot> {
  const local = getUsage(address, tier, anchor);
  if (process.env.LEDGER_AUTHORITATIVE !== "true" || !rehydrator) return local;
  const missingAnchor = hasMissingWeeklyLedgerAnchor(tier, anchor);
  if (!missingAnchor) await rehydrator.rehydrateIfNeeded(address, tier, anchor);
  const entitlement = missingAnchor ? undefined : await rehydrator.getEntitlement(address, tier, anchor);
  const gate = evaluateLedgerGate({
    tier,
    anchor,
    entitlement,
    outagePolicy: process.env.LEDGER_OUTAGE_POLICY ?? "bounded_k",
    isLocalOverBudget: () => isOverBudget(address, tier, anchor),
  });
  if (gate.source !== "ledger" || !entitlement || entitlement.committed_credits === null || entitlement.credit_limit === null) {
    return local;
  }
  return { ...local, used: entitlement.committed_credits, limit: entitlement.credit_limit };
}

const ACCOUNT_APP_URL = "https://account.tinycloud.xyz";

function requireUser(req: Request, res: Response): { address: string } | null {
  if (!req.user) {
    res.status(401).json({ error: "unauthenticated", message: "Authentication required" });
    return null;
  }
  return req.user;
}

function retiredBillingResponse(res: Response): void {
  res.status(410).json({
    error: "billing_retired",
    message: "TinyChat billing checkout and portal have moved to the account app.",
    accountAppUrl: ACCOUNT_APP_URL,
  });
}

/**
 * Public tier ids surfaced to the frontend, in display order. The universal-
 * ledger cutover collapsed the paid lineup to ONE unified plan, so only "free"
 * and "pro" are advertised. "plus" is intentionally omitted from the public
 * catalog even though it remains in `TIERS`/`TIER_ORDER` for internal tier
 * resolution and legacy-subscription fallback (Phase 5 deletes the local stack).
 */
const PUBLIC_TIER_ORDER: TierId[] = ["free", "pro"];

/**
 * Public pricing payload shared with the frontend. Derived from the tier config
 * so there is a single source of truth.
 */
function publicTiers() {
  return PUBLIC_TIER_ORDER.map((id) => {
    const tier = TIERS[id];
    return {
      id: tier.id,
      name: tier.name,
      priceMonthly: tier.priceMonthly,
      priceYearly: tier.priceYearly,
      creditBudget: creditBudgetFor(tier.id),
      budgetWindow: tier.budgetWindow,
      modelPatterns: tier.modelPatterns,
    };
  });
}

export function createBillingRouter(config: BillingRoutesConfig) {
  const router = Router();

  /** GET /config — public pricing. No auth. */
  router.get("/config", (_req: Request, res: Response) => {
    res.json({
      paywallEnabled: paywallEnabled(),
      tiers: publicTiers(),
      // Where the upgrade/manage-subscription UX lives now that TinyChat billing
      // checkout and portal have moved to the account app. The frontend opens
      // `${accountAppUrl}/billing` instead of a local Stripe redirect.
      accountAppUrl: ACCOUNT_APP_URL,
    });
  });

  /**
   * GET /rates — public per-model credit rates (spec §4.6).
   *
   * Denominated in credits only — no dollar fields ever appear in this payload
   * (spec §2.1). Served from the shared catalog; mirrors `/models`' 500/502
   * error contract so the rates table degrades the same way the picker does.
   */
  router.get("/rates", async (_req: Request, res: Response) => {
    try {
      const catalog = await getCatalog();
      const baselineId = process.env.REDPILL_DEFAULT_MODEL ?? "z-ai/glm-5.2";
      const baselineEntry = catalog.find((m) => m.id === baselineId) ?? {
        id: baselineId,
        pricing: null,
      };
      const baselineRates = ratesForModel(baselineEntry);
      const models = catalog.map((m) => {
        const r = ratesForModel(m);
        return {
          id: m.id,
          creditsPerKInput: r.creditsPerKInput,
          creditsPerKOutput: r.creditsPerKOutput,
          multiplier: multiplierFor(r, baselineRates),
        };
      });
      res.json({ baseline: baselineId, models });
    } catch (error: unknown) {
      if (error instanceof CatalogFetchError) {
        const detail = error.detail;
        if (detail.kind === "upstream_not_ok") {
          res.status(502).json({
            error: "upstream_error",
            message: `RedPill models endpoint returned ${detail.statusCode}: ${detail.body}`,
          });
          return;
        }
        console.error("[billing] failed to load rates:", detail.cause);
        res.status(500).json({ error: "internal_error", message: "Failed to load rates" });
        return;
      }
      console.error("[billing] failed to load rates:", error);
      res.status(500).json({ error: "internal_error", message: "Failed to load rates" });
    }
  });

  /** GET /status — caller's tier, usage, and subscription. */
  router.get("/status", config.authMiddleware, async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const resolution = await resolveTier(user.address);
      const anchor = resolution.subscription?.anchor
        ? Date.parse(resolution.subscription.anchor)
        : null;
      const usage = await gateUsage(user.address, TIERS[resolution.tier], anchor, config.rehydrator);
      res.json({
        tier: resolution.tier,
        usage,
        subscription: resolution.subscription,
      });
    } catch (error) {
      console.error("[billing] failed to load status:", error);
      res.status(500).json({ error: "internal_error", message: "Failed to load billing status" });
    }
  });

  /** POST /checkout { tier, interval } — returns a Stripe Checkout URL. */
  router.post("/checkout", config.authMiddleware, async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const { tier, interval } = (req.body ?? {}) as { tier?: unknown; interval?: unknown };
    if (tier === "plus" || tier === "pro") {
      retiredBillingResponse(res);
      return;
    }

    if (!paywallEnabled() || !stripeConfigured()) {
      res.status(503).json({
        error: "billing_not_configured",
        message: "Billing is not configured on this server.",
      });
      return;
    }

    if (tier !== "plus" && tier !== "pro") {
      res.status(400).json({
        error: "invalid_body",
        message: "tier must be 'plus' or 'pro'.",
      });
      return;
    }
    if (interval !== "monthly" && interval !== "yearly") {
      res.status(400).json({
        error: "invalid_body",
        message: "interval must be 'monthly' or 'yearly'.",
      });
      return;
    }

    try {
      const url = await createCheckoutSession(
        user.address,
        tier as PaidTierId,
        interval as Interval,
      );
      res.json({ url });
    } catch (error) {
      if (error instanceof BillingNotConfiguredError) {
        res.status(503).json({ error: "billing_not_configured", message: error.message });
        return;
      }
      console.error("[billing] failed to create checkout session:", error);
      res
        .status(500)
        .json({ error: "internal_error", message: "Failed to create checkout session" });
    }
  });

  /** POST /portal — returns a Stripe billing portal URL. */
  router.post("/portal", config.authMiddleware, async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    retiredBillingResponse(res);
  });

  return router;
}
