import { Router } from "express";
import type { Request, Response } from "express";
import {
  TIERS,
  isModelAllowed,
  requiredTierForModel,
  type TierId,
} from "../billing/tiers.js";
import { paywallEnabled, resolveTier } from "../billing/stripe.js";
import { getUsage, isOverBudget, recordUsage } from "../billing/usage.js";
import {
  CatalogFetchError,
  getCatalog,
  isBlocklistedModel,
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
// Default to a VERIFIABLE phala/* model so a model-less POST is allowed on every
// (phala/-only) tier instead of self-denying with a 402 (ST6). Overridable via
// REDPILL_DEFAULT_MODEL. Must stay a phala/* id present in VERIFIABLE_MODELS and
// absent from the mislabeled blocklist.
const DEFAULT_BASELINE_MODEL = "phala/gpt-oss-120b";
export function defaultModel(): string {
  return process.env.REDPILL_DEFAULT_MODEL ?? DEFAULT_BASELINE_MODEL;
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

// ── Router factory ───────────────────────────────────────────────────────────

export function createChatRouter() {
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

    // AbortController so we can cancel the upstream fetch if the client disconnects
    const controller = new AbortController();
    req.on("close", () => controller.abort());

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
      res.status(502).json(parsed);
      return;
    }

    // Stream SSE back to the client
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
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
      if (error instanceof CatalogFetchError) {
        const detail = error.detail;
        if (detail.kind === "upstream_not_ok") {
          res.status(502).json({
            error: "upstream_error",
            message: `RedPill models endpoint returned ${detail.statusCode}: ${detail.body}`,
          });
          return;
        }
        if (detail.kind === "parse_failed") {
          handleRouteError(res, detail.cause, "parse models response");
          return;
        }
        handleRouteError(res, detail.cause, "fetch models");
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

    // This is a confidential-inference product: only offer models that can be
    // attested in a TEE (the `phala/*` namespace). Non-TEE (tier-0) models can't be
    // verified at all, so they're not listed. (Billing still uses the full catalog
    // above; the mislabeled-model blocklist already pruned getCatalog.)
    const visible = catalog.filter((m) => m.id.startsWith("phala/"));

    const annotated = visible.map((m) => {
      const modelRates = ratesForModel(m);
      const rateFields = {
        creditsPerKInput: modelRates.creditsPerKInput,
        creditsPerKOutput: modelRates.creditsPerKOutput,
        multiplier: multiplierFor(modelRates, baselineRates),
      };
      if (!gating) return { id: m.id, allowed: true, ...rateFields };
      const allowed = isModelAllowed(tier, m.id);
      const requiredTier = allowed ? undefined : requiredTierForModel(m.id) ?? undefined;
      return {
        id: m.id,
        allowed,
        ...(requiredTier && requiredTier !== "free" ? { requiredTier } : {}),
        ...rateFields,
      };
    });

    res.json({ models: annotated });
  });

  return router;
}
