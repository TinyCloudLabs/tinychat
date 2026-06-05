import type { Request, RequestHandler, Response } from "express";
import { addressForCustomer, constructWebhookEvent, invalidateAddress } from "../billing/stripe.js";

/**
 * Stripe webhook handler.
 *
 * Stateless: Stripe is the database, so on subscription change events we only
 * invalidate the in-memory tier cache for the affected customer's address. The
 * next tier resolution then re-reads the live state from Stripe.
 *
 * This handler MUST be mounted with `express.raw({ type: "application/json" })`
 * (the raw bytes are required for signature verification) and BEFORE the global
 * JSON body parser and CSRF middleware — Stripe does not send the CSRF header.
 */
export function createBillingWebhookHandler(): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      res
        .status(503)
        .json({ error: "billing_not_configured", message: "Webhook secret is not configured." });
      return;
    }

    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string") {
      res.status(400).json({ error: "invalid_signature", message: "Missing Stripe signature." });
      return;
    }

    // req.body is a Buffer thanks to express.raw().
    const rawBody = req.body as Buffer;

    let event;
    try {
      event = await constructWebhookEvent(rawBody, signature);
    } catch (error) {
      console.warn("[billing] webhook signature verification failed:", error);
      res.status(400).json({ error: "invalid_signature", message: "Signature verification failed." });
      return;
    }

    if (event.type.startsWith("customer.subscription.")) {
      try {
        const subscription = event.data.object as { customer?: string; metadata?: Record<string, string> };
        const address =
          subscription.metadata?.address?.toLowerCase() ??
          (typeof subscription.customer === "string"
            ? await addressForCustomer(subscription.customer)
            : null);
        if (address) invalidateAddress(address);
      } catch (error) {
        // Don't fail the webhook on a cache-invalidation hiccup; log and ack.
        console.error("[billing] failed to invalidate cache for webhook event:", error);
      }
    }

    res.json({ received: true });
  };
}
