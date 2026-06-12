import { Router } from "express";
import type { Request, Response } from "express";
import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
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

// ST11 — validate the REDPILL_DEFAULT_MODEL override. A stale non-phala/* or
// blocklisted value (e.g. a pre-PR `openai/gpt-5-mini`) would make every
// model-less POST self-deny against the ST2 offered-model gate, so we warn
// loudly and fall back to the verifiable baseline. Memoized per resolved env
// value so the warning fires once (not per request) and stays deterministic.
let validatedDefault: { raw: string | undefined; value: string } | null = null;
export function defaultModel(): string {
  const raw = process.env.REDPILL_DEFAULT_MODEL;
  if (validatedDefault && validatedDefault.raw === raw) return validatedDefault.value;
  let value = DEFAULT_BASELINE_MODEL;
  if (raw) {
    if (raw.startsWith("phala/") && !isBlocklistedModel(raw)) {
      value = raw;
    } else {
      console.warn(
        `[chat] REDPILL_DEFAULT_MODEL="${raw}" is not a verifiable phala/* model; ` +
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
  /** The RedPill completion `id` (first chunk carries it). Used to bind the
   *  relay signature frame to this exact completion. */
  completionId: string | null = null;

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
      id?: unknown;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: Array<{ delta?: { content?: unknown } }>;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (this.completionId === null && typeof parsed.id === "string" && parsed.id) {
      this.completionId = parsed.id;
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

// ── Relay signature frame ─────────────────────────────────────────────────────
// The relay signs the bytes it forwarded so the browser can prove custody: every
// machine that touched this reply is an attested TEE and the rendered text is
// exactly what the attested relay received. NORMATIVE message format (plan
// "Hash preimage" / precedence rule 3 — do not deviate):
//
//   preimage  = concatenated choices[0].delta.content strings (UsageScanner.completionText)
//   hash      = sha256(preimage), lowercase hex
//   message   = `tinychat-relay-sign-v1:${completionId}:${model}:${hash}`
//   signature = account.signMessage(message)   // EIP-191, same key as the attestation
//
// reasoning_content deltas are NOT in the preimage (they are never rendered).

const RELAY_SIGN_PREFIX = "tinychat-relay-sign-v1";
const DONE_BYTES = new TextEncoder().encode("data: [DONE]");
const EMPTY_BYTES = new Uint8Array(0);

export interface RelaySignaturePayload {
  v: 1;
  completion_id: string;
  model: string;
  content_sha256: string;
  signature: Hex;
  address: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256 of `text` as lowercase hex (the relay-signature preimage hash). */
export async function relayContentSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

/** The exact EIP-191 message the relay signs (normative format). */
export function relaySignMessage(completionId: string, model: string, contentSha256: string): string {
  return `${RELAY_SIGN_PREFIX}:${completionId}:${model}:${contentSha256}`;
}

/**
 * Build the `data: {"tinychat_relay_signature":…}\n\n` SSE frame over the
 * forwarded completion text. Returns null when there is nothing to bind (no
 * completion id captured); signing errors propagate to the caller, which logs
 * and still terminates the stream (reply path is never gated on signing).
 */
export async function buildRelaySignatureFrame(opts: {
  account: PrivateKeyAccount;
  completionId: string | null;
  model: string;
  completionText: string;
}): Promise<string | null> {
  if (!opts.completionId) return null;
  const contentSha256 = await relayContentSha256(opts.completionText);
  const message = relaySignMessage(opts.completionId, opts.model, contentSha256);
  const signature = await opts.account.signMessage({ message });
  const payload: RelaySignaturePayload = {
    v: 1,
    completion_id: opts.completionId,
    model: opts.model,
    content_sha256: contentSha256,
    signature,
    address: opts.account.address,
  };
  return `data: ${JSON.stringify({ tinychat_relay_signature: payload })}\n\n`;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Length of the longest suffix of `buf` that is a proper prefix of `marker`. */
function suffixPrefixLen(buf: Uint8Array, marker: Uint8Array): number {
  const max = Math.min(buf.length, marker.length - 1);
  for (let k = max; k > 0; k--) {
    let match = true;
    for (let j = 0; j < k; j++) {
      if (buf[buf.length - k + j] !== marker[j]) {
        match = false;
        break;
      }
    }
    if (match) return k;
  }
  return 0;
}

/**
 * Byte-level splitter that forwards the upstream stream UNCHANGED except for
 * holding back the final `data: [DONE]` terminator line (hard constraint 6: the
 * only permitted mutation of the relayed bytes). It never forwards a partial
 * terminator prefix, so the terminator can straddle chunk boundaries safely.
 */
class DoneTerminator {
  private pending: Uint8Array = EMPTY_BYTES;
  sawDone = false;

  /** Feed an upstream chunk; return the bytes safe to forward to the client now. */
  push(chunk: Uint8Array): Uint8Array {
    if (this.sawDone) return EMPTY_BYTES; // nothing legitimate follows [DONE]
    const buf = concatBytes(this.pending, chunk);
    const idx = indexOfBytes(buf, DONE_BYTES);
    if (idx !== -1) {
      this.sawDone = true;
      this.pending = EMPTY_BYTES;
      return buf.subarray(0, idx);
    }
    const keep = suffixPrefixLen(buf, DONE_BYTES);
    this.pending = keep > 0 ? buf.subarray(buf.length - keep) : EMPTY_BYTES;
    return buf.subarray(0, buf.length - keep);
  }

  /** On clean end, flush any held-back bytes that turned out NOT to be the
   *  terminator (e.g. upstream ended without [DONE]). */
  flush(): Uint8Array {
    if (this.sawDone) return EMPTY_BYTES;
    const out = this.pending;
    this.pending = EMPTY_BYTES;
    return out;
  }
}

// ── Router factory ───────────────────────────────────────────────────────────

export function createChatRouter(config: { privateKey: string }) {
  const router = Router();
  // Memoized once per factory: the secp256k1 account whose address is bound into
  // the backend attestation quote (selfAttest.ts). Same key signs relay frames.
  const relayAccount = privateKeyToAccount(config.privateKey as Hex);

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
    // This is a confidential-inference product: only `phala/*` (TEE-attestable)
    // models are offered. GET /models filters to `phala/*` unconditionally, but a
    // direct POST bypasses that view — so mirror the filter here, BEFORE any
    // upstream fetch or billing, so a non-offered model can never be proxied even
    // when the paywall is off (the default deployment). Tier/credit gating stays
    // inside the paywall block below (ST2).
    if (!resolvedModel.startsWith("phala/")) {
      res.status(403).json({
        error: "model_not_offered",
        message: `Model ${resolvedModel} is not offered. Only verifiable phala/* models are available.`,
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

    // AbortController so we can cancel the upstream fetch if the client
    // disconnects. MUST NOT listen on the REQUEST "close" event: Bun's
    // node:http compat fires it as soon as the request body is consumed (not
    // on client disconnect), which aborted the upstream fetch mid-stream and
    // truncated every prod reply (no usage chunk, no relay frame, no [DONE]).
    // The response "close" with writableEnded=false is the correct signal on
    // Node; on Bun it may never fire for a mid-stream disconnect (probed:
    // req.destroyed is true while the client is still connected, res.destroyed
    // is undefined, socket.destroyed stays false), in which case a dropped
    // client just streams to a dead socket until the generation ends —
    // bounded waste, never a truncated reply.
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
    const terminator = new DoneTerminator();
    let cleanEnd = false;
    try {
      // Bun's fetch body is async-iterable. Forward every chunk byte-for-byte
      // (minus the held-back [DONE] terminator) while tee-ing a copy through the
      // usage scanner. NO awaits between an upstream chunk and its res.write —
      // the reply path is never gated on signing (hard constraint 1).
      for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
        if (controller.signal.aborted) break;
        scanner.push(chunk);
        const forward = terminator.push(chunk);
        if (forward.length > 0) res.write(forward);
      }
      cleanEnd = !controller.signal.aborted;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        // Client disconnected — clean exit
      } else {
        console.error("[chat] stream error:", error);
      }
    } finally {
      // On a CLEAN end: flush any non-terminator tail, emit the relay signature
      // frame, then the held-back [DONE]. On abort/error: end with NO frame so
      // the client treats the reply as unsigned (fail-honest, never a fabricated
      // signature). Signing failure is non-fatal — log and still forward [DONE].
      if (cleanEnd) {
        const tail = terminator.flush();
        if (tail.length > 0) res.write(tail);
        try {
          const frame = await buildRelaySignatureFrame({
            account: relayAccount,
            completionId: scanner.completionId,
            model: resolvedModel,
            completionText: scanner.completionText,
          });
          if (frame) res.write(frame);
        } catch (error) {
          console.error("[chat] relay signing failed:", error);
        }
        res.write("data: [DONE]\n\n");
      }
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
