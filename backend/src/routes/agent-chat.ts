// /api/agent/chat — tool-calling orchestration around the RedPill relay (Milestone E, §4).
//
// Integration model (DECIDED): RedPill stays the conversational responder; Eliza is
// the agent's TOOL layer. This route enables function-calling on the RedPill request;
// when the model emits a tool call, we dispatch it to eliza-service POST /tools/:name,
// feed the result back into the conversation, and let RedPill produce the final answer.
//
// The RedPill RELAY itself (routes/chat.ts) is UNCHANGED — this is the new orchestration
// LAYER the handoff calls for (§4.4): same upstream, plus tools + a bounded tool→result
// loop. SSE frames are re-emitted in OpenAI delta shape so the existing frontend
// consumer (lib/chatApi.ts streamChat) works unchanged; tool activity is surfaced on
// extra `tool_activity` frames the consumer safely ignores.

import type { Request, RequestHandler, Response } from "express";
import { TIERS, isModelAllowed, requiredTierForModel, type TierId } from "../billing/tiers.js";
import { paywallEnabled, resolveTier } from "../billing/stripe.js";
import { getUsage, isOverBudget, recordUsage } from "../billing/usage.js";
import { getCatalog, type CatalogModel } from "../billing/catalog.js";
import { creditsFor, ratesForModel, type ModelRates } from "../billing/credits.js";

// Conservative default rates for the post-stream recording fallback (mirrors chat.ts §7).
const FALLBACK_RECORDING_RATES: ModelRates = {
  creditsPerKInput: 200,
  creditsPerKOutput: 1000,
  fallback: true,
};

// Look up a model in the catalog and resolve its rates. Missing entries get the fallback.
// Duplicated from chat.ts (sanctioned — chat.ts must stay untouched).
function resolveRates(catalog: CatalogModel[], modelId: string): ModelRates {
  const entry = catalog.find((m) => m.id === modelId);
  return ratesForModel(entry ?? { id: modelId, pricing: null });
}

export interface ChatMsg {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface AgentChatConfig {
  agentId: string;
  entityIdFor: (address: string) => string;
  elizaServiceUrl: string;
  elizaServiceSecret: string;
  redpillApiKey: string;
  redpillBaseUrl: string;
  /** Resolve the default model when the request omits one. */
  defaultModel: () => string;
  /** True when the model may be proxied (phala/* and not blocklisted). */
  isModelOffered: (model: string) => boolean;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Max tool→result rounds before forcing a final answer (default 3). */
  maxRounds?: number;
}

// The single tool exposed for the first cut. OpenAI function-calling schema.
export const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the public web for current events, facts, and anything outside the model's knowledge. " +
      "Returns a concise summary plus source links.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
  },
} as const;

interface AccumulatedToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Accumulate OpenAI streamed tool_call deltas (keyed by index; id/name arrive once,
 * arguments arrive in fragments to be concatenated).
 */
export function accumulateToolCalls(
  acc: Map<number, AccumulatedToolCall>,
  deltas: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>,
): void {
  for (const d of deltas) {
    const index = d.index ?? 0;
    const entry = acc.get(index) ?? { id: "", name: "", args: "" };
    if (d.id) entry.id = d.id;
    if (d.function?.name) entry.name = d.function.name;
    if (d.function?.arguments) entry.args += d.function.arguments;
    acc.set(index, entry);
  }
}

/** Parse an SSE byte stream into successive JSON `data:` payloads ([DONE] ends it). */
export async function* parseSseJson(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const rawLine of frame.split("\n")) {
        const line = rawLine.trimStart();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // ignore malformed frame
        }
      }
    }
  }
}

function contentFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function toolActivityFrame(name: string, status: "running" | "done" | "error"): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {} }], tool_activity: { name, status } })}\n\n`;
}

/** Emit the final answer round's completion id before the usage frame and [DONE]. */
export function idFrame(id: string): string {
  return `data: ${JSON.stringify({ id })}\n\n`;
}

/** Emit a summed usage frame covering all rounds in the tool-calling loop. */
export function usageFrame(promptTokens: number, completionTokens: number): string {
  return `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } })}\n\n`;
}

/**
 * Dispatch one tool call to eliza-service POST /tools/:name and return its result text.
 * web_search needs no delegation; entityId/roomId are passed for tools that do.
 */
async function dispatchTool(
  config: AgentChatConfig,
  fetchImpl: typeof fetch,
  call: AccumulatedToolCall,
  entityId: string,
  roomId: string | undefined,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
  } catch {
    args = { query: call.args };
  }
  const res = await fetchImpl(`${config.elizaServiceUrl}/tools/${encodeURIComponent(call.name)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.elizaServiceSecret}`,
    },
    body: JSON.stringify({ args, entityId, ...(roomId ? { roomId } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    result?: { text?: string };
    error?: string;
  };
  if (!res.ok) {
    return `(tool ${call.name} failed: ${body.error ?? res.status})`;
  }
  return body.result?.text ?? "";
}

export interface OrchestrateParams {
  config: AgentChatConfig;
  model: string;
  messages: ChatMsg[];
  entityId: string;
  roomId?: string;
  write: (frame: string) => void;
  isAborted?: () => boolean;
}

export interface OrchestrateResult {
  promptTokens: number;
  completionTokens: number;
  completionId: string;
}

/**
 * Run the bounded tool-calling loop. Streams assistant content frames as they arrive;
 * on a tool_calls finish, dispatches each tool, appends results, and loops for the
 * model's final answer. Emits idFrame + usageFrame (summed across all rounds) before
 * the terminating `data: [DONE]` frame, satisfying the billing superset invariant.
 */
export async function orchestrateToolCalling(params: OrchestrateParams): Promise<OrchestrateResult> {
  const { config, model, write } = params;
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxRounds = config.maxRounds ?? 3;
  const convo: ChatMsg[] = [...params.messages];

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let finalCompletionId = "";

  for (let round = 0; round < maxRounds; round++) {
    if (params.isAborted?.()) break;

    // On the final allowed round, force a text answer (tool_choice "none"): some
    // models (e.g. phala/gpt-oss-*) will otherwise keep calling the tool every
    // round and exhaust maxRounds without ever emitting a content answer, leaving
    // the user with an empty reply. "none" makes the model summarize the tool
    // results it already has into a final answer.
    const forceAnswer = round === maxRounds - 1;

    // Synthesis rounds (round > 0 means a tool was already dispatched, so convo now
    // holds a role:"tool" result) need reasoning_effort:"low": harmony reasoning models
    // (phala/gpt-oss-*) otherwise answer in the `analysis` channel (reasoning_content)
    // and leave `content` empty whenever a role:"tool" message is present, rendering a
    // blank reply. "low" forces an immediate transition to the final/content channel.
    const isSynthesisRound = round > 0;

    const upstream = await fetchImpl(`${config.redpillBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.redpillApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: convo,
        tools: [WEB_SEARCH_TOOL],
        tool_choice: forceAnswer ? "none" : "auto",
        ...(isSynthesisRound ? { reasoning_effort: "low" } : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    if (!upstream.ok || !upstream.body) {
      write(contentFrame(`(upstream error ${upstream.status})`));
      break;
    }

    const toolCalls = new Map<number, AccumulatedToolCall>();
    let finish: string | null = null;
    let currentRoundId = "";
    let roundPromptTokens = 0;
    let roundCompletionTokens = 0;

    for await (const obj of parseSseJson(upstream.body as unknown as AsyncIterable<Uint8Array>)) {
      if (typeof obj.id === "string" && obj.id) currentRoundId = obj.id;
      const usage = obj.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (usage) {
        // RedPill sends a single cumulative usage frame at end of each completion; overwrite.
        if (typeof usage.prompt_tokens === "number") roundPromptTokens = usage.prompt_tokens;
        if (typeof usage.completion_tokens === "number") roundCompletionTokens = usage.completion_tokens;
      }
      const choice = (obj.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const delta = choice?.delta as
        | { content?: string; tool_calls?: Array<Record<string, unknown>> }
        | undefined;
      if (typeof delta?.content === "string" && delta.content) {
        write(contentFrame(delta.content));
      }
      if (Array.isArray(delta?.tool_calls)) {
        accumulateToolCalls(toolCalls, delta.tool_calls as Parameters<typeof accumulateToolCalls>[1]);
      }
      const fr = choice?.finish_reason;
      if (typeof fr === "string") finish = fr;
    }

    totalPromptTokens += roundPromptTokens;
    totalCompletionTokens += roundCompletionTokens;

    if (finish === "tool_calls" && toolCalls.size > 0) {
      const calls = [...toolCalls.values()];
      convo.push({
        role: "assistant",
        content: "",
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args },
        })),
      });
      for (const call of calls) {
        write(toolActivityFrame(call.name, "running"));
        let text: string;
        try {
          text = await dispatchTool(config, fetchImpl, call, params.entityId, params.roomId);
          write(toolActivityFrame(call.name, "done"));
        } catch {
          text = `(tool ${call.name} unreachable)`;
          write(toolActivityFrame(call.name, "error"));
        }
        convo.push({ role: "tool", tool_call_id: call.id, content: text });
      }
      continue; // loop for the model's answer using the tool results
    }

    finalCompletionId = currentRoundId;
    break; // finish_reason "stop" (or no tools) — content already streamed
  }

  // A1: emit the final answer round's completion id (once, before usage + [DONE]).
  if (finalCompletionId) {
    write(idFrame(finalCompletionId));
  }
  // A2: emit a single summed usage frame covering all rounds.
  write(usageFrame(totalPromptTokens, totalCompletionTokens));
  write("data: [DONE]\n\n");

  return { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, completionId: finalCompletionId };
}

export function createAgentChatHandler(config: AgentChatConfig): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: "unauthenticated", message: "Authentication required" });
      return;
    }

    const { model, messages, roomId } = (req.body ?? {}) as {
      model?: unknown;
      messages?: unknown;
      roomId?: unknown;
    };

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: "invalid_body",
        message: "messages must be a non-empty array of {role, content} objects.",
      });
      return;
    }
    if (roomId !== undefined && typeof roomId !== "string") {
      res.status(400).json({ error: "invalid_body", message: "roomId must be a string" });
      return;
    }

    const resolvedModel = typeof model === "string" && model.trim() ? model : config.defaultModel();
    if (!config.isModelOffered(resolvedModel)) {
      res.status(403).json({
        error: "model_not_offered",
        message: `Model ${resolvedModel} is not offered. Only verifiable phala/* models are available.`,
      });
      return;
    }

    // A4: paywall gate — mirrors chat.ts:212-264. Must run BEFORE flushHeaders.
    const address = req.user.address ?? "";
    let gatedTier: TierId = "free";
    let anchor: number | null = null;
    let rates: ModelRates | null = null;
    if (paywallEnabled()) {
      let resolution;
      try {
        resolution = await resolveTier(address);
      } catch (error) {
        console.error("[agent-chat] failed to resolve subscription tier:", error);
        res.status(500).json({ error: "internal_error", message: "Failed to resolve subscription tier" });
        return;
      }
      const tier = resolution.tier;
      gatedTier = tier;
      anchor = resolution.subscription?.anchor ? Date.parse(resolution.subscription.anchor) : null;
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

      try {
        const catalog = await getCatalog();
        rates = resolveRates(catalog, resolvedModel);
      } catch (error) {
        console.error("[agent-chat] failed to resolve model rates:", error);
        res.status(500).json({ error: "internal_error", message: "Failed to resolve model rates" });
        return;
      }
    }

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let orchestrateResult: OrchestrateResult | null = null;
    try {
      orchestrateResult = await orchestrateToolCalling({
        config,
        model: resolvedModel,
        messages: messages as ChatMsg[],
        entityId: config.entityIdFor(req.user.address),
        roomId: typeof roomId === "string" ? roomId : undefined,
        write: (frame) => res.write(frame),
        isAborted: () => controller.signal.aborted,
      });
    } catch (error) {
      console.error("[agent-chat] orchestration error:", error);
      // Stream already open; surface a terminal content frame instead of a status code.
      res.write(contentFrame("(agent error)"));
      res.write("data: [DONE]\n\n");
    } finally {
      res.end();
    }

    // A4: post-stream usage recording — mirrors chat.ts:335-372.
    // NEVER throw after bytes were served. Falls back to conservative rates on any failure.
    if (paywallEnabled() && address && orchestrateResult) {
      try {
        const effectiveRates = rates ?? FALLBACK_RECORDING_RATES;
        const credits = creditsFor(
          effectiveRates,
          orchestrateResult.promptTokens,
          orchestrateResult.completionTokens,
        );
        recordUsage(address, TIERS[gatedTier], credits, anchor);
      } catch (error) {
        console.error("[agent-chat] failed to record post-stream usage:", error);
        try {
          const credits = creditsFor(
            FALLBACK_RECORDING_RATES,
            orchestrateResult.promptTokens,
            orchestrateResult.completionTokens,
          );
          recordUsage(address, TIERS[gatedTier], credits, anchor);
        } catch (fallbackError) {
          console.error("[agent-chat] fallback usage recording also failed:", fallbackError);
        }
      }
    }
  };
}
