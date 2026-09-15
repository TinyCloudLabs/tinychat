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
import type { MeetingTurnInput, MeetingResult } from "@tinyboilerplate/core";
import {
  prepareGeneralMessages,
  validCheckpointMetadata,
  type GeneralPreparation,
} from "../transcripts/general-preparation.js";
import {
  validateAgentStreamPolicy,
  type AgentStreamPolicy,
} from "../agent-stream-policy.js";
import {
  runMeetingTurn,
  type BufferedMeetingModelResult,
  type MeetingModelRequest,
  type MeetingToolContext,
  type MeetingProviderAdmission,
} from "../transcripts/meeting-turn.js";
import { parseMeetingToolData } from "../transcripts/meeting-evidence.js";
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
import {
  contextLengthFor,
  getCatalog,
  type CatalogModel,
} from "../billing/catalog.js";
import { truncateToolResults, trimConvoToBudget } from "../lib/contextGuard.js";
import {
  creditsFor,
  ratesForModel,
  type ModelRates,
} from "../billing/credits.js";
import type { LedgerFlusher } from "../billing/ledger-flusher.js";
import type { LedgerRehydrator } from "../billing/ledger-rehydrate.js";
import {
  evaluateLedgerGate,
  evaluateKDegradePolicy,
  exposeGateSource,
  hasMissingWeeklyLedgerAnchor,
  logCreditGateDeny,
} from "../billing/ledger-gate.js";

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
  id?: string;
  private?: boolean;
}

export interface AgentChatConfig {
  agentId: string;
  streamPolicy: AgentStreamPolicy;
  streamRuntime?: AgentStreamRuntime;
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
  meetingProvider?: MeetingProviderAdmission;
  backendRevision?: string;
  meetingTrace?: (trace: Record<string, unknown>) => void;
  /** §E.6 — shadow-push outbox (disabled when absent). */
  flusher?: LedgerFlusher;
  /** §E.7 — lazy rehydrator (disabled when absent). */
  rehydrator?: LedgerRehydrator;
}

export interface AgentTurnContext {
  /** User-local calendar day supplied by the authenticated browser. */
  localDate: string;
  /** IANA time-zone name used to derive localDate. */
  timeZone: string;
}

// Public-web search remains separate from the fixed private-meeting toolkit.
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

/** Providers can use null for omitted continuation fields; indexes still must be valid. */
function normalizeToolCallDeltas(
  deltas: unknown[],
): Parameters<typeof accumulateToolCalls>[1] {
  return deltas.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new StreamFailure("upstream_incomplete");
    const call = value as Record<string, unknown>;
    if (
      call.index !== undefined &&
      (typeof call.index !== "number" ||
        !Number.isSafeInteger(call.index) ||
        call.index < 0)
    )
      throw new StreamFailure("upstream_incomplete");
    if (call.id != null && typeof call.id !== "string")
      throw new StreamFailure("upstream_incomplete");
    if (
      call.function != null &&
      (typeof call.function !== "object" || Array.isArray(call.function))
    )
      throw new StreamFailure("upstream_incomplete");
    const fn = call.function as Record<string, unknown> | null | undefined;
    if (
      (fn?.name != null && typeof fn.name !== "string") ||
      (fn?.arguments != null && typeof fn.arguments !== "string")
    )
      throw new StreamFailure("upstream_incomplete");
    return {
      ...(typeof call.index === "number" ? { index: call.index } : {}),
      ...(typeof call.id === "string" ? { id: call.id } : {}),
      ...(fn
        ? {
            function: {
              ...(typeof fn.name === "string" ? { name: fn.name } : {}),
              ...(typeof fn.arguments === "string"
                ? { arguments: fn.arguments }
                : {}),
            },
          }
        : {}),
    };
  });
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
export function parseInlineToolCalls(
  content: string,
): Array<{ name: string; args: string }> {
  const calls: Array<{ name: string; args: string }> = [];
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const argRe =
    /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(content)) !== null) {
    const inner = block[1];
    const firstArgKey = inner.indexOf("<arg_key>");
    const name = (
      firstArgKey === -1 ? inner : inner.slice(0, firstArgKey)
    ).trim();
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

/** Parse provider LF SSE; only its explicit protocol terminal completes a round. */
export async function* parseSseJson(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options: { maxBytes?: number; strictUtf8?: boolean } = {},
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  throwIfAborted(signal);
  const reader = "getReader" in body ? body.getReader() : undefined;
  const iterator = reader
    ? undefined
    : (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    ignoreCleanup(() => (reader ? reader.cancel() : iterator?.return?.()));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", {
    fatal: options.strictUtf8 === true,
  });
  let receivedBytes = 0;
  let buffer = "";
  try {
    for (;;) {
      throwIfAborted(signal);
      let chunk:
        | ReadableStreamReadResult<Uint8Array>
        | IteratorResult<Uint8Array>;
      try {
        chunk = await withAbort(
          reader ? reader.read() : iterator!.next(),
          signal,
        );
      } catch (error) {
        throwIfAborted(signal);
        throw error instanceof StreamFailure
          ? error
          : new StreamFailure("upstream_failed");
      }
      throwIfAborted(signal);
      if (chunk.done) throw new StreamFailure("upstream_incomplete");
      receivedBytes += chunk.value.byteLength;
      if (options.maxBytes !== undefined && receivedBytes > options.maxBytes)
        throw new StreamFailure("result_size_limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const rawLine of frame.split("\n")) {
          const line = rawLine.trimStart();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          if (!data) continue;
          let value: unknown;
          try {
            value = JSON.parse(data);
          } catch {
            throw new StreamFailure("upstream_incomplete");
          }
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new StreamFailure("upstream_incomplete");
          if ("error" in value) throw new StreamFailure("upstream_failed");
          yield value as Record<string, unknown>;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        /* A noncompliant cancellation cannot hold the turn. */
      }
    }
  }
}

function contentFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function toolActivityFrame(
  name: string,
  status: "running" | "done" | "error",
  id?: string,
): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {} }], tool_activity: { name, status, ...(id ? { id } : {}) } })}\n\n`;
}

/** Tell the browser that private-agent access needs an interactive re-grant. */
function delegationErrorFrame(code: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {} }], delegation_error: { code } })}\n\n`;
}

/** Emit the final answer round's completion id before the usage frame and [DONE]. */
export function idFrame(id: string): string {
  return `data: ${JSON.stringify({ id })}\n\n`;
}

/** Emit a summed usage frame covering all rounds in the tool-calling loop. */
export function usageFrame(
  promptTokens: number,
  completionTokens: number,
): string {
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
/** Stable eliza-service codes meaning "this user's grant is missing or unusable". */
const DELEGATION_ERROR_CODES = new Set([
  "delegation_required",
  "delegation_expired",
  "delegation_revoked",
]);

export interface ToolDispatchOutcome {
  /** The role:"tool" content handed back to the model. */
  text: string;
  /** Drives the tool_activity frame the browser renders. */
  status: "done" | "error";
  /** Set only for a delegation failure the user must act on. */
  code?: string;
  data?: NonNullable<ReturnType<typeof parseMeetingToolData>>;
}

/**
 * Dispatch one tool call to eliza-service POST /tools/:name and return its result.
 * web_search needs no delegation; entityId/roomId are passed for tools that do.
 */
async function dispatchTool(
  config: AgentChatConfig,
  fetchImpl: typeof fetch,
  call: AccumulatedToolCall,
  entityId: string,
  roomId: string | undefined,
  turnContext?: AgentTurnContext | MeetingToolContext,
  signal?: AbortSignal,
  allowedTools?: readonly string[],
): Promise<ToolDispatchOutcome> {
  if (allowedTools && !allowedTools.includes(call.name))
    throw new StreamFailure("routing_mismatch");
  let args: Record<string, unknown>;
  try {
    args = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
  } catch {
    throw new StreamFailure("upstream_incomplete");
  }
  throwIfAborted(signal);
  const res = await fetchForTurn(
    fetchImpl,
    `${config.elizaServiceUrl}/tools/${encodeURIComponent(call.name)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.elizaServiceSecret}`,
      },
      body: JSON.stringify({
        args,
        entityId,
        ...(roomId ? { roomId } : {}),
        ...(turnContext ? { context: turnContext } : {}),
      }),
    },
    signal,
  );
  // Own the JSON reader so cancellation can release a pending body read, even
  // when a supplied fetch implementation does not wire its response to signal.
  const reader = res.body?.getReader();
  const maxBytes =
    turnContext && "retrievalMode" in turnContext ? 2097152 : 65536;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (reader) ignoreCleanup(() => reader.cancel());
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let parsed: unknown;
  try {
    if (reader) {
      const decoder = new TextDecoder("utf-8", {
        fatal: !!turnContext && "retrievalMode" in turnContext,
      });
      let json = "";
      let bytes = 0;
      for (;;) {
        throwIfAborted(signal);
        const chunk = await withAbort(reader.read(), signal);
        throwIfAborted(signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        json += decoder.decode(chunk.value, { stream: true });
        if (bytes > maxBytes) {
          cancel();
          throw new StreamFailure("result_size_limit");
        }
      }
      json += decoder.decode();
      if (new TextEncoder().encode(json).length > maxBytes)
        throw new StreamFailure("result_size_limit");
      parsed = JSON.parse(json);
    } else {
      parsed = await withAbort(res.json(), signal);
      if (new TextEncoder().encode(JSON.stringify(parsed)).length > maxBytes)
        throw new StreamFailure("result_size_limit");
    }
    throwIfAborted(signal);
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof StreamFailure) throw error;
    parsed = {};
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        /* Preserve the turn outcome. */
      }
    }
  }
  const body = parsed as {
    result?: {
      text?: string;
      data?: Record<string, unknown>;
    };
    error?: string;
  };
  if (!res.ok) {
    const code =
      typeof body.error === "string" ? body.error : String(res.status);
    if (DELEGATION_ERROR_CODES.has(code)) {
      // The user has not granted (or has revoked/expired) transcript access.
      // Say so explicitly instead of letting the model quietly substitute a web
      // search, which would make the delegated path look healthy when it is not.
      return {
        status: "error",
        code,
        text:
          `(tool ${call.name} could not run: ${code}. The user has not granted this agent access ` +
          "to their private TinyCloud transcripts, or that access has expired. Tell the user you " +
          "cannot read their transcripts and that they need to reconnect transcript access. Do NOT " +
          "answer from a web search, from memory, or from any other source, and do not guess.",
      };
    }
    return {
      status: "error",
      code,
      text: `(tool ${call.name} failed: ${code})`,
    };
  }
  // Forward the one-line summary and the structured result. Tool output is
  // intentionally generic: transcript citations are not web URLs, and future
  // fixed-policy tools must not require dispatcher changes to reach synthesis.
  const summary = body.result?.text ?? "";
  if (call.name !== "web_search") {
    const typed = parseMeetingToolData(body.result?.data);
    return typed
      ? { status: "done", text: "", data: typed }
      : { status: "error", text: "", code: "upgrade_required" };
  }

  const results =
    (body.result?.data?.results as
      | Array<{ title?: string; url?: string; snippet?: string }>
      | undefined) ?? [];
  if (results.length === 0) return { status: "done", text: summary };
  const sources = results
    .map((r, i) => {
      const parts = [`[${i + 1}] ${r.title ?? "(untitled)"}`];
      if (r.url) parts.push(`    URL: ${r.url}`);
      if (r.snippet) parts.push(`    ${r.snippet}`);
      return parts.join("\n");
    })
    .join("\n");
  return {
    status: "done",
    text: summary
      ? `${summary}\n\nSources:\n${sources}`
      : `Sources:\n${sources}`,
  };
}

export interface OrchestrateParams {
  config: AgentChatConfig;
  model: string;
  messages: ChatMsg[];
  entityId: string;
  roomId?: string;
  turnContext?: AgentTurnContext;
  write: (frame: string) => unknown | Promise<unknown>;
  signal?: AbortSignal;
  onPhase?: (phase: StreamPhase) => void;
  isAborted?: () => boolean;
  turn?: MeetingTurnInput;
  publicTools?: boolean;
  preparation?: GeneralPreparation;
  /** Remaining time on the existing SSE owner's deadline. */
  remainingMs?: () => number;
}

export interface OrchestrateResult {
  promptTokens: number;
  completionTokens: number;
  completionId: string;
  meetingResult?: MeetingResult;
  checkpoint?: { coversThroughMessageId: string; summary: string };
  /** Nonthrowing failures retain completed-round accounting eligibility. */
  errorCode?: StreamErrorCode;
}

/**
 * Run the bounded tool-calling loop. Streams assistant content frames as they arrive;
 * on a tool_calls finish, dispatches each tool, appends results, and loops for the
 * model's final answer. Returns final ID and summed usage to the lifecycle owner,
 * which alone writes terminal metadata and the protocol terminal.
 */
export async function orchestrateToolCalling(
  params: OrchestrateParams,
): Promise<OrchestrateResult> {
  const fetchImpl = params.config.fetchImpl ?? fetch;
  return runMeetingTurn({
    ...params,
    contextWindowTokens: contextLengthFor(params.model),
    streamErrorCode: (error) =>
      error instanceof StreamFailure ? error.code : undefined,
    modelCall: (request) => bufferedMeetingModelCall(params, request),
    dispatch: (name, args, context, signal, id) =>
      dispatchTool(
        params.config,
        fetchImpl,
        { name, args: JSON.stringify(args), id: id ?? crypto.randomUUID() },
        params.entityId,
        params.roomId,
        context,
        signal,
      ),
    capability: async (signal) => {
      if (!params.config.elizaServiceUrl || !params.config.elizaServiceSecret)
        return null;
      const response = await fetchForTurn(
        fetchImpl,
        `${params.config.elizaServiceUrl}/capabilities`,
        {
          headers: {
            authorization: `Bearer ${params.config.elizaServiceSecret}`,
          },
        },
        signal,
      );
      if (!response.ok) {
        if (response.body) ignoreCleanup(() => response.body!.cancel());
        return null;
      }
      // This content-free response has a small independent transport bound.
      const reader = response.body?.getReader();
      if (!reader) return null;
      let bytes = 0;
      let text = "";
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await withAbort(reader.read(), signal);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 4096) return null;
          text += decoder.decode(chunk.value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
      } finally {
        ignoreCleanup(() => reader.cancel());
        try {
          reader.releaseLock();
        } catch {
          /* Preserve the capability outcome. */
        }
      }
    },
    runGeneral: (maxRounds) =>
      orchestrateExistingLoop({
        ...params,
        config: {
          ...params.config,
          maxRounds: Math.min(params.config.maxRounds ?? 3, maxRounds),
        },
      }),
    contentFrame,
    toolActivityFrame,
    delegationErrorFrame,
  });
}

export async function bufferedMeetingModelCall(
  params: OrchestrateParams,
  request: MeetingModelRequest,
): Promise<BufferedMeetingModelResult> {
  params.onPhase?.(request.phase);
  const privateCall =
    request.phase === "synthesis" || request.phase === "repair";
  const safeTokens = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  let expectedPromptTokens: number | undefined;
  if (privateCall) {
    const provider = params.config.meetingProvider;
    if (!provider?.admitted || provider.model !== params.model)
      throw Object.assign(new Error("provider_not_admitted"), {
        transient: false,
      });
    expectedPromptTokens = await withAbort(
      Promise.resolve(provider.countInputTokens(request.messages)),
      request.signal,
    );
    if (!safeTokens(expectedPromptTokens))
      throw Object.assign(new Error("provider_token_accounting_invalid"), {
        transient: false,
      });
  }
  let upstream: globalThis.Response;
  try {
    upstream = await fetchForTurn(
      params.config.fetchImpl ?? fetch,
      `${params.config.redpillBaseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.config.redpillApiKey}`,
        },
        body: JSON.stringify({
          model: params.model,
          messages: request.messages,
          reasoning_effort: "low",
          max_tokens: request.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
      },
      request.signal,
    );
  } catch {
    throwIfAborted(request.signal);
    throw Object.assign(new Error("provider_network"), { transient: true });
  }
  if (!upstream.ok || !upstream.body) {
    if (upstream.body) ignoreCleanup(() => upstream.body!.cancel());
    throw Object.assign(new Error("provider_failed"), {
      status: upstream.status,
      requestId: upstream.headers.get("x-request-id") ?? undefined,
      transient: upstream.status === 429 || upstream.status >= 500,
    });
  }
  let content = "",
    completionId = "",
    promptTokens = 0,
    completionTokens = 0,
    finishReason: string | undefined;
  let knownPromptTokens = false,
    knownCompletionTokens = false,
    finalUsage = false,
    invalidUsage = false;
  const accountingFailure = (code: string) =>
    Object.assign(new Error(code), {
      transient: false,
      status: upstream.status,
      requestId: upstream.headers.get("x-request-id") ?? undefined,
      promptTokens: knownPromptTokens ? promptTokens : undefined,
      completionTokens: knownCompletionTokens ? completionTokens : undefined,
    });
  const calls: Array<{ name: string; args: string }> = [];
  for await (const obj of parseSseJson(upstream.body, request.signal, {
    maxBytes: 2097152,
    strictUtf8: true,
  })) {
    if (typeof obj.id === "string") completionId = obj.id;
    const usage = obj.usage as
      | { prompt_tokens?: unknown; completion_tokens?: unknown }
      | null
      | undefined;
    if (privateCall) {
      // OpenAI-compatible streams may use usage:null on intermediate chunks.
      // The final parsed frame must provide both complete counters.
      finalUsage = false;
      if (usage != null) {
        const promptValid = safeTokens(usage.prompt_tokens);
        const completionValid = safeTokens(usage.completion_tokens);
        if (promptValid) {
          promptTokens = usage.prompt_tokens as number;
          knownPromptTokens = true;
        }
        if (completionValid) {
          completionTokens = usage.completion_tokens as number;
          knownCompletionTokens = true;
        }
        finalUsage = promptValid && completionValid;
        if (!finalUsage) invalidUsage = true;
      }
    } else {
      if (typeof usage?.prompt_tokens === "number")
        promptTokens = usage.prompt_tokens;
      if (typeof usage?.completion_tokens === "number")
        completionTokens = usage.completion_tokens;
    }
    if (obj.choices != null && !Array.isArray(obj.choices))
      throw new StreamFailure("upstream_incomplete");
    const choice = (
      obj.choices as
        | Array<{
            delta?: { content?: unknown; tool_calls?: unknown };
            finish_reason?: unknown;
          }>
        | undefined
    )?.[0];
    if (
      choice?.delta?.content != null &&
      typeof choice.delta.content !== "string"
    )
      throw new StreamFailure("upstream_incomplete");
    if (typeof choice?.delta?.content === "string")
      content += choice.delta.content;
    if (choice?.delta?.tool_calls != null)
      calls.push({ name: "unexpected_tool", args: "" });
    if (typeof choice?.finish_reason === "string")
      finishReason = choice.finish_reason;
    if (new TextEncoder().encode(content).length > 131072)
      throw new StreamFailure("result_size_limit");
  }
  if (privateCall) {
    if (!finalUsage || invalidUsage)
      throw accountingFailure("provider_usage_invalid");
    if (promptTokens !== expectedPromptTokens)
      throw accountingFailure("provider_token_accounting_mismatch");
  }
  return {
    content,
    calls,
    complete: finishReason === "stop",
    finishReason,
    completionId,
    promptTokens,
    completionTokens,
  };
}

async function orchestrateExistingLoop(
  params: OrchestrateParams,
): Promise<OrchestrateResult> {
  const { config, model, write } = params;
  const fetchImpl = config.fetchImpl ?? fetch;
  const prepared = await prepareGeneralMessages(params, (request) =>
    bufferedMeetingModelCall(params, request),
  );
  const total: OrchestrateResult = {
    promptTokens: prepared.promptTokens,
    completionTokens: prepared.completionTokens,
    completionId: "",
    ...(prepared.checkpoint ? { checkpoint: prepared.checkpoint } : {}),
  };
  let convo: ChatMsg[] = [
    {
      role: "system",
      content:
        "You are a helpful assistant. Use web_search for public questions when enabled. Private meeting questions are handled separately.",
    },
    ...prepared.messages,
  ];
  const maxRounds = Math.min(config.maxRounds ?? 3, 3);
  for (let round = 0; round < maxRounds; round++) {
    if (params.isAborted?.()) break;
    throwIfAborted(params.signal);
    convo = trimConvoToBudget(
      truncateToolResults(convo),
      contextLengthFor(model),
    );
    const toolResults = convo.filter((m) => m.role === "tool");
    const forceAnswer = round === maxRounds - 1;
    const clean = forceAnswer && toolResults.length > 0;
    const question =
      [...params.messages].reverse().find((m) => m.role === "user")?.content ??
      "";
    params.onPhase?.(round ? "synthesis" : "model");
    const upstream = await fetchForTurn(
      fetchImpl,
      `${config.redpillBaseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.redpillApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: clean
            ? [
                {
                  role: "system",
                  content:
                    "Answer from supplied public-web results, citing source links.",
                },
                {
                  role: "user",
                  content: JSON.stringify({
                    question,
                    results: toolResults.map((m) => m.content),
                  }),
                },
              ]
            : convo,
          ...(!clean && params.publicTools !== false
            ? {
                tools: [WEB_SEARCH_TOOL],
                tool_choice: forceAnswer ? "none" : "auto",
              }
            : {}),
          ...(round ? { reasoning_effort: "low" } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
      },
      params.signal,
    );
    if (!upstream.ok || !upstream.body) {
      if (upstream.body) ignoreCleanup(() => upstream.body!.cancel());
      return { ...total, errorCode: "upstream_failed" };
    }
    const calls = new Map<number, AccumulatedToolCall>();
    let finish: unknown,
      content = "",
      id = "",
      prompt = 0,
      completion = 0,
      pending = "",
      leak = false;
    for await (const obj of parseSseJson(upstream.body, params.signal)) {
      if (typeof obj.id === "string") id = obj.id;
      const usage = obj.usage as any;
      if (typeof usage?.prompt_tokens === "number")
        prompt = usage.prompt_tokens;
      if (typeof usage?.completion_tokens === "number")
        completion = usage.completion_tokens;
      const choice = (obj.choices as any[])?.[0],
        delta = choice?.delta;
      if (Array.isArray(delta?.tool_calls))
        accumulateToolCalls(calls, normalizeToolCallDeltas(delta.tool_calls));
      if (typeof delta?.content === "string") {
        content += delta.content;
        if (!leak) {
          pending += delta.content;
          const marker = pending.indexOf("<tool_call");
          if (marker >= 0) {
            if (marker) await write(contentFrame(pending.slice(0, marker)));
            pending = "";
            leak = true;
          } else {
            let held = Math.min(9, pending.length);
            while (held && !"<tool_call".startsWith(pending.slice(-held)))
              held--;
            const ready = pending.slice(0, pending.length - held);
            pending = held ? pending.slice(-held) : "";
            if (ready) await write(contentFrame(ready));
          }
        }
      }
      if (choice?.finish_reason != null) finish = choice.finish_reason;
    }
    total.promptTokens += prompt;
    total.completionTokens += completion;
    if (!leak && pending) await write(contentFrame(pending));
    if (!calls.size && leak) {
      parseInlineToolCalls(content).forEach((call, i) =>
        calls.set(i, { id: `inline_${i}`, ...call }),
      );
      if (calls.size) finish = "tool_calls";
      else
        await write(contentFrame(content.slice(content.indexOf("<tool_call"))));
    }
    if (
      [...calls.values()].some((c) => c.name !== "web_search") ||
      (params.publicTools === false && calls.size)
    )
      return { ...total, errorCode: "routing_mismatch" };
    if (finish === "tool_calls") {
      if (!calls.size) throw new StreamFailure("upstream_incomplete");
      convo.push({
        role: "assistant",
        content: "",
        tool_calls: [...calls.values()].map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args },
        })),
      });
      for (const call of calls.values()) {
        params.onPhase?.("tool");
        await write(toolActivityFrame(call.name, "running"));
        let outcome: ToolDispatchOutcome;
        try {
          outcome = await dispatchTool(
            config,
            fetchImpl,
            call,
            params.entityId,
            params.roomId,
            params.turnContext,
            params.signal,
            ["web_search"],
          );
        } catch (error) {
          throwIfAborted(params.signal);
          if (error instanceof StreamFailure) {
            if (error.code === "result_size_limit")
              return { ...total, errorCode: error.code };
            throw error;
          }
          outcome = { status: "error", text: "(tool web_search unreachable)" };
        }
        await write(toolActivityFrame(call.name, outcome.status));
        convo.push({
          role: "tool",
          tool_call_id: call.id,
          content: outcome.text,
        });
      }
      continue;
    }
    if (finish !== "stop" || calls.size)
      throw new StreamFailure("upstream_incomplete");
    total.completionId = id;
    break;
  }
  return total;
}

export type StreamErrorCode =
  | "turn_timeout"
  | "upstream_incomplete"
  | "upstream_failed"
  | "agent_failed"
  | "routing_mismatch"
  | "interpretation_failed"
  | "interpretation_timeout"
  | "meeting_feature_unavailable"
  | "result_size_limit";
type StreamPhase = "model" | "tool" | "synthesis" | "repair" | "terminal";

class StreamFailure extends Error {
  constructor(readonly code: StreamErrorCode) {
    super(code);
  }
}

export interface AgentStreamSummary {
  phase: StreamPhase;
  elapsedMs: number;
  lastWriteAgeMs: number;
  maxWriteGapMs: number;
  outcome: StreamErrorCode | "success" | "cancelled" | "transport_failed";
  headersFlushed: boolean;
  responseDestroyed: boolean;
  responseEnded: boolean;
  responseFinished: boolean;
  backpressured: boolean;
  applicationDoneWritten: boolean;
}

export interface AgentStreamRuntime {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log(summary: AgentStreamSummary): void;
}

const streamRuntime: AgentStreamRuntime = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  log: (summary) => console.info("[agent-chat] stream lifecycle", summary),
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
}

/** Detach noncompliant operations on abort while observing all late rejections. */
function withAbort<T>(
  operation: PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new Error("cancelled"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) aborted();
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(signal.aborted ? signal.reason : error);
      },
    );
    if (signal.aborted) aborted();
  });
}

function ignoreCleanup(cleanup: () => unknown): void {
  try {
    void Promise.resolve(cleanup()).catch(() => {});
  } catch {
    /* Cleanup cannot replace the primary outcome. */
  }
}

async function fetchForTurn(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<globalThis.Response> {
  throwIfAborted(signal);
  try {
    const operation = fetchImpl(url, { ...init, signal });
    // A test double or remote implementation may resolve after cancellation.
    void operation.then(
      (response) => {
        if (signal?.aborted && response.body)
          ignoreCleanup(() => response.body!.cancel());
      },
      () => {},
    );
    return await withAbort(operation, signal);
  } catch (error) {
    throwIfAborted(signal);
    throw error instanceof StreamFailure
      ? error
      : new StreamFailure("upstream_failed");
  }
}

/** One turn owns response admission, byte order, cancellation and terminal delivery. */
class AgentStreamOwner {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private state: "opening" | "open" | "terminating" | "closed" = "opening";
  private outcome: AgentStreamSummary["outcome"] | undefined;
  private phase: StreamPhase = "model";
  private heartbeat: unknown;
  private deadline: unknown;
  private grace: unknown;
  private busy: Promise<void> | undefined;
  private releaseBusy: (() => void) | undefined;
  private drain: Promise<void> | undefined;
  private releaseDrain: (() => void) | undefined;
  private partialFrame = false;
  private headersFlushed = false;
  private backpressured = false;
  private doneWritten = false;
  private endAttempted = false;
  private readonly started: number;
  private lastWrite: number;
  private maxWriteGap = 0;
  private resolveClosed!: () => void;
  private readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });
  deliveryException = false;

  constructor(
    private req: Request,
    private res: Response,
    private policy: AgentStreamPolicy,
    private runtime: AgentStreamRuntime,
  ) {
    this.started = this.lastWrite = runtime.now();
  }

  isOpen = () => this.state === "open";
  remainingMs = () =>
    Math.max(
      0,
      this.policy.turnTimeoutMs - (this.runtime.now() - this.started),
    );
  setPhase = (phase: StreamPhase) => {
    if (this.isOpen()) this.phase = phase;
  };
  private viable = () =>
    !this.res.destroyed && !this.res.writableEnded && this.state !== "closed";
  private onAborted = () => this.close("cancelled", true);
  private onClose = () => this.close("transport_failed", true);
  private onFinish = () => {
    if (this.endAttempted) this.close(this.outcome ?? "success", false);
  };
  private onError = () => this.close("transport_failed", true);
  private onDrain = () => {
    this.releaseDrain?.();
    this.drain = undefined;
    this.releaseDrain = undefined;
  };

  async open(): Promise<boolean> {
    this.req.on("aborted", this.onAborted);
    this.res.on("close", this.onClose);
    this.res.on("error", this.onError);
    this.res.on("finish", this.onFinish);
    this.res.on("drain", this.onDrain);
    if (this.req.aborted || !this.viable()) {
      this.close("cancelled", true);
      return false;
    }
    try {
      this.res.setHeader("Content-Type", "text/event-stream");
      this.res.setHeader("Cache-Control", "no-cache");
      this.res.setHeader("X-Accel-Buffering", "no");
      this.res.flushHeaders?.();
      this.headersFlushed = true;
      if (!this.viable()) {
        this.close("transport_failed", true);
        return false;
      }
      this.state = "open";
      this.deadline = this.runtime.setTimeout(() => {
        void this.fail(new StreamFailure("turn_timeout"));
      }, this.policy.turnTimeoutMs);
      await this.write(": keepalive\n\n");
      this.scheduleHeartbeat();
      return this.isOpen();
    } catch {
      if (this.state !== "terminating") this.close("transport_failed", true);
      return false;
    }
  }

  private scheduleHeartbeat(): void {
    if (!this.isOpen()) return;
    this.heartbeat = this.runtime.setTimeout(() => {
      if (!this.isOpen()) return;
      if (!this.busy) void this.write(": keepalive\n\n").catch(() => {});
      this.scheduleHeartbeat();
    }, this.policy.heartbeatMs);
  }

  /** No frame queue: the producer awaits this writer; heartbeat ticks skip it. */
  write = async (frame: string): Promise<void> => {
    if (!this.isOpen()) throw this.signal.reason ?? new Error("stream closed");
    // Only a heartbeat can precede the serialized producer here.
    if (this.busy) await withAbort(this.busy, this.signal);
    if (!this.isOpen()) throw this.signal.reason ?? new Error("stream closed");
    this.busy = new Promise<void>((resolve) => {
      this.releaseBusy = resolve;
    });
    try {
      await this.writeBytes(frame, false);
    } finally {
      this.releaseBusy?.();
      this.busy = undefined;
      this.releaseBusy = undefined;
    }
  };

  private async writeBytes(frame: string, terminal: boolean): Promise<void> {
    const bytes = new TextEncoder().encode(frame);
    for (let offset = 0; offset < bytes.length; offset += 16_384) {
      if (
        !this.viable() ||
        (terminal ? this.state !== "terminating" : !this.isOpen())
      )
        throw this.signal.reason ?? new Error("stream closed");
      const end = Math.min(offset + 16_384, bytes.length);
      let accepted: boolean;
      try {
        accepted = this.res.write(bytes.subarray(offset, end));
      } catch {
        this.deliveryException = true;
        this.close("transport_failed", true);
        throw new Error("stream write failed");
      }
      const now = this.runtime.now();
      this.maxWriteGap = Math.max(this.maxWriteGap, now - this.lastWrite);
      this.lastWrite = now;
      if (!terminal) this.partialFrame = end < bytes.length;
      if (terminal && frame === "data: [DONE]\n\n" && end === bytes.length)
        this.doneWritten = true;
      // write(false) accepted these bytes. Only its unsent suffix may be abandoned.
      if (!accepted && this.viable()) {
        this.backpressured = true;
        this.drain ??= new Promise<void>((resolve) => {
          this.releaseDrain = resolve;
        });
        if (terminal) await this.drain;
        else await withAbort(this.drain, this.signal);
      }
      if (!this.viable() || (!terminal && !this.isOpen()))
        throw this.signal.reason ?? new Error("stream closed");
    }
  }

  complete(result: OrchestrateResult): Promise<void> {
    if (result.errorCode) return this.fail(new StreamFailure(result.errorCode));
    if (this.claim("success")) void this.deliver(result);
    return this.closed;
  }

  fail(error: unknown): Promise<void> {
    const code = error instanceof StreamFailure ? error.code : "agent_failed";
    if (this.claim(code)) {
      // The terminal claim closes write admission BEFORE synchronous abort callbacks.
      this.controller.abort(new StreamFailure(code));
      void this.deliver(undefined, code);
    }
    return this.closed;
  }

  private claim(outcome: AgentStreamSummary["outcome"]): boolean {
    if (!this.isOpen()) return false;
    this.outcome = outcome;
    this.state = "terminating";
    this.phase = "terminal";
    this.runtime.clearTimeout(this.heartbeat);
    this.runtime.clearTimeout(this.deadline);
    // One budget covers the prior drain, boundary separator and all terminal bytes.
    this.grace = this.runtime.setTimeout(
      () => this.close("transport_failed", true),
      this.policy.drainGraceMs,
    );
    return true;
  }

  private async deliver(
    result?: OrchestrateResult,
    code?: StreamErrorCode,
  ): Promise<void> {
    try {
      if (this.busy) await this.busy;
      if (this.drain) await this.drain;
      if (!this.viable()) return;
      if (this.partialFrame) await this.writeBytes("\n\n", true);
      if (code) {
        await this.writeBytes(
          `data: ${JSON.stringify({ stream_error: { code }, choices: [{ delta: { content: "\n\nThis reply was interrupted before it finished. Please try again." } }] })}\n\n`,
          true,
        );
      } else if (result) {
        if (result.meetingResult)
          await this.writeBytes(
            `data: ${JSON.stringify({ meeting_result: result.meetingResult })}\n\n`,
            true,
          );
        if (result.checkpoint)
          await this.writeBytes(
            `data: ${JSON.stringify({ compaction_checkpoint: result.checkpoint })}\n\n`,
            true,
          );
        if (result.completionId)
          await this.writeBytes(idFrame(result.completionId), true);
        await this.writeBytes(
          usageFrame(result.promptTokens, result.completionTokens),
          true,
        );
      }
      await this.writeBytes("data: [DONE]\n\n", true);
      if (!this.viable()) return;
      this.endAttempted = true;
      try {
        this.res.end();
      } catch {
        this.deliveryException = true;
        this.close("transport_failed", true);
        return;
      }
      // end() accepts the final flush; finish (or the existing grace) owns closure.
      if (this.res.writableFinished) this.onFinish();
    } catch {
      this.close("transport_failed", true);
    }
  }

  private close(
    outcome: AgentStreamSummary["outcome"],
    destroy: boolean,
  ): void {
    if (this.state === "closed") return;
    this.outcome ??= outcome;
    this.state = "closed";
    this.runtime.clearTimeout(this.heartbeat);
    this.runtime.clearTimeout(this.deadline);
    this.runtime.clearTimeout(this.grace);
    this.req.off?.("aborted", this.onAborted);
    this.res.off?.("close", this.onClose);
    this.res.off?.("error", this.onError);
    this.res.off?.("finish", this.onFinish);
    this.res.off?.("drain", this.onDrain);
    this.onDrain();
    if (!this.signal.aborted) this.controller.abort(new Error("stream closed"));
    if (destroy && !this.res.destroyed && !this.res.writableFinished)
      ignoreCleanup(() => this.res.destroy());
    const now = this.runtime.now();
    try {
      this.runtime.log({
        phase: this.phase,
        elapsedMs: now - this.started,
        lastWriteAgeMs: now - this.lastWrite,
        maxWriteGapMs: this.maxWriteGap,
        outcome: this.outcome,
        headersFlushed: this.headersFlushed,
        responseDestroyed: Boolean(this.res.destroyed),
        responseEnded: Boolean(this.res.writableEnded),
        responseFinished: Boolean(this.res.writableFinished),
        backpressured: this.backpressured,
        applicationDoneWritten: this.doneWritten,
      });
    } catch {
      /* Logging must not reopen or reject a completed stream. */
    }
    this.resolveClosed();
  }
}

export function createAgentChatHandler(
  config: AgentChatConfig,
): RequestHandler {
  const policy = validateAgentStreamPolicy(config.streamPolicy);
  return async (req: Request, res: Response) => {
    if (!req.user) {
      res
        .status(401)
        .json({ error: "unauthenticated", message: "Authentication required" });
      return;
    }

    const {
      model,
      messages,
      roomId,
      clientContext,
      turn,
      publicTools,
      preparation,
    } = (req.body ?? {}) as {
      model?: unknown;
      messages?: unknown;
      roomId?: unknown;
      clientContext?: unknown;
      turn?: MeetingTurnInput;
      publicTools?: boolean;
      preparation?: GeneralPreparation;
    };

    if (
      !Array.isArray(messages) ||
      messages.length === 0 ||
      messages.some(
        (message) =>
          !message ||
          typeof message !== "object" ||
          Array.isArray(message) ||
          !["user", "assistant", "system", "tool"].includes(message.role) ||
          typeof message.content !== "string" ||
          (message.private !== undefined &&
            typeof message.private !== "boolean") ||
          (message.id !== undefined &&
            (typeof message.id !== "string" ||
              !message.id ||
              message.id.length > 128)),
      )
    ) {
      res.status(400).json({
        error: "invalid_body",
        message:
          "messages must be a non-empty array of {role, content} objects.",
      });
      return;
    }
    if (turn === undefined) {
      res.status(426).json({
        error: "upgrade_required",
        message: "Update TinyChat to use the durable turn protocol.",
      });
      return;
    }
    if (
      !turn ||
      typeof turn !== "object" ||
      Array.isArray(turn) ||
      typeof turn.turnId !== "string" ||
      !turn.turnId ||
      turn.turnId.length > 128 ||
      !Number.isFinite(turn.sentAt) ||
      turn.sentAt <= 0 ||
      (publicTools !== undefined && typeof publicTools !== "boolean") ||
      (preparation !== undefined &&
        (!preparation ||
          typeof preparation !== "object" ||
          typeof preparation.memory !== "string" ||
          preparation.memory.length > 128000 ||
          !validCheckpointMetadata(preparation.checkpoint)))
    ) {
      res.status(400).json({
        error: "invalid_body",
        message: "Invalid turn or preparation metadata.",
      });
      return;
    }
    if (roomId !== undefined && typeof roomId !== "string") {
      res
        .status(400)
        .json({ error: "invalid_body", message: "roomId must be a string" });
      return;
    }
    let turnContext: AgentTurnContext | undefined;
    if (clientContext !== undefined) {
      if (!clientContext || typeof clientContext !== "object") {
        res.status(400).json({
          error: "invalid_body",
          message: "clientContext must contain localDate and timeZone",
        });
        return;
      }
      const candidate = clientContext as {
        localDate?: unknown;
        timeZone?: unknown;
      };
      if (
        typeof candidate.localDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(candidate.localDate) ||
        typeof candidate.timeZone !== "string" ||
        candidate.timeZone.length === 0 ||
        candidate.timeZone.length > 100
      ) {
        res.status(400).json({
          error: "invalid_body",
          message:
            "clientContext must contain a YYYY-MM-DD localDate and IANA timeZone",
        });
        return;
      }
      try {
        new Intl.DateTimeFormat("en", { timeZone: candidate.timeZone }).format(
          new Date(),
        );
      } catch {
        res.status(400).json({
          error: "invalid_body",
          message: "clientContext timeZone is invalid",
        });
        return;
      }
      turnContext = {
        localDate: candidate.localDate,
        timeZone: candidate.timeZone,
      };
    }

    const resolvedModel =
      typeof model === "string" && model.trim() ? model : config.defaultModel();
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
        console.error(
          "[agent-chat] failed to resolve subscription tier:",
          error,
        );
        res.status(500).json({
          error: "internal_error",
          message: "Failed to resolve subscription tier",
        });
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
      const ledgerAuthoritative =
        process.env.LEDGER_AUTHORITATIVE === "true" &&
        Boolean(config.rehydrator);
      const missingWeeklyLedgerAnchor =
        ledgerAuthoritative && hasMissingWeeklyLedgerAnchor(tierConfig, anchor);
      const outagePolicy = process.env.LEDGER_OUTAGE_POLICY ?? "bounded_k";

      // Shadow rehydration remains active with the authority flag OFF. In that
      // mode, retain its historic direct K-degrade denial; flag-ON alone lets
      // the selected outage policy decide whether a K-degrade denies.
      if (
        config.rehydrator &&
        (!ledgerAuthoritative || !missingWeeklyLedgerAnchor)
      ) {
        const atLimit = await config.rehydrator.rehydrateIfNeeded(
          address,
          tierConfig,
          anchor,
        );
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
      if (ledgerAuthoritative && config.rehydrator) {
        const entitlement = missingWeeklyLedgerAnchor
          ? undefined
          : await config.rehydrator.getEntitlement(address, tierConfig, anchor);
        const gate = evaluateLedgerGate({
          tier: tierConfig,
          anchor,
          entitlement,
          outagePolicy,
          isLocalOverBudget: () => isOverBudget(address, tierConfig, anchor),
        });
        if (gate.deny) {
          const usage = gate.includeUsage
            ? getUsage(address, tierConfig, anchor)
            : undefined;
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

      try {
        const catalog = await getCatalog();
        rates = resolveRates(catalog, resolvedModel);
      } catch (error) {
        console.error("[agent-chat] failed to resolve model rates:", error);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to resolve model rates",
        });
        return;
      }
    }

    // Resolve synchronous setup before opening the transport.
    const entityId = config.entityIdFor(req.user.address);
    const elapsedSinceSend = Math.max(0, Date.now() - turn.sentAt);
    const remainingPolicy = {
      ...policy,
      turnTimeoutMs: Math.max(
        1,
        Math.min(policy.turnTimeoutMs, 120000 - elapsedSinceSend),
      ),
    };
    const owner = new AgentStreamOwner(
      req,
      res,
      remainingPolicy,
      config.streamRuntime ?? streamRuntime,
    );
    let orchestrateResult: OrchestrateResult | null = null;
    if (await owner.open()) {
      try {
        orchestrateResult = await orchestrateToolCalling({
          config,
          turn,
          publicTools,
          preparation,
          model: resolvedModel,
          messages: messages as ChatMsg[],
          entityId,
          roomId: typeof roomId === "string" ? roomId : undefined,
          turnContext,
          write: owner.write,
          signal: owner.signal,
          onPhase: owner.setPhase,
          remainingMs: owner.remainingMs,
        });
        await owner.complete(orchestrateResult);
      } catch (error) {
        orchestrateResult = null;
        await owner.fail(error);
      }
    } else {
      await owner.fail(new StreamFailure("agent_failed"));
    }
    // A completed result stays provisional through final writes and end().
    if (owner.deliveryException) orchestrateResult = null;

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
            window_kind:
              tierCfg.budgetWindow === "week" ? "anchored_week" : "utc_day",
            credits,
            model: resolvedModel,
            prompt_tokens: orchestrateResult.promptTokens,
            completion_tokens: orchestrateResult.completionTokens,
            occurred_at: now,
            signed_token_count: null,
          });
        }
      } catch {
        console.error("[agent-chat] post-stream usage recording failed");
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
              window_kind:
                tierCfg.budgetWindow === "week" ? "anchored_week" : "utc_day",
              credits,
              model: resolvedModel,
              prompt_tokens: orchestrateResult.promptTokens,
              completion_tokens: orchestrateResult.completionTokens,
              occurred_at: now,
              signed_token_count: null,
            });
          }
        } catch {
          console.error("[agent-chat] fallback usage recording failed");
        }
      }
    }
  };
}
