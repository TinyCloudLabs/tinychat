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
import {
  getUsage,
  isOverBudget,
  recordUsage,
  startOfAnchoredWeek,
  startOfUtcDay,
} from "../billing/usage.js";
import { contextLengthFor, getCatalog, type CatalogModel } from "../billing/catalog.js";
import { truncateToolResults, trimConvoToBudget } from "../lib/contextGuard.js";
import { creditsFor, ratesForModel, type ModelRates } from "../billing/credits.js";
import type { LedgerFlusher } from "../billing/ledger-flusher.js";
import type { LedgerRehydrator } from "../billing/ledger-rehydrate.js";

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
  /** §E.6 — shadow-push outbox (disabled when absent). */
  flusher?: LedgerFlusher;
  /** §E.7 — lazy rehydrator (disabled when absent). */
  rehydrator?: LedgerRehydrator;
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

/**
 * Parse leaked native tool-call markup out of `delta.content`.
 *
 * Some RedPill backends (e.g. the GLM Chutes/Tinfoil backend behind
 * `phala/glm-5.1`) intermittently leak the model's native tool-call template into
 * `delta.content` as PLAIN TEXT instead of structured `delta.tool_calls`, e.g.:
 *
 *   <tool_call>web_search<arg_key>query</arg_key><arg_value>news today</arg_value></tool_call>
 *
 * When that happens our loop never sees `delta.tool_calls`, finishes `stop`, and
 * would stream the raw markup to the user as the "answer". This extracts every
 * `<tool_call>…</tool_call>` block so we can dispatch the real tool instead.
 *
 * For each block we capture the tool NAME (text right after `<tool_call>` up to the
 * first `<arg_key>`) and build a JSON args object from the (arg_key, arg_value)
 * pairs in order. Values are NOT JSON-escaped in the markup, so we JSON.stringify
 * the captured raw strings. `args` is returned as a JSON string to match the shape
 * `dispatchTool`/`accumulateToolCalls` already feed downstream.
 */
export function parseInlineToolCalls(content: string): Array<{ name: string; args: string }> {
  const calls: Array<{ name: string; args: string }> = [];
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const argRe = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(content)) !== null) {
    const inner = block[1];
    const firstArgKey = inner.indexOf("<arg_key>");
    const name = (firstArgKey === -1 ? inner : inner.slice(0, firstArgKey)).trim();
    if (!name) continue;
    const args: Record<string, string> = {};
    argRe.lastIndex = 0;
    let pair: RegExpExecArray | null;
    while ((pair = argRe.exec(inner)) !== null) {
      args[pair[1].trim()] = pair[2];
    }
    calls.push({ name, args: JSON.stringify(args) });
  }
  return calls;
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
 * Build the messages for a CLEAN SYNTHESIS request used on the forced final round.
 *
 * gpt-oss-* IGNORES `tool_choice:"none"` and keeps emitting structured `tool_calls`
 * every round, never synthesizing — so on the forced round we abandon the tool
 * conversation entirely and RESHAPE the gathered results into a plain user message
 * with NO `tools` array (see buildCleanSynthesisRequest), making it literally
 * impossible to re-call the tool. Dropping `tools[]` while keeping the `role:"tool"`
 * messages does NOT work (still empty) — the results must be inlined as user text.
 */
export function buildCleanSynthesisMessages(question: string, results: string): ChatMsg[] {
  return [
    {
      role: "system",
      content:
        "You are a helpful assistant. Answer the user's question using the web search results " +
        "provided below. Cite the source URLs. Do not ask to search again.",
    },
    {
      role: "user",
      content: `Question: ${question}\n\nWeb search results:\n${results}\n\nAnswer concisely, citing sources.`,
    },
  ];
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
  let args: Record<string, unknown>;
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
    result?: {
      text?: string;
      data?: { results?: Array<{ title?: string; url?: string; snippet?: string }> };
    };
    error?: string;
  };
  if (!res.ok) {
    return `(tool ${call.name} failed: ${body.error ?? res.status})`;
  }
  // Forward the one-line summary AND the structured results (title/url/snippet)
  // so the synthesis model can cite real source URLs. Returning only
  // `result.text` left every model without a URL — they then hallucinated
  // citations or honestly declined to cite (P4 failure, all models).
  const summary = body.result?.text ?? "";
  const results = body.result?.data?.results ?? [];
  if (results.length === 0) return summary;
  const sources = results
    .map((r, i) => {
      const parts = [`[${i + 1}] ${r.title ?? "(untitled)"}`];
      if (r.url) parts.push(`    URL: ${r.url}`);
      if (r.snippet) parts.push(`    ${r.snippet}`);
      return parts.join("\n");
    })
    .join("\n");
  return summary ? `${summary}\n\nSources:\n${sources}` : `Sources:\n${sources}`;
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
  let convo: ChatMsg[] = [...params.messages];
  // The original question, for the clean-synthesis forced round (last user message).
  const lastUserQuestion = [...params.messages].reverse().find((m) => m.role === "user")?.content ?? "";

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let finalCompletionId = "";

  for (let round = 0; round < maxRounds; round++) {
    if (params.isAborted?.()) break;

    // Deterministic context guard (§C.11, NO LLM): before this round's upstream
    // fetch, first cap oversize role:"tool" results, then drop the oldest
    // droppable messages until the growing convo fits the model's window. Never
    // drops system messages, the first user message, or the last user message.
    convo = trimConvoToBudget(truncateToolResults(convo), contextLengthFor(model));

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

    // On the forced final round, if tool results were already gathered, abandon the
    // tool conversation and issue a CLEAN SYNTHESIS request: gpt-oss-* ignores
    // tool_choice:"none" and keeps re-calling the tool, so we reshape the results
    // into a plain user message with NO tools[] — the model then cannot re-call and
    // produces a real cited answer. Only reshape when results exist; if the model
    // never searched, fall through to the normal (tool-enabled) request.
    const toolResults = convo.filter((m) => m.role === "tool");
    const cleanSynthesis = forceAnswer && toolResults.length > 0;

    const upstream = await fetchImpl(`${config.redpillBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.redpillApiKey}`,
      },
      body: JSON.stringify(
        cleanSynthesis
          ? {
              model,
              messages: buildCleanSynthesisMessages(
                lastUserQuestion,
                toolResults.map((m) => m.content).join("\n\n"),
              ),
              // NO tools / tool_choice — the model literally cannot emit a tool call.
              reasoning_effort: "low",
              stream: true,
              stream_options: { include_usage: true },
            }
          : {
              model,
              messages: convo,
              tools: [WEB_SEARCH_TOOL],
              tool_choice: forceAnswer ? "none" : "auto",
              ...(isSynthesisRound ? { reasoning_effort: "low" } : {}),
              stream: true,
              stream_options: { include_usage: true },
            },
      ),
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

    // Prefix-sniffing buffer for the leaked-markup guard. Leaked native tool-call
    // markup LEADS the content with `<tool_call` (possibly after whitespace), so we
    // hold the first content until we can decide leak-vs-normal: once the trimmed
    // run is long enough (or a `<`-led prefix is ruled out) we either flush it
    // (normal answer → stream normally thereafter) or swallow it (leak → never
    // forward, parse + dispatch on round end). A normal answer that merely MENTIONS
    // `<tool_call` later still streams fine — only a LEADING marker trips leakMode.
    const LEAK_PREFIX = "<tool_call";
    let roundContent = "";
    let pendingBuffer = "";
    let decided = false;
    let leakMode = false;

    const flushPending = () => {
      if (pendingBuffer) {
        write(contentFrame(pendingBuffer));
        pendingBuffer = "";
      }
    };

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
        roundContent += delta.content;
        if (leakMode) {
          // Already in leak mode: keep accumulating, forward nothing.
        } else if (decided) {
          write(contentFrame(delta.content));
        } else {
          pendingBuffer += delta.content;
          const trimmed = pendingBuffer.trimStart();
          if (trimmed.startsWith(LEAK_PREFIX)) {
            leakMode = true;
            decided = true;
            pendingBuffer = ""; // swallow — never forward leaked markup
          } else if (
            // Can rule out a leading marker once the trimmed prefix is long enough
            // to compare, or the first non-whitespace char clearly isn't `<`.
            trimmed.length >= LEAK_PREFIX.length ||
            (trimmed.length > 0 && !LEAK_PREFIX.startsWith(trimmed))
          ) {
            decided = true;
            flushPending();
          }
          // else: still ambiguous (e.g. just "<too") — keep buffering.
        }
      }
      if (Array.isArray(delta?.tool_calls)) {
        accumulateToolCalls(toolCalls, delta.tool_calls as Parameters<typeof accumulateToolCalls>[1]);
      }
      const fr = choice?.finish_reason;
      if (typeof fr === "string") finish = fr;
    }

    totalPromptTokens += roundPromptTokens;
    totalCompletionTokens += roundCompletionTokens;

    // Leaked-markup guard: if the round leaked native tool-call markup into content
    // (leakMode, or a `stop` finish whose content still contains a `<tool_call>`),
    // parse it and treat the result EXACTLY like structured tool calls so the
    // existing dispatch block below runs. We never forward the raw markup.
    if (toolCalls.size === 0 && (leakMode || (finish === "stop" && roundContent.includes("<tool_call>")))) {
      const inlineCalls = parseInlineToolCalls(roundContent);
      if (inlineCalls.length > 0) {
        inlineCalls.forEach((c, i) => {
          toolCalls.set(i, { id: `inline_${i}`, name: c.name, args: c.args });
        });
        finish = "tool_calls"; // run the existing structured-dispatch path below
      } else {
        // False alarm (markup-led but unparseable): don't silently drop the answer.
        flushPending();
      }
    } else if (!leakMode) {
      // Stream ended while still buffering an ambiguous-but-short prefix (e.g. the
      // entire answer was "<3"): not a leak, so flush what we held.
      flushPending();
    }

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
        message: `Model ${resolvedModel} is not offered. Only the curated verifiable models are available.`,
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

      // §E.7 — seed the in-memory counter from the durable ledger before gating.
      if (config.rehydrator) {
        const atLimit = await config.rehydrator.rehydrateIfNeeded(address, tierConfig, anchor);
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

      if (process.env.LEDGER_AUTHORITATIVE === "true" && config.rehydrator) {
        const { credit_limit, committed_credits, isOutage } = await config.rehydrator.getEntitlement(
          address, tierConfig, anchor,
        );
        const outagePolicy = process.env.LEDGER_OUTAGE_POLICY ?? "bounded_k";
        if (isOutage || credit_limit === null) {
          if (outagePolicy === "fail_closed") {
            const usage = getUsage(address, tierConfig, anchor);
            res.status(402).json({
              error: "credit_budget_exceeded",
              message: `Credit budget exhausted for the ${tierConfig.name} tier.`,
              tier,
              usage,
            });
            return;
          } else if (outagePolicy === "fail_open") {
            console.warn("[agent-chat] LEDGER_OUTAGE_POLICY=fail_open: serving without ledger enforcement");
          } else {
            // bounded_k: K guard already applied by rehydrateIfNeeded above; fall through to local path
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
          }
        } else if (committed_credits !== null && committed_credits >= credit_limit) {
          const usage = getUsage(address, tierConfig, anchor);
          res.status(402).json({
            error: "credit_budget_exceeded",
            message: `Credit budget exhausted for the ${tierConfig.name} tier.`,
            tier,
            usage,
          });
          return;
        }
      } else {
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

    // Abort on the RESPONSE close with writableEnded=false. The REQUEST "close"
    // event fires on Bun as soon as the request body is consumed (not on client
    // disconnect), which aborts the upstream mid-stream and truncates the reply.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

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
        // §E.6 — shadow-push to ledger (async, never blocks serving)
        if (config.flusher && credits > 0) {
          const now = Date.now();
          const tierCfg = TIERS[gatedTier];
          const ws =
            tierCfg.budgetWindow === "week"
              ? startOfAnchoredWeek(anchor ?? now, now)
              : startOfUtcDay(now);
          config.flusher.enqueue({
            account: address,
            window_start: ws,
            window_kind: tierCfg.budgetWindow === "week" ? "anchored_week" : "utc_day",
            credits,
            model: resolvedModel,
            prompt_tokens: orchestrateResult.promptTokens,
            completion_tokens: orchestrateResult.completionTokens,
            occurred_at: now,
            signed_token_count: null,
          });
        }
      } catch (error) {
        console.error("[agent-chat] failed to record post-stream usage:", error);
        try {
          const credits = creditsFor(
            FALLBACK_RECORDING_RATES,
            orchestrateResult.promptTokens,
            orchestrateResult.completionTokens,
          );
          recordUsage(address, TIERS[gatedTier], credits, anchor);
          if (config.flusher && credits > 0) {
            const now = Date.now();
            const tierCfg = TIERS[gatedTier];
            const ws =
              tierCfg.budgetWindow === "week"
                ? startOfAnchoredWeek(anchor ?? now, now)
                : startOfUtcDay(now);
            config.flusher.enqueue({
              account: address,
              window_start: ws,
              window_kind: tierCfg.budgetWindow === "week" ? "anchored_week" : "utc_day",
              credits,
              model: resolvedModel,
              prompt_tokens: orchestrateResult.promptTokens,
              completion_tokens: orchestrateResult.completionTokens,
              occurred_at: now,
              signed_token_count: null,
            });
          }
        } catch (fallbackError) {
          console.error("[agent-chat] fallback usage recording also failed:", fallbackError);
        }
      }
    }
  };
}
