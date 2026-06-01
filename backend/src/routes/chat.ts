import { Router } from "express";
import type { Request, Response } from "express";

// ── RedPill config ───────────────────────────────────────────────────────────
// REDPILL_API_KEY is required at call time. Missing key returns 500 per-request
// so the server boots cleanly even without a key configured.

const REDPILL_BASE_URL = process.env.REDPILL_BASE_URL ?? "https://api.redpill.ai/v1";
const REDPILL_DEFAULT_MODEL = process.env.REDPILL_DEFAULT_MODEL ?? "openai/gpt-5-mini";

if (!process.env.REDPILL_API_KEY) {
  console.warn(
    "[chat] REDPILL_API_KEY is not set. POST /api/chat will return 500 until it is configured.",
  );
}

// ── In-memory model cache ────────────────────────────────────────────────────

interface ModelsCacheEntry {
  models: Array<{ id: string }>;
  fetchedAt: number;
}

let modelsCache: ModelsCacheEntry | null = null;
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Helpers ──────────────────────────────────────────────────────────────────

function handleRouteError(res: Response, error: unknown, operation: string): void {
  console.error(`[chat] failed to ${operation}:`, error);
  res.status(500).json({ error: "internal_error", message: `Failed to ${operation}` });
}

// ── Router factory ───────────────────────────────────────────────────────────

export function createChatRouter() {
  const router = Router();

  /**
   * POST /
   * Auth-protected streaming proxy to RedPill chat/completions.
   * Body: { model?: string, messages: Array<{role, content}> }
   * Response: text/event-stream SSE forwarded straight from RedPill.
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

    const resolvedModel = typeof model === "string" && model.trim() ? model : REDPILL_DEFAULT_MODEL;

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
        body: JSON.stringify({ model: resolvedModel, messages, stream: true }),
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

    try {
      // Bun's fetch body is async-iterable
      for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
        if (controller.signal.aborted) break;
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
  });

  /**
   * GET /models
   * Auth-protected. Returns { models: Array<{ id: string }> }.
   * Cached in-memory for 5 minutes.
   */
  router.get("/models", async (_req: Request, res: Response) => {
    const apiKey = process.env.REDPILL_API_KEY;
    if (!apiKey) {
      res
        .status(500)
        .json({ error: "no_api_key", message: "REDPILL_API_KEY is not configured on this server." });
      return;
    }

    // Return cache if fresh
    if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
      res.json({ models: modelsCache.models });
      return;
    }

    let upstreamRes: globalThis.Response;
    try {
      upstreamRes = await fetch(`${REDPILL_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (error) {
      handleRouteError(res, error, "fetch models");
      return;
    }

    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text().catch(() => "");
      res.status(502).json({
        error: "upstream_error",
        message: `RedPill models endpoint returned ${upstreamRes.status}: ${errBody || upstreamRes.statusText}`,
      });
      return;
    }

    let data: unknown;
    try {
      data = await upstreamRes.json();
    } catch (error) {
      handleRouteError(res, error, "parse models response");
      return;
    }

    const raw = (data as { data?: Array<{ id: string }> }).data ?? [];
    const models = raw.map((m) => ({ id: m.id }));

    modelsCache = { models, fetchedAt: Date.now() };
    res.json({ models });
  });

  return router;
}
