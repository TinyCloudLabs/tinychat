import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import {
  TIERS,
  isModelAllowed,
  requiredTierForModel,
  type TierId,
} from "../billing/tiers.js";
import { paywallEnabled, resolveTier } from "../billing/stripe.js";
import {
  getUsage,
  heldCredits,
  holdCredits,
  isOverBudget,
  usedInWindow,
} from "../billing/usage.js";
import { settleReply } from "../billing/settle.js";
import { callCostBound, createReplyBudget } from "../billing/reply-budget.js";
import type { LedgerFlusher } from "../billing/ledger-flusher.js";
import type { LedgerRehydrator } from "../billing/ledger-rehydrate.js";
import {
  evaluateLedgerGate,
  evaluateKDegradePolicy,
  exposeGateSource,
  hasMissingWeeklyLedgerAnchor,
  logCreditGateDeny,
} from "../billing/ledger-gate.js";
import {
  backgroundReasoningControlFor,
  CatalogFetchError,
  contextLengthFor,
  getCatalog,
  isBlocklistedModel,
  isOfferedModel,
  PICKER_MODELS,
  type BackgroundReasoningPreference,
  type CatalogModel,
} from "../billing/catalog.js";
import {
  emptyMeasure,
  estimateTextTokens,
  estimateTokens,
  measureText,
  multiplierFor,
  ratesForModel,
  streamedOutputText,
  type ModelRates,
} from "../billing/credits.js";
import { DEFAULT_CHAT_MODEL } from "@tinyboilerplate/core";
import { selectChatModel } from "../modelSelection.js";
import { noteRequestRecord, recordAfterHandler } from "../request-context.js";
import { DEFAULT_RED_PILL_BASE_URL, PRIVATE_RESPONSE_UNVERIFIED_MESSAGE, RECEIPT_AUDIT_TIMEOUT_MS, STREAMED_RESPONSE_UNVERIFIED_MESSAGE, RedPillAciError, RedPillAttestationError, RedPillResponseLimitError, redPillAciFetch } from "../redpill-aci.js";

// ── RedPill config ───────────────────────────────────────────────────────────
// REDPILL_API_KEY is required at call time. Missing key returns 500 per-request
// so the server boots cleanly even without a key configured.

const REDPILL_BASE_URL = process.env.REDPILL_BASE_URL ?? DEFAULT_RED_PILL_BASE_URL;

// Reactive context-overflow classifier (§C.12): matches an upstream 400/413 body
// that reads like a context-window / token-length failure. Kept as a single
// module-level regex so the classification is deterministic and testable. New
// upstream phrasings that don't match here fall through to the baseline 502 (§H.5).
const CONTEXT_OVERFLOW_BODY_RE =
  /context|token[s]?\s*(limit|exceed)|too\s+(long|large)|maximum.*(length|context)/i;
// Default to the offered confidential model so a model-less POST is allowed on
// every tier instead of self-denying with a 402 (ST6). Response-level
// verification is a separate frontend capability. Overridable via
// REDPILL_DEFAULT_MODEL. Must stay an exact member of the picker allowlist.
const DEFAULT_BASELINE_MODEL = DEFAULT_CHAT_MODEL;

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
  let value: string = DEFAULT_BASELINE_MODEL;
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
 * array. We also note whether answer text was streamed (delivered content)
 * and measure all generated text (answer, reasoning, tool calls) so a stream
 * without a usage chunk is charged an estimate of everything the model generated.
 *
 * IMPORTANT: this only reads — the raw bytes are forwarded to the client
 * untouched. We re-decode here purely to extract the token counts.
 */
class UsageScanner {
  private buffer = "";
  promptTokens: number | null = null;
  completionTokens: number | null = null;
  /** Answer text reached the client (reasoning and tool calls are not an answer). */
  answered = false;
  /** Everything the model generated (answer, reasoning, tool calls), measured for the no-usage estimate. */
  generated = emptyMeasure();

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
    if (typeof delta === "string" && delta) this.answered = true;
    measureText(streamedOutputText(parsed as Record<string, unknown>), this.generated);
  }
}

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

function withQwenNoThink(messages: unknown[]): unknown[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      typeof message === "object" &&
      "role" in message &&
      message.role === "user" &&
      "content" in message &&
      typeof message.content === "string"
    ) {
      return messages.map((entry, entryIndex) =>
        entryIndex === index
          ? { ...message, content: `/no_think\n${message.content}` }
          : entry,
      );
    }
  }
  return messages;
}

// ── Router factory ───────────────────────────────────────────────────────────

export interface ChatRouterOptions {
  flusher?: LedgerFlusher;
  rehydrator?: LedgerRehydrator;
  /** Verified RedPill fetch; override is for isolated tests only. */
  redpillFetch?: typeof fetch;
  /** The paid-chat rate limiter (`applyRateLimiters`), run before the send handler. */
  paidLimiter?: RequestHandler;
}

export function createChatRouter(options?: ChatRouterOptions) {
  const flusher = options?.flusher;
  const rehydrator = options?.rehydrator;
  const redpillFetch = options?.redpillFetch ?? redPillAciFetch(REDPILL_BASE_URL, RECEIPT_AUDIT_TIMEOUT_MS);
  const router = Router();
  const paidLimiter: RequestHandler = options?.paidLimiter ?? ((_req, _res, next) => next());

  router.get("/model-selection", async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await selectChatModel());
  });

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
  router.post("/", paidLimiter, recordAfterHandler(async (req: Request, res: Response) => {
    const apiKey = process.env.REDPILL_API_KEY;
    if (!apiKey) {
      res
        .status(500)
        .json({ error: "no_api_key", message: "REDPILL_API_KEY is not configured on this server." });
      return;
    }

    const { model, messages, max_output_tokens, reasoning } = req.body as {
      model?: unknown;
      messages?: unknown;
      max_output_tokens?: unknown;
      reasoning?: unknown;
    };

    // Validate messages
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: "invalid_body",
        message: "messages must be a non-empty array of {role, content} objects.",
      });
      return;
    }

    // Optional output cap, forwarded upstream as max_tokens. Absent or null = uncapped.
    const maxOutputTokens = max_output_tokens ?? undefined;
    if (
      maxOutputTokens !== undefined &&
      (typeof maxOutputTokens !== "number" ||
        !Number.isInteger(maxOutputTokens) ||
        maxOutputTokens < 1 ||
        maxOutputTokens > 4096)
    ) {
      res.status(400).json({
        error: "invalid_body",
        message: "max_output_tokens must be an integer from 1 to 4096.",
      });
      return;
    }

    const reasoningPreference = reasoning ?? undefined;
    if (
      reasoningPreference !== undefined &&
      reasoningPreference !== "off" &&
      reasoningPreference !== "minimal"
    ) {
      res.status(400).json({
        error: "invalid_body",
        message: 'reasoning must be "off" or "minimal".',
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
        message: `Model ${resolvedModel} is not offered. Only the curated confidential model is available.`,
      });
      return;
    }

    const reasoningControl =
      reasoningPreference === undefined
        ? undefined
        : backgroundReasoningControlFor(
            resolvedModel,
            reasoningPreference as BackgroundReasoningPreference,
          );
    const upstreamMessages =
      reasoningControl?.kind === "qwen_no_think" ? withQwenNoThink(messages) : messages;

    // ── Gating (only when the paywall is enabled) ─────────────────────────────
    const address = req.user?.address ?? "";
    let gatedTier: TierId = "free";
    let anchor: number | null = null;
    let rates: ModelRates | null = null;
    let budgetRemaining: number | null = null;
    // What the window had left at admission before other replies' holds (see the charge bound below).
    let admissionLeft = 0;
    // The window and allowance a reply is charged against are those at admission.
    const startedAt = Date.now();
    let ledgerWindow: { limit: number; committed: number } | null = null;
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
      const ledgerAuthoritative = process.env.LEDGER_AUTHORITATIVE === "true" && Boolean(rehydrator);
      const missingWeeklyLedgerAnchor =
        ledgerAuthoritative && hasMissingWeeklyLedgerAnchor(tierConfig, anchor);
      const outagePolicy = process.env.LEDGER_OUTAGE_POLICY ?? "bounded_k";

      // Shadow rehydration remains active with the authority flag OFF. In that
      // mode, retain its historic direct K-degrade denial; flag-ON alone lets
      // the selected outage policy decide whether a K-degrade denies.
      if (rehydrator && (!ledgerAuthoritative || !missingWeeklyLedgerAnchor)) {
        const atLimit = await rehydrator.rehydrateIfNeeded(address, tierConfig, anchor);
        if (atLimit) {
          const kDegrade = ledgerAuthoritative
            ? evaluateKDegradePolicy(outagePolicy)
            : { deny: true, source: "k_degrade" as const };
          if (kDegrade.deny) {
            const usage = getUsage(address, tierConfig, anchor);
            logCreditGateDeny({
              source: kDegrade.source,
              address,
              committed: null,
              limit: usage.limit,
              windowKind: tierConfig.budgetWindow,
            });
            res.status(402).json({
              error: "credit_budget_exceeded",
              message: `Credit budget exhausted for the ${tierConfig.name} tier.`,
              tier,
              usage,
              ...exposeGateSource(kDegrade.source),
            });
            return;
          }
        }
      }
      if (ledgerAuthoritative && rehydrator) {
        const entitlement = missingWeeklyLedgerAnchor
          ? undefined
          : await rehydrator.getEntitlement(address, tierConfig, anchor);
        const gate = evaluateLedgerGate({
          tier: tierConfig,
          anchor,
          entitlement,
          outagePolicy,
          isLocalOverBudget: () => isOverBudget(address, tierConfig, anchor),
        });
        if (gate.deny) {
          const usage = gate.includeUsage ? getUsage(address, tierConfig, anchor) : undefined;
          logCreditGateDeny({
            source: gate.source,
            address,
            committed: entitlement?.committed_credits ?? null,
            limit: entitlement?.credit_limit ?? null,
            windowKind: tierConfig.budgetWindow,
          });
          res.status(402).json({
            error: "credit_budget_exceeded",
            message: `Credit budget exhausted for the ${tierConfig.name} tier.`,
            tier,
            ...(usage ? { usage } : {}),
            ...exposeGateSource(gate.source),
          });
          return;
        }
        if (entitlement && !entitlement.isOutage && entitlement.credit_limit !== null && entitlement.committed_credits !== null) {
          ledgerWindow = { limit: entitlement.credit_limit, committed: entitlement.committed_credits };
        }
      } else {
        if (isOverBudget(address, tierConfig, anchor)) {
          const usage = getUsage(address, tierConfig, anchor);
          logCreditGateDeny({
            source: "local",
            address,
            committed: usage.used,
            limit: usage.limit,
            windowKind: tierConfig.budgetWindow,
          });
          res.status(402).json({
            error: "credit_budget_exceeded",
            message: `Credit budget exhausted for the ${tierConfig.name} tier.`,
            tier,
            usage,
            ...exposeGateSource("local"),
          });
          return;
        }
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
      // Read after the last await, so a reply that settled meanwhile counts. The ledger's committed total trails the local
      // counter by up to one flush, so against the ledger's limit the larger of the two is what is used.
      const localUsage = getUsage(address, tierConfig, anchor);
      budgetRemaining = ledgerWindow ? ledgerWindow.limit - Math.max(ledgerWindow.committed, localUsage.used) : localUsage.limit - localUsage.used;
      // Credits other replies hold are spoken for. Read here and held below, with no await in between. Nothing left to
      // spend, held or not (the ledger can say there is while the local counter, a flush ahead, says there is not), is a 402.
      const held = heldCredits(address, tierConfig, anchor, startedAt);
      if (budgetRemaining - held <= 0) {
        const denySource = held > 0 ? "held" : ledgerWindow ? "ledger" : "local";
        logCreditGateDeny({ source: denySource, address, committed: null, limit: null, windowKind: tierConfig.budgetWindow });
        res.status(402).json({
          error: "credit_budget_exceeded",
          message: `Credit budget exhausted for the ${tierConfig.name} tier.`,
          tier,
          ...exposeGateSource(denySource),
        });
        return;
      }
      admissionLeft = budgetRemaining;
      budgetRemaining -= held;
    }

    const requestBody = {
      model: resolvedModel,
      provider: { aci_verified: true },
      messages: upstreamMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...(reasoningControl?.kind === "parameter"
        ? { reasoning: { effort: reasoningControl.effort } }
        : {}),
    };
    // The reply's hold: what its prompt and output can cost within what is left, held until it settles. Its output is
    // capped to fit. The prompt is priced, and fitted into the context, at the token estimate every path uses
    // (`estimateTextTokens`). The estimate can be low (digits, 4-byte characters), so the reply is charged its full usage,
    // bounded at settlement by `chargeBound`, not only up to its hold. The finally at the end releases the hold after
    // settlement; it lapses after 30 minutes even if a hung handler never gets there.
    let outputCap = maxOutputTokens;
    let chargeBound: (() => number) | null = null;
    let releaseHold: () => void = () => {};
    if (budgetRemaining !== null && rates) {
      const promptTokens = estimateTextTokens(JSON.stringify(requestBody));
      const limit = createReplyBudget(Math.max(0, budgetRemaining), rates, contextLengthFor(resolvedModel)).limitFor(promptTokens, maxOutputTokens);
      if (!limit) {
        res.status(402).json({
          error: "credit_budget_exceeded",
          message: `Credit budget exhausted for the ${TIERS[gatedTier].name} tier.`,
          tier: gatedTier,
        });
        return;
      }
      outputCap = limit.maxTokens;
      const hold = outputCap === undefined ? budgetRemaining : Math.min(budgetRemaining, callCostBound(rates, promptTokens, outputCap));
      const tierConfig = TIERS[gatedTier];
      const usedAtAdmission = usedInWindow(address, tierConfig, anchor, startedAt);
      const left = admissionLeft;
      // The most the reply may be charged: what the window had left at admission, less what other replies have settled
      // since and what they hold now, and never less than its own hold. settleReply's own window clamp reads the local
      // counter, which can trail the ledger (after a restart), so without this parallel requests could each spend it all.
      // A window no record describes any more leaves only the hold.
      chargeBound = () => {
        const usedNow = usedInWindow(address, tierConfig, anchor, startedAt);
        if (usedNow === null || usedAtAdmission === null) return hold;
        const othersHold = Math.max(0, heldCredits(address, tierConfig, anchor, startedAt) - hold);
        return Math.max(hold, left - (usedNow - usedAtAdmission) - othersHold);
      };
      releaseHold = holdCredits(address, tierConfig, anchor, startedAt, hold, 30 * 60_000);
    }
    try {
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
      upstreamRes = await redpillFetch(`${REDPILL_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ ...requestBody, ...(outputCap === undefined ? {} : { max_tokens: outputCap }) }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") { // client left
        noteRequestRecord(res, { stream: "aborted" });
        return;
      }
      if (error instanceof RedPillAttestationError) {
        console.warn("[chat] RedPill reply receipt was not verified");
        res.status(502).json({
          error: { code: error.code, message: PRIVATE_RESPONSE_UNVERIFIED_MESSAGE },
        });
        return;
      }
      if (error instanceof RedPillAciError) {
        console.warn("[chat] model service request failed");
        res.status(502).json({
          error: { code: error.code, message: "The model service could not complete this request. Try again later." },
        });
        return;
      }
      if (error instanceof RedPillResponseLimitError) {
        console.warn("[chat] verified model response exceeded size limit");
        res.status(502).json({
          error: { code: error.code, message: "The response was too large to process safely. Try a smaller request." },
        });
        return;
      }
      handleRouteError(res, error, "reach RedPill API");
      return;
    }

    if (!upstreamRes.ok) {
      // Provider error text is used only for internal context-overflow
      // classification. Never send upstream error bodies to the browser.
      const errBody = await upstreamRes.text().catch(() => "");
      if (
        (upstreamRes.status === 400 || upstreamRes.status === 413) &&
        CONTEXT_OVERFLOW_BODY_RE.test(errBody)
      ) {
        res.status(413).json({
          error: {
            code: "context_overflow",
            message: "This request exceeds the model context limit. Try a smaller request.",
          },
        });
        return;
      }
      res.status(502).json({
        error: {
          code: "upstream_failed",
          message: "The model service could not complete this request. Try again later.",
        },
      });
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
      noteRequestRecord(res, { stream: "error", code: "upstream_incomplete", failureCause: "ours" });
      res.end();
      return;
    }

    const scanner = new UsageScanner();
    let streamFailed = false;
    let receiptFailed = false;
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
        streamFailed = true;
        receiptFailed = error instanceof RedPillAttestationError;
        console.error("[chat] stream error:", receiptFailed ? "receipt verification failed" : error);
      }
    } finally {
      // Every /api/chat failure is ours (TC-2601): the model's output never fails this stream.
      noteRequestRecord(res, controller.signal.aborted
        ? { stream: "aborted" }
        : receiptFailed ? { stream: "error", code: "private_response_unverified", failureCause: "ours" }
        : streamFailed ? { stream: "error", code: "upstream_failed", failureCause: "ours" } : { stream: "done" });
      if (!controller.signal.aborted) {
        if (receiptFailed) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `\n\n${STREAMED_RESPONSE_UNVERIFIED_MESSAGE}` } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
        }
        res.end();
      }
    }

    // ── Settle usage (best effort; only when gating is active) ────────────────
    // Bounded by `chargeBound`, not by the hold. A failed stream is free:
    // every /api/chat failure is the provider's or ours, never the model's
    // output. NEVER throws after bytes were served.
    if (paywallEnabled() && address && chargeBound) {
      const usage = scanner.hasUsage
        ? { promptTokens: scanner.promptTokens ?? 0, completionTokens: scanner.completionTokens ?? 0 }
        : estimateTokens(messages as Array<{ content?: unknown }>, scanner.generated);
      const settled = settleReply({
        address, tier: TIERS[gatedTier], anchor, startedAt, allowance: chargeBound(), model: resolvedModel,
        usage, rates, deliveredOutput: scanner.answered, executionId: crypto.randomUUID(), flusher,
        outcome: controller.signal.aborted ? "cancelled" : streamFailed ? "failed" : "success", failureCause: "ours",
      });
      noteRequestRecord(res, { credits: settled.charged });
    }
    } finally { releaseHold(); }
  }));

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
      // no last-good list. Degrade to a usable 200: the curated allowlist
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
    // picker preserves the canonical allowlist order; any allowlist model absent
    // from the upstream catalog is simply skipped.
    // (Billing still uses the full catalog above; the mislabeled-model blocklist
    // already pruned getCatalog.)
    const byCatalogId = new Map(catalog.map((m) => [m.id, m]));
    const annotated = PICKER_MODELS.map((id) => {
      const catalogModel = byCatalogId.get(id);
      const rateFields = catalogModel?.pricing
        ? (() => {
            const modelRates = ratesForModel(catalogModel);
            return {
              creditsPerKInput: modelRates.creditsPerKInput,
              creditsPerKOutput: modelRates.creditsPerKOutput,
              multiplier: multiplierFor(modelRates, baselineRates),
            };
          })()
        : {};
      // contextLength (integer tokens) drives client-side compaction budgeting
      // (§C.4c). Static in-code map with a DEFAULT_CONTEXT_TOKENS fallback; does
      // not touch the tier/credit-rate fields above.
      return {
        ...gateAnnotation(id, gating, tier),
        ...rateFields,
        contextLength: contextLengthFor(id),
      };
    });

    res.json({ models: annotated });
  });

  return router;
}
