# Early Access Demo pricing

The public paid plan is **Early Access Demo — $50 USD/month**. Its internal
TinyChat tier remains `pro`, with 28,000 credits per anchored week. Existing
subscriptions retain their current price. The pricing dialog offers monthly
billing; legacy annual price IDs and amounts are retained for existing records.

TinyChat displays the name and monthly amount from `backend/src/billing/tiers.ts`.
The account app owns checkout, and its Worker selects the actual Stripe price
using `STRIPE_PRICE_ID`. Changing the display configuration alone does not
change checkout pricing.

## Coordinated rollout

The current production integration uses the **TinyCloud Storage Stripe sandbox**
(`acct_1TABD30FftynHqRp`, test mode). Do not substitute a price from another
Stripe account or mode.

- Product: `prod_UnKkOYnaNunVbE`.
- Existing $20/month price: `price_1Tnk580FftynHqRpG3mg8kYu`.
- Prepared $50/month price: `price_1UGfXY0FftynHqRpb125eEsD`.

1. In the billing repository, apply `0010_early_access_demo_price.sql`. It adds
   an equivalent `paid_early_access_demo` tier for the new price, retaining the
   original paid row and old price mapping. Verify both rows have 1 GiB storage,
   28,000 credits, and `anchored_week`.
2. Set TinyChat's `STRIPE_PRICE_PRO_MONTHLY_LEGACY` to the existing $20 price,
   and `STRIPE_PRICE_PRO_MONTHLY` to the prepared $50 price. Preserve any other
   existing legacy IDs. The deploy workflow accepts repository secrets or
   variables, with secrets taking precedence. Deploy this change through the
   normal backend workflow before directing checkout to the new price.
3. Rename the Stripe product to exactly **Early Access Demo**, activate the
   prepared monthly price, and set it as the product's default price.
4. Run billing's **Deploy** workflow on `main` with
   `configure_early_access_demo=true`. This applies only migration 0010, checks
   both price mappings have equal entitlements, sets the billing Worker's
   `STRIPE_PRICE_ID` to the new price, and deploys the account app using its
   existing CI credentials. Ordinary pushes do not repeat this configuration
   step. Deploy the TinyChat UI changes as well. Keep the old price for existing
   subscriptions; do not migrate or cancel their subscriptions.
5. Verify `/api/billing/config` returns `name: "Early Access Demo"` and
   `priceMonthly: 5000`; check the usage indicator, Settings, pricing dialog,
   account page, and a new Stripe Checkout session. Confirm both price IDs still
   resolve to paid access.

At preparation time on 2026-09-17 the new Stripe price was created **inactive**.
No checkout setting, product name, subscription, or production D1 row was
changed during preparation. Activation and deployment must be coordinated.

Rollback checkout by restoring the billing Worker's old `STRIPE_PRICE_ID`.
Retain both entitlement mappings and TinyChat's price aliases once either price
has subscribers.
