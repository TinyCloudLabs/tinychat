import { Router } from "express";
import type { Request, Response } from "express";
import {
  TIERS,
  isModelAllowed,
  requiredTierForModel,
  type TierId,
} from "../billing/tiers.js";
import { paywallEnabled, resolveTier } from "../billing/stripe.js";
import {
  getUsage,
  isOverBudget,
  recordUsage,
  startOfAnchoredWeek,
  startOfUtcDay,
} from "../billing/usage.js";
import type { LedgerFlusher } from "../billing/ledger-flusher.js";
import type { LedgerRehydrator } from "../billing/ledger-rehydrate.js";
import {
  CatalogFetchError,
  contextLengthFor,
  getCatalog,
  isBlocklistedModel,
  isOfferedModel,
  PICKER_MODELS,
  type CatalogModel,
} from "../billing/catalog.js";
import {
  creditsFor,
  estimateCredits,
  multiplierFor,
  ratesForModel,
  type ModelRates,
} from "../billing/credits.js";

// ── RedPill config ───────────────────────────────────────────────────────────
// REDPILL_API_KEY is required at call time. Missing key returns 500 per-request
// so the server boots cleanly even without a key configured.

const REDPILL_BASE_URL = process.env.REDPILL_BASE_URL ?? "https://api.redpill.ai/v1";

// Reactive context-overflow classifier (§C.12): matches an upstream 400/413 body
// that reads like a context-window / token-length failure. Kept as a single
// module-level regex so the classification is deterministic and testable. New
// upstream phrasings that don't match here fall through to the baseline 502 (§H.5).
const CONTEXT_OVERFLOW_BODY_RE =
  /context|token[s]?\s*(limit|exceed)|too\s+(long|large)|maximum.*(length|context)/i;
// Default to a VERIFIABLE (GREEN tier) offered model so a model-less POST is
// allowed on every tier instead of self-denying with a 402 (ST6). Overridable
// via REDPILL_DEFAULT_MODEL. Must stay an exact member of the picker allowlist.
const DEFAULT_BASELINE_MODEL = "deepseek/deepseek-v4-pro";

// ST11 — validate the REDPILL_DEFAULT_MODEL override. A stale value that isn't
// in the offered allowlist (e.g. a pre-PR `openai/gpt-5-mini`, or a now-unoffered
// phala/* id) would make every model-less POST self-deny against the offered-
// model gate, so we warn loudly and fall back to the curated baseline. Memoized
// per resolved env value so the warning fires once (not per request) and stays
// deterministic.
let validatedDefault: { raw: string | undefined; value: string } | null = null;
export function defaultModel(): string {
  const raw = process.env.REDPILL_DEFAULT_MODEL;
  if (validatedDefault && validatedDefault.raw === raw) return validatedDefault.value;
  let value = DEFAULT_BASELINE_MODEL;
  if (raw) {
    if (isOfferedModel(raw)) {
      value = raw;
    } else {
      console.warn(
        `[chat] REDPILL_DEFAULT_MODEL="${raw}" is not an offered model; ` +
          `falling back to ${DEFAULT_BASELINE_MODEL}.`,
      );
    }
  }
  validatedDefault = { raw, value };
  return value;
}

if (!process.env.REDPILL_API_KEY) {
  console.warn(
    "[chat] REDPILL_API_KEY is not set. POST /api/chat will return 500 until it is configured.",
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function handleRouteError(res: Response, error: unknown, operation: string): void {
  console.error(`[chat] failed to ${operation}:`, error);
  res.status(500).json({ error: "internal_error", message: `Failed to ${operation}` });
}

const decoder = new TextDecoder();

/**
 * Scan an SSE buffer for the final usage chunk RedPill emits when
 * stream_options.include_usage is set. That chunk carries
 * `usage.prompt_tokens` and `usage.completion_tokens` with an empty `choices`
 * array. We also accumulate streamed completion text so we can fall back to
 * an estimate if no usage chunk arrives.
 *
 * IMPORTANT: this only reads — the raw bytes are forwarded to the client
 * untouched. We re-decode here purely to extract the token counts.
 */
class UsageScanner {
  private buffer = "";
  promptTokens: number | null = null;
  completionTokens: number | null = null;
  completionText = "";

  get hasUsage(): boolean {
    return this.promptTokens !== null || this.completionTokens !== null;
  }

  push(chunk: Uint8Array): void {
    this.buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") return;
    let parsed: {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: Array<{ delta?: { content?: unknown } }>;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (parsed.usage) {
      if (typeof parsed.usage.prompt_tokens === "number") {
        this.promptTokens = parsed.usage.prompt_tokens;
      }
      if (typeof parsed.usage.completion_tokens === "number") {
        this.completionTokens = parsed.usage.completion_tokens;
      }
    }
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === "string") this.completionText += delta;
  }
}

/** Conservative default rates for the post-stream recording fallback (spec §7). */
const FALLBACK_RECORDING_RATES: ModelRates = {
  creditsPerKInput: 200,
  creditsPerKOutput: 1000,
  fallback: true,
};

/** Look up a model in the catalog and resolve its rates. Missing entries get
 *  the §2.5 fallback (via ratesForModel on a synthetic null-pricing model). */
function resolveRates(catalog: CatalogModel[], modelId: string): ModelRates {
  const entry = catalog.find((m) => m.id === modelId);
  return ratesForModel(entry ?? { id: modelId, pricing: null });
}

/** Per-model tier-gating annotation shared by the full (with-rates) and degraded
 *  (no-rates) /models paths. Tier gating is static (no catalog needed): when the
 *  paywall is off every model is allowed; otherwise allowance is checked against
 *  the resolved tier and a `requiredTier` is added for denied models. The rate
 *  fields are layered on by the caller (omitted entirely in the degraded path
 *  since pricing is unavailable). */
function gateAnnotation(
  id: string,
  gating: boolean,
  tier: TierId,
): { id: string; allowed: boolean; requiredTier?: TierId } {
  if (!gating) return { id, allowed: true };
  const allowed = isModelAllowed(tier, id);
  const requiredTier = allowed ? undefined : requiredTierForModel(id) ?? undefined;
  return {
    id,
    allowed,
    ...(requiredTier && requiredTier !== "free" ? { requiredTier } : {}),
  };
}

// ── Router factory ───────────────────────────────────────────────────────────

export interface ChatRouterOptions {
  flusher?: LedgerFlusher;
  rehydrator?: LedgerRehydrator;
}

export function createChatRouter(options?: ChatRouterOptions) {
  const flusher = options?.flusher;
  const rehydrator = options?.rehydrator;
  const router = Router();

  /**
   * POST /
   * Auth-protected streaming proxy to RedPill chat/completions.
   * Body: { model?: string, messages: Array<{role, content}> }
   * Response: text/event-stream SSE forwarded straight from RedPill.
   *
   * When PAYWALL_ENABLED, the request is gated by the caller's subscription
   * tier: the model must be allowed for the tier and the tier's credit budget
   * must not be exhausted. Actual credit usage is recorded after the stream.
   */
  router.post("/", async (req: Request, res: Response) => {
    const apiKey = process.env.REDPILL_API_KEY;
    if (!apiKey) {
      res
        .status(500)
        .json({ error: "no_api_key", message: "REDPILL_API_KEY is not configured on this server." });
      return;
    }

    const { model, messages } = req.body as {
      model?: unknown;
      messages?: unknown;
    };

    // Validate messages
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: "invalid_body",
        message: "messages must be a non-empty array of {role, content} objects.",
      });
      return;
    }

    const resolvedModel = typeof model === "string" && model.trim() ? model : defaultModel();

    // ── Blocklist (authoritative; enforced regardless of the paywall) ─────────
    // A mislabeled `phala/` alias serves a differently-named model than its id
    // claims (ST7). The display catalog already hides these, but a direct POST
    // bypasses that view — reject here, before any upstream fetch or billing.
    if (isBlocklistedModel(resolvedModel)) {
      res.status(403).json({
        error: "model_blocklisted",
        message: `Model ${resolvedModel} is not available.`,
      });
      return;
    }

    // ── Offered-model gate (authoritative; enforced regardless of the paywall) ─
    // This is a confidential-inference product: only the curated picker allowlist
    // (PICKER_MODELS) is offered. GET /models filters to that same allowlist, but
    // a direct POST bypasses that view — so mirror the filter here, BEFORE any
    // upstream fetch or billing, so a non-offered model can never be proxied even
    // when the paywall is off (the default deployment). Tier/credit gating stays
    // inside the paywall block below (ST2).
    if (!isOfferedModel(resolvedModel)) {
      res.status(403).json({
        error: "model_not_offered",
        message: `Model ${resolvedModel} is not offered. Only the curated set of verifiable models is available.`,
      });
      return;
    }

    // ── Gating (only when the paywall is enabled) ─────────────────────────────
    const address = req.user?.address ?? "";
    let gatedTier: TierId = "free";
    let anchor: number | null = null;
    let rates: ModelRates | null = null;
    if (paywallEnabled()) {
      let resolution;
      try {
        resolution = await resolveTier(address);
      } catch (error) {
        handleRouteError(res, error, "resolve subscription tier");
        return;
      }
      const tier = resolution.tier;
      gatedTier = tier;
      anchor = resolution.subscription?.anchor
        ? Date.parse(resolution.subscription.anchor)
        : null;
      const tierConfig = TIERS[tier];

      if (!isModelAllowed(tier, resolvedModel)) {
        const requiredTier = requiredTierForModel(resolvedModel);
        res.status(402).json({
          error: "model_not_allowed",
          message: `Model ${resolvedModel} is not available on the ${tierConfig.name} tier.`,
          tier,
          ...(requiredTier && requiredTier !== tier ? { requiredTier } : {}),
        });
        return;
      }

      // §E.7 — seed the in-memory counter from the durable ledger before gating.
      if (rehydrator) {
        const atLimit = await rehydrator.rehydrateIfNeeded(address, tierConfig, anchor);
        if (atLimit) {
          const usage = getUsage(address, tierConfig, anchor);
          res.status(402).json({
            error: "credit_budget_exceeded",
            message: `Credit budget exhausted for the ${tierConfig.name} tier.`,
            tier,
            usage,
          });
          return;
        }
      }

      if (isOverBudget(address, tierConfig, anchor)) {
        const usage = getUsage(address, tierConfig, anchor);
        res.status(402).json({
          error: "credit_budget_exceeded",
          message: `Credit budget exhausted for the ${tierConfig.name} tier.`,
          tier,
          usage,
        });
        return;
      }

      // Resolve the requested model's rates once per request, before any bytes
      // are sent. Catalog failures here surface as 500 (spec §7); post-stream
      // failures are handled separately and must never throw after bytes flow.
      try {
        const catalog = await getCatalog();
        rates = resolveRates(catalog, resolvedModel);
      } catch (error) {
        handleRouteError(res, error, "resolve model rates");
        return;
      }
    }

    // AbortController so we can cancel the upstream fetch if the client disconnects.
    // Abort on the RESPONSE close with writableEnded=false. The REQUEST "close"
    // event fires on Bun as soon as the request body is consumed (not on client
    // disconnect), which aborts the upstream mid-stream and truncates the reply.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let upstreamRes: globalThis.Response;
    try {
      upstreamRes = await fetch(`${REDPILL_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") return; // client left
      handleRouteError(res, error, "reach RedPill API");
      return;
    }

    // Handle non-2xx before touching stream headers
    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(errBody);
      } catch {
        parsed = { error: "upstream_error", message: errBody || upstreamRes.statusText };
      }
      // Context-overflow classification (§C.12): a 400/413 whose body reads like a
      // context/token-length failure becomes a typed 413 context_overflow so the
      // client can compact-and-retry instead of surfacing a raw 502. ALL OTHER
      // upstream errors keep the baseline 502 passthrough shape byte-for-byte (§F.11).
      if (
        (upstreamRes.status === 400 || upstreamRes.status === 413) &&
        CONTEXT_OVERFLOW_BODY_RE.test(errBody)
      ) {
        res.status(413).json({
          error: { code: "context_overflow", message: errBody || upstreamRes.statusText },
        });
        return;
      }
      res.status(502).json(parsed);
      return;
    }

    // Stream SSE back to the client.
    // X-Accel-Buffering:no makes the dstack-ingress nginx stream frames straight
    // to the HTTP/2 client instead of buffering the long response (a buffered SSE
    // stream over HTTP/2 surfaces as ERR_HTTP2_PROTOCOL_ERROR / "network error"
    // through the custom-domain ingress; the direct HTTP/1.1 gateway is unaffected,
    // and localhost has no nginx — which is why this only reproduces on prod).
    // No `Connection` header: it is a hop-by-hop header forbidden under HTTP/2 and
    // managed by nginx on the app↔nginx hop, not something the app should assert.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    if (!upstreamRes.body) {
      res.end();
      return;
    }

    const scanner = new UsageScanner();
    try {
      // Bun's fetch body is async-iterable. Forward every chunk byte-for-byte
      // while tee-ing a copy through the usage scanner.
      for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
        if (controller.signal.aborted) break;
        scanner.push(chunk);
        res.write(chunk);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        // Client disconnected — clean exit
      } else {
        console.error("[chat] stream error:", error);
      }
    } finally {
      res.end();
    }

    // ── Record usage (best effort; only when gating is active) ────────────────
    // NEVER throw after bytes were served. On any rates/catalog failure here,
    // fall back to conservative default rates and console.error (spec §7).
    if (paywallEnabled() && address) {
      try {
        const effectiveRates = rates ?? FALLBACK_RECORDING_RATES;
        const credits = scanner.hasUsage
          ? creditsFor(
              effectiveRates,
              scanner.promptTokens ?? 0,
              scanner.completionTokens ?? 0,
            )
          : estimateCredits(
              effectiveRates,
              messages as Array<{ content?: unknown }>,
              scanner.completionText,
            );
        recordUsage(address, TIERS[gatedTier], credits, anchor);
        // §E.6 — shadow-push to ledger (async, never blocks serving)
        if (flusher && credits > 0) {
          const now = Date.now();
          const tierCfg = TIERS[gatedTier];
          const ws =
            tierCfg.budgetWindow === "week"
              ? startOfAnchoredWeek(anchor ?? now, now)
              : startOfUtcDay(now);
          flusher.enqueue({
            account: address,
            window_start: ws,
            window_kind: tierCfg.budgetWindow === "week" ? "anchored_week" : "utc_day",
            credits,
            model: resolvedModel,
            prompt_tokens: scanner.promptTokens ?? 0,
            completion_tokens: scanner.completionTokens ?? 0,
            occurred_at: now,
            signed_token_count: null,
          });
        }
      } catch (error) {
        console.error("[chat] failed to record post-stream usage:", error);
        try {
          const credits = scanner.hasUsage
            ? creditsFor(
                FALLBACK_RECORDING_RATES,
                scanner.promptTokens ?? 0,
                scanner.completionTokens ?? 0,
              )
            : estimateCredits(
                FALLBACK_RECORDING_RATES,
                messages as Array<{ content?: unknown }>,
                scanner.completionText,
              );
          recordUsage(address, TIERS[gatedTier], credits, anchor);
          if (flusher && credits > 0) {
            const now = Date.now();
            const tierCfg = TIERS[gatedTier];
            const ws =
              tierCfg.budgetWindow === "week"
                ? startOfAnchoredWeek(anchor ?? now, now)
                : startOfUtcDay(now);
            flusher.enqueue({
              account: address,
              window_start: ws,
              window_kind: tierCfg.budgetWindow === "week" ? "anchored_week" : "utc_day",
              credits,
              model: resolvedModel,
              prompt_tokens: scanner.promptTokens ?? 0,
              completion_tokens: scanner.completionTokens ?? 0,
              occurred_at: now,
              signed_token_count: null,
            });
          }
        } catch (fallbackError) {
          console.error("[chat] fallback usage recording also failed:", fallbackError);
        }
      }
    }
  });

  /**
   * GET /models
   * Auth-protected. Returns { models: Array<{ id, allowed, requiredTier? }> }.
   * Cached in-memory for 5 minutes. Each model is annotated for the caller's
   * tier: when the paywall is disabled every model is allowed:true.
   */
  router.get("/models", async (req: Request, res: Response) => {
    const apiKey = process.env.REDPILL_API_KEY;
    if (!apiKey) {
      res
        .status(500)
        .json({ error: "no_api_key", message: "REDPILL_API_KEY is not configured on this server." });
      return;
    }

    let catalog: CatalogModel[];
    try {
      catalog = await getCatalog();
    } catch (error: unknown) {
      // Catalog flakiness (RedPill /models latency-spikes while inference is fine)
      // must never strand the picker empty. getCatalog already serves a stale
      // cache when one exists, so reaching here means a COLD upstream failure with
      // no last-good list. Degrade to a usable 200: the curated six (PICKER_MODELS)
      // with tier gating still applied but rate fields omitted (pricing unknown).
      // The frontend tolerates missing rates (the multiplier badge only shows when
      // multiplier>1), so degraded entries render and are selectable.
      if (error instanceof CatalogFetchError) {
        console.warn(
          "[chat] /models degraded to PICKER_MODELS (catalog unavailable):",
          error.detail.kind,
          error.detail.kind === "upstream_not_ok"
            ? `${error.detail.statusCode}: ${error.detail.body}`
            : (error.detail.cause ?? error),
        );

        // Tier gating is static and needs no catalog. If even resolveTier throws
        // in this degraded path, default to allowed:true rather than 500 — keeping
        // the picker usable is the whole point of degrading.
        let degradedTier: TierId = "free";
        let degradedGating = paywallEnabled();
        if (degradedGating) {
          try {
            degradedTier = (await resolveTier(req.user?.address ?? "")).tier;
          } catch (tierError) {
            console.warn(
              "[chat] /models degraded: tier resolution also failed; allowing all:",
              tierError,
            );
            degradedGating = false;
          }
        }

        const degraded = PICKER_MODELS.map((id) => ({
          ...gateAnnotation(id, degradedGating, degradedTier),
          contextLength: contextLengthFor(id),
        }));
        res.json({ models: degraded });
        return;
      }
      handleRouteError(res, error, "fetch models");
      return;
    }

    // Annotate each model for the caller's tier.
    let tier: TierId = "free";
    const gating = paywallEnabled();
    if (gating) {
      try {
        tier = (await resolveTier(req.user?.address ?? "")).tier;
      } catch (error) {
        handleRouteError(res, error, "resolve subscription tier");
        return;
      }
    }

    // Baseline rates = the default model's rates (spec §2.4); fallback if the
    // default model is absent from the catalog. Computed from the FULL catalog so
    // the multiplier anchor is resolvable even when the default is a phala/* model.
    const baselineRates = resolveRates(catalog, defaultModel());

    // This is a confidential-inference product: only the curated picker allowlist
    // (PICKER_MODELS) is offered. We iterate the allowlist (not the catalog) so the
    // picker preserves the canonical fast→smart, green-then-teal display order;
    // any allowlist model absent from the upstream catalog is simply skipped.
    // (Billing still uses the full catalog above; the mislabeled-model blocklist
    // already pruned getCatalog.)
    const byCatalogId = new Map(catalog.map((m) => [m.id, m]));
    const visible: CatalogModel[] = PICKER_MODELS.map((id) => byCatalogId.get(id)).filter(
      (m): m is CatalogModel => m !== undefined,
    );

    const annotated = visible.map((m) => {
      const modelRates = ratesForModel(m);
      const rateFields = {
        creditsPerKInput: modelRates.creditsPerKInput,
        creditsPerKOutput: modelRates.creditsPerKOutput,
        multiplier: multiplierFor(modelRates, baselineRates),
      };
      // contextLength (integer tokens) drives client-side compaction budgeting
      // (§C.4c). Static in-code map with a DEFAULT_CONTEXT_TOKENS fallback; does
      // not touch the tier/credit-rate fields above.
      return {
        ...gateAnnotation(m.id, gating, tier),
        ...rateFields,
        contextLength: contextLengthFor(m.id),
      };
    });

    res.json({ models: annotated });
  });

  return router;
}
