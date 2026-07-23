import { createApiClient, type SessionStore } from "@tinyboilerplate/client";

// ── Billing API types (mirror the backend contract exactly) ──────────

export type TierId = "free" | "pro";

export interface BillingTier {
  id: TierId;
  name: string;
  priceMonthly: number;
  priceYearly: number;
  /** Credit allowance per `budgetWindow`. */
  creditBudget: number;
  budgetWindow: "day" | "week";
  /** Glob-ish model id patterns this tier may use (e.g. "phala/*"). */
  modelPatterns: string[];
}

export interface BillingConfig {
  paywallEnabled: boolean;
  tiers: BillingTier[];
  /**
   * Base URL of the account app, where checkout + subscription management now
   * live (TinyChat's local checkout/portal were retired in the universal-ledger
   * cutover). The pricing UI opens `${accountAppUrl}/billing`.
   */
  accountAppUrl: string;
}

export interface BillingUsage {
  used: number;
  limit: number;
  /** ISO timestamp when the usage window resets. */
  resetsAt: string;
}

export interface BillingSubscription {
  status: string;
  interval: "monthly" | "yearly";
  /** ISO timestamp of the current period end. */
  currentPeriodEnd: string;
}

export interface BillingStatus {
  tier: TierId;
  usage: BillingUsage;
  subscription: BillingSubscription | null;
}

export interface ModelRates {
  id: string;
  creditsPerKInput: number;
  creditsPerKOutput: number;
  multiplier: number;
}

export interface RatesResponse {
  baseline: string;
  models: ModelRates[];
}

export interface BillingClient {
  /** Public, no-auth: tier catalog + master paywall flag. */
  getConfig(): Promise<BillingConfig>;
  /** Authed: the signed-in user's tier, usage, and subscription. */
  getStatus(): Promise<BillingStatus>;
  /** Public, no-auth: per-model credit rates table. */
  getRates(): Promise<RatesResponse>;
}

/**
 * Typed client for the billing endpoints.
 *
 * `getConfig` and `getRates` are public (no auth) — but we route them through
 * the same api client so the Bearer + X-Requested-With header plumbing stays in
 * one place. The backend ignores the token on public routes; if no session
 * exists yet the client simply omits the header.
 */
export function createBillingClient(
  backendUrl: string,
  sessionStore: SessionStore,
): BillingClient {
  const api = createApiClient(backendUrl, { sessionStore });
  return {
    getConfig() {
      return api.get<BillingConfig>("/api/billing/config");
    },
    getStatus() {
      return api.get<BillingStatus>("/api/billing/status");
    },
    getRates() {
      return api.get<RatesResponse>("/api/billing/rates");
    },
  };
}

// ── Shared per-session rates cache ──────────────────────────────────
//
// The rates catalog is public + immutable for a session, and BOTH the visible
// receipt path (runtime.tsx computeReceipt) and the background-credit fold
// (extraction in runtime.tsx, compaction in App.tsx) re-derive credits from it.
// Memoize a single fetch so every fold reads the same catalog the visible path
// does. On failure we reset so the next caller retries — receipts are UI sugar,
// never a chat blocker.

let cachedRatesPromise: Promise<RatesResponse> | null = null;

/** Fetch the rates catalog once per session (shared by every credit re-derivation). */
export function getCachedRates(client: BillingClient): Promise<RatesResponse> {
  if (!cachedRatesPromise) {
    cachedRatesPromise = client.getRates().catch((err) => {
      cachedRatesPromise = null;
      throw err;
    });
  }
  return cachedRatesPromise;
}

// ── Formatting helpers (shared by the pricing dialog + usage indicator) ──

/** Human-format a raw credit budget, e.g. 50_000 → "50K credits". */
export function formatCreditBudget(credits: number): string {
  if (!Number.isFinite(credits) || credits <= 0) return "—";
  if (credits >= 1_000_000) {
    const m = credits / 1_000_000;
    return `${trimNum(m)}M credits`;
  }
  if (credits >= 1_000) {
    const k = credits / 1_000;
    return `${trimNum(k)}K credits`;
  }
  return `${credits} credits`;
}

/** "50K credits/day" / "12K credits/wk" for a tier's budget + window. */
export function formatCreditBudgetWithWindow(
  credits: number,
  window: "day" | "week",
): string {
  const base = formatCreditBudget(credits);
  if (base === "—") return base;
  return `${base}/${window === "day" ? "day" : "wk"}`;
}

/** Exact receipt-style credit count, e.g. 1240 → "1,240 credits". */
export function formatCredits(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  return `${n.toLocaleString()} credits`;
}

/** Price in whole units (dollars). Backend sends cents → we divide. */
export function formatPrice(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return "Free";
  const dollars = cents / 100;
  return `$${trimNum(dollars)}`;
}

/** Yearly discount percentage vs. paying monthly for 12 months, or 0. */
export function yearlyDiscountPercent(
  priceMonthly: number,
  priceYearly: number,
): number {
  if (priceMonthly <= 0 || priceYearly <= 0) return 0;
  const fullYear = priceMonthly * 12;
  if (priceYearly >= fullYear) return 0;
  return Math.round(((fullYear - priceYearly) / fullYear) * 100);
}

function trimNum(n: number): string {
  // 5 → "5", 5.5 → "5.5", 4.99 → "4.99"
  return Number.parseFloat(n.toFixed(2)).toString();
}

// ── Credit math mirror (duplicated from backend by design) ──────────
//
// The receipt re-derives the charge from public data (rates + the SSE usage
// chunk that already passes through to the browser byte-for-byte) — that's the
// audit. Keep this in sync with `backend/src/billing/credits.ts`. Rates are
// already snapped server-side, so no client-side niceCeil is needed.

/** Compute credits for a single message from rates + usage chunk (spec §2.3). */
export function creditsFor(
  rates: Pick<ModelRates, "creditsPerKInput" | "creditsPerKOutput">,
  promptTokens: number,
  completionTokens: number,
): number {
  const prompt = Math.max(0, promptTokens);
  const completion = Math.max(0, completionTokens);
  if (prompt === 0 && completion === 0) return 0;
  const raw =
    (prompt / 1000) * rates.creditsPerKInput +
    (completion / 1000) * rates.creditsPerKOutput;
  return Math.max(1, Math.ceil(raw));
}

/**
 * Split a charged total into an input (prompt) and output (completion) share
 * for the two-footer receipt (user message + assistant message).
 *
 * The charged total is `creditsFor(...)` (ceil, min 1) — the meter's source of
 * truth. We derive the input share from the prompt tokens at the input rate,
 * round it, clamp it to `[0, total]`, and assign the remainder to output. This
 * GUARANTEES `input + output === total` exactly (no rounding leak), so the two
 * footers always sum to the recorded charge.
 */
export function splitCredits(
  rates: Pick<ModelRates, "creditsPerKInput" | "creditsPerKOutput">,
  promptTokens: number,
  completionTokens: number,
): { total: number; inputCredits: number; outputCredits: number } {
  const total = creditsFor(rates, promptTokens, completionTokens);
  const prompt = Math.max(0, promptTokens);
  const rawInput = Math.round((prompt / 1000) * rates.creditsPerKInput);
  const inputCredits = Math.min(total, Math.max(0, rawInput));
  const outputCredits = total - inputCredits;
  return { total, inputCredits, outputCredits };
}

// ── Turn-total aggregation (visible reply + background billed calls) ──
//
// A single assistant turn can bill MORE than the visible completion: memory
// extraction fires every turn and compaction fires occasionally, each a real
// billed `/api/chat` call whose credits the ledger charges but which the
// visible badge never covered — so the meter jumped by more than the badge
// showed. `aggregateTurnCredits` is the ONE fold that reconciles them: given
// the visible reply's charged total and the turn's background usages (each with
// its own model's rates — extraction may run a different model than the reply),
// it re-derives each background call's credits with the same `creditsFor`
// formula the visible path uses and returns the turn total. The invariant the
// callers rely on: `visibleCredits + Σ backgroundComponents === total`, so the
// badge (visible + background) and the meter bump (background) always agree.
//
// A 0-token usage contributes 0 (creditsFor returns 0 for no tokens), so an
// aborted/empty background call is folded in as a no-op automatically.

/** One background billed call's usage + the rates of the model that served it. */
export interface BackgroundUsage {
  rates: Pick<ModelRates, "creditsPerKInput" | "creditsPerKOutput">;
  promptTokens: number;
  completionTokens: number;
}

/** Result of folding a turn's background usages into its visible reply total. */
export interface TurnAggregation {
  /** The full turn cost: visible reply + every background call. */
  total: number;
  /** The visible reply's charged credits (unchanged, echoed for callers). */
  visibleCredits: number;
  /** Sum of every background call's credits — the meter bump / badge delta. */
  backgroundCredits: number;
  /** Per-background-call credits, in input order. Their sum is backgroundCredits. */
  backgroundComponents: number[];
}

/**
 * Pure fold: the turn total from the visible reply's charged credits plus the
 * turn's background billed calls. `visibleCredits + Σ backgroundComponents ===
 * total` always holds (integer credits, no rounding leak — each component is a
 * whole `creditsFor`). Pass `visibleCredits = 0` for a background call with no
 * pending visible reply (e.g. compaction on load) — then `total` is just the
 * background sum, to bump the session meter without touching any badge.
 */
export function aggregateTurnCredits(
  visibleCredits: number,
  background: readonly BackgroundUsage[],
): TurnAggregation {
  const visible = Math.max(0, Math.floor(visibleCredits));
  const backgroundComponents = background.map((u) =>
    creditsFor(u.rates, u.promptTokens, u.completionTokens),
  );
  const backgroundCredits = backgroundComponents.reduce((sum, c) => sum + c, 0);
  return {
    total: visible + backgroundCredits,
    visibleCredits: visible,
    backgroundCredits,
    backgroundComponents,
  };
}

// ── Receipt store (session-scoped per-message credit charges) ───────
//
// A single completed exchange registers TWO entries: the user message id (the
// input/prompt share) and the assistant message id (the output/completion
// share). Each entry carries its `side` so the footer can render a
// context-cost hint on the input side only.

/** A per-message receipt entry: the credits charged and which side it is. */
export interface ReceiptEntry {
  credits: number;
  side: "input" | "output";
  /**
   * True when this output-side total was folded up to the FULL turn cost —
   * i.e. it now includes background credits (memory upkeep) beyond the visible
   * completion. Lets the footer label the extra neutrally without naming any
   * model/provider. Absent/false on plain visible-only receipts.
   */
  includesUpkeep?: boolean;
}

const receiptMap = new Map<string, ReceiptEntry>();
type ReceiptListener = (messageId: string, entry: ReceiptEntry) => void;
const receiptListeners = new Set<ReceiptListener>();

/** Get the receipt entry for a message id, if known this session. */
export function getReceipt(messageId: string): ReceiptEntry | undefined {
  return receiptMap.get(messageId);
}

/** Record a receipt entry for a message id and notify subscribers. */
export function setReceipt(
  messageId: string,
  credits: number,
  side: "input" | "output",
  includesUpkeep?: boolean,
): void {
  const entry: ReceiptEntry = { credits, side, includesUpkeep };
  receiptMap.set(messageId, entry);
  for (const listener of receiptListeners) {
    try {
      listener(messageId, entry);
    } catch {
      // a listener throwing must not break the receipt path
    }
  }
}

/** Subscribe to receipt updates. Returns an unsubscribe fn. */
export function onReceipt(listener: ReceiptListener): () => void {
  receiptListeners.add(listener);
  return () => {
    receiptListeners.delete(listener);
  };
}
