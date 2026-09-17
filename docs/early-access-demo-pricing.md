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

1. Deploy billing's configured-price support. It resolves the current checkout
   price from `STRIPE_PRICE_ID` to the existing `paid` tier when there is no
   stored price mapping. The original $20 price still resolves through its
   stored mapping. Both retain the same tier identity, storage, and credits;
   no database migration is needed.
2. Set TinyChat's `STRIPE_PRICE_PRO_MONTHLY_LEGACY` to the existing $20 price,
   and `STRIPE_PRICE_PRO_MONTHLY` to the prepared $50 price. Preserve any other
   existing legacy IDs. The deploy workflow accepts repository secrets or
   variables, with secrets taking precedence. Deploy this change through the
   normal backend workflow before directing checkout to the new price.
3. Rename the Stripe product to exactly **Early Access Demo**, activate the
   prepared monthly price, and set it as the product's default price.
4. Run billing's **Deploy** workflow on `main` with
   `configure_early_access_demo=true`. This deploys the billing Worker first,
   then sets its `STRIPE_PRICE_ID` to the new price using existing CI
   credentials. Ordinary pushes do not repeat this configuration
   step. Deploy the TinyChat UI changes as well. Keep the old price for existing
   subscriptions; do not migrate or cancel their subscriptions.
5. Verify `/api/billing/config` returns `name: "Early Access Demo"` and
   `priceMonthly: 5000`; check the usage indicator, Settings, pricing dialog,
   account page, and a new Stripe Checkout session. Confirm both price IDs still
   resolve to paid access.

At preparation time on 2026-09-17 the new Stripe price was created **inactive**.
No checkout setting, product name, subscription, or production D1 row was
changed during preparation. Activation and deployment must be coordinated.

Before restoring the billing Worker's old `STRIPE_PRICE_ID`, retain a stored
paid mapping for the $50 price if it already has subscribers. It will no longer
be the configured current price after rollback. TinyChat must likewise retain
aliases for every price that still has subscribers.
