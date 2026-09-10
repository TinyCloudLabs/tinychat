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
import { validateAgentStreamPolicy, type AgentStreamPolicy } from "../agent-stream-policy.js";
import { TINYCLOUD_MEETING_TOOLS } from "../transcripts/tool-contract.js";
import { runMeetingTurn, type BufferedMeetingModelResult, type MeetingModelRequest, type MeetingToolContext } from "../transcripts/meeting-turn.js";
import { parseMeetingToolData } from "../transcripts/meeting-evidence.js";
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
  /** Dedicated staged rollout gate; disabled unless explicitly configured. */
  meetingContentRetrievalEnabled?: boolean;
  meetingContentAccountAllowed?: (address: string) => boolean;
  meetingContentModelAllowed?: (model: string) => boolean;
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

export function buildMeetingAgentGuidance(context?: AgentTurnContext): string {
  const calendar = context
    ? `The user's current local date is ${context.localDate} in ${context.timeZone}. Resolve today/day references from that date. `
    : "No trusted user-local date was supplied; ask for a concrete date when a relative day would be ambiguous. ";
  return (
    "You are a private meeting agent. " + calendar +
    "Citations are required answer syntax: copy the exact bracketed citation supplied by a TinyCloud tool immediately after every meeting-derived factual claim. If no supporting citation was supplied, do not make the claim. " +
    "For the user's private meetings, use TinyCloud meeting tools and never substitute web search. " +
    "Use tinycloud_find_meetings for latest/last, title, participant, or date selection without reading transcripts. " +
    "For a clearly requested first/newest result set selectFirst=true so room follow-ups can reuse it. " +
    "Resolve pronouns and elliptical follow-ups from the conversation before resolving calendar words: after one meeting is selected, questions such as 'what next?', 'what did we decide?', 'summarize it', or 'what did they say?' MUST use tinycloud_read_meeting with the appropriate focus and omit meetingRef to reuse the room selection. " +
    "A citation such as [M1] is never a meetingRef. Never copy a citation into meetingRef; for a room follow-up, omit meetingRef entirely. " +
    "Use tinycloud_read_meeting after selection for one meeting's summary, explicit actions, decisions, speaker statements, or transcript evidence. " +
    "Use tinycloud_search_transcripts only for topic or phrase discovery across meeting content. " +
    "Use tinycloud_list_meeting_actions only when the user explicitly asks for todos/actions across a day, date range, or multiple meetings; never use it for an immediate follow-up about one selected meeting. " +
    "Ask one concise clarification when meeting selection is ambiguous. Preserve meetingRef only as tool state; never show it to the user. " +
    "Do not offer to create, edit, or delete meetings or actions because these tools are read-only. Distinguish structured action items from transcript candidates, " +
    "and never turn a suggestion into a decision, assignment, or todo unless the evidence explicitly states it. " +
    "Disclose partial or truncated coverage and fail closed when private access is unavailable."
  );
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
function normalizeToolCallDeltas(deltas: unknown[]): Parameters<typeof accumulateToolCalls>[1] {
  return deltas.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new StreamFailure("upstream_incomplete");
    const call = value as Record<string, unknown>;
    if (call.index !== undefined && (typeof call.index !== "number" || !Number.isSafeInteger(call.index) || call.index < 0)) throw new StreamFailure("upstream_incomplete");
    if (call.id != null && typeof call.id !== "string") throw new StreamFailure("upstream_incomplete");
    if (call.function != null && (typeof call.function !== "object" || Array.isArray(call.function))) throw new StreamFailure("upstream_incomplete");
    const fn = call.function as Record<string, unknown> | null | undefined;
    if ((fn?.name != null && typeof fn.name !== "string") || (fn?.arguments != null && typeof fn.arguments !== "string")) throw new StreamFailure("upstream_incomplete");
    return {
      ...(typeof call.index === "number" ? { index: call.index } : {}),
      ...(typeof call.id === "string" ? { id: call.id } : {}),
      ...(fn ? { function: {
        ...(typeof fn.name === "string" ? { name: fn.name } : {}),
        ...(typeof fn.arguments === "string" ? { arguments: fn.arguments } : {}),
      } } : {}),
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

/** Parse provider LF SSE; only its explicit protocol terminal completes a round. */
export async function* parseSseJson(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  throwIfAborted(signal);
  const reader = "getReader" in body ? body.getReader() : undefined;
  const iterator = reader ? undefined : (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    ignoreCleanup(() => reader ? reader.cancel() : iterator?.return?.());
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      throwIfAborted(signal);
      let chunk: ReadableStreamReadResult<Uint8Array> | IteratorResult<Uint8Array>;
      try { chunk = await withAbort(reader ? reader.read() : iterator!.next(), signal); }
      catch (error) { throwIfAborted(signal); throw error instanceof StreamFailure ? error : new StreamFailure("upstream_failed"); }
      throwIfAborted(signal);
      if (chunk.done) throw new StreamFailure("upstream_incomplete");
      buffer += decoder.decode(chunk.value, { stream: true });
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
          try { value = JSON.parse(data); } catch { throw new StreamFailure("upstream_incomplete"); }
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new StreamFailure("upstream_incomplete");
          if ("error" in value) throw new StreamFailure("upstream_failed");
          yield value as Record<string, unknown>;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    if (reader) { try { reader.releaseLock(); } catch { /* A noncompliant cancellation cannot hold the turn. */ } }
  }
}

function contentFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function toolActivityFrame(name: string, status: "running" | "done" | "error", id?: string): string {
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
        "You are a helpful assistant. Answer the user's question using the tool results " +
        "provided below. CITATIONS ARE REQUIRED OUTPUT SYNTAX: copy the exact bracketed citation " +
        "immediately after every factual claim it supports. Never omit, rename, or invent a citation. " +
        "Do not infer a decision or action item from " +
        "evidence that does not state one; transcriptCandidates are evidence to inspect, not " +
        "automatically assigned todos. Say the evidence is insufficient instead. " +
        "Preserve citations and do not ask to call a tool again.",
    },
    {
      role: "user",
      content: `Question: ${question}\n\nTool results:\n${results}\n\nAnswer concisely, citing the supplied evidence.`,
    },
  ];
}

function meetingCitationsIn(toolResults: ChatMsg[]): string[] {
  return [...new Set(toolResults.flatMap((message) =>
    message.content.match(/\[M\d+(?::[A-Z]\d*)?(?:,[^\]\r\n]*)?\]/g) ?? [],
  ))];
}

/** Stable eliza-service codes meaning "this user's grant is missing or unusable". */
const DELEGATION_ERROR_CODES = new Set(["delegation_required", "delegation_expired", "delegation_revoked"]);

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
  if (allowedTools && !allowedTools.includes(call.name)) throw new StreamFailure("routing_mismatch");
  let args: Record<string, unknown>;
  try {
    args = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
  } catch {
    throw new StreamFailure("upstream_incomplete");
  }
  throwIfAborted(signal);
  const res = await fetchForTurn(fetchImpl, `${config.elizaServiceUrl}/tools/${encodeURIComponent(call.name)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.elizaServiceSecret}`,
    },
    body: JSON.stringify({ args, entityId, ...(roomId ? { roomId } : {}), ...(turnContext ? { context: turnContext } : {}) }),
  }, signal);
  // Own the JSON reader so cancellation can release a pending body read, even
  // when a supplied fetch implementation does not wire its response to signal.
  const reader = res.body?.getReader();
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
      const decoder = new TextDecoder();
      let json = "";
      for (;;) {
        throwIfAborted(signal);
        const chunk = await withAbort(reader.read(), signal);
        throwIfAborted(signal);
        if (chunk.done) break;
        json += decoder.decode(chunk.value, { stream: true });
        if (json.length > (turnContext && "retrievalMode" in turnContext ? 16000 : 65536)) { cancel(); throw new StreamFailure("result_size_limit"); }
      }
      parsed = JSON.parse(json + decoder.decode());
    } else {
      parsed = await withAbort(res.json(), signal);
      if (turnContext && "retrievalMode" in turnContext && JSON.stringify(parsed).length > 16000) throw new StreamFailure("result_size_limit");
    }
    throwIfAborted(signal);
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof StreamFailure) throw error;
    parsed = {};
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    if (reader) { try { reader.releaseLock(); } catch { /* Preserve the turn outcome. */ } }
  }
  const body = parsed as {
    result?: {
      text?: string;
      data?: Record<string, unknown>;
    };
    error?: string;
  };
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : String(res.status);
    if (DELEGATION_ERROR_CODES.has(code)) {
      // The user has not granted (or has revoked/expired) transcript access.
      // Say so explicitly instead of letting the model quietly substitute a web
      // search, which would make the delegated path look healthy when it is not.
      return {
        status: "error",
        code,
        text: `(tool ${call.name} could not run: ${code}. The user has not granted this agent access `
          + "to their private TinyCloud transcripts, or that access has expired. Tell the user you "
          + "cannot read their transcripts and that they need to reconnect transcript access. Do NOT "
          + "answer from a web search, from memory, or from any other source, and do not guess.",
      };
    }
    return { status: "error", code, text: `(tool ${call.name} failed: ${code})` };
  }
  // Forward the one-line summary and the structured result. Tool output is
  // intentionally generic: transcript citations are not web URLs, and future
  // fixed-policy tools must not require dispatcher changes to reach synthesis.
  const summary = body.result?.text ?? "";
  if (call.name !== "web_search") {
    const data = body.result?.data ? JSON.stringify(body.result.data) : "";
    const typed = parseMeetingToolData(body.result?.data);
    return { status: "done", text: summary && data ? `${summary}\n\nTool data:\n${data}` : summary || data, ...(typed ? { data: typed } : {}) };
  }
  const results = (body.result?.data?.results as Array<{ title?: string; url?: string; snippet?: string }> | undefined) ?? [];
  if (results.length === 0) return { status: "done", text: summary };
  const sources = results
    .map((r, i) => {
      const parts = [`[${i + 1}] ${r.title ?? "(untitled)"}`];
      if (r.url) parts.push(`    URL: ${r.url}`);
      if (r.snippet) parts.push(`    ${r.snippet}`);
      return parts.join("\n");
    })
    .join("\n");
  return { status: "done", text: summary ? `${summary}\n\nSources:\n${sources}` : `Sources:\n${sources}` };
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
  /** Remaining time on the existing SSE owner's deadline. */
  remainingMs?: () => number;
}

export interface OrchestrateResult {
  promptTokens: number;
  completionTokens: number;
  completionId: string;
  /** Nonthrowing failures retain completed-round accounting eligibility. */
  errorCode?: StreamErrorCode;
}

/**
 * Run the bounded tool-calling loop. Streams assistant content frames as they arrive;
 * on a tool_calls finish, dispatches each tool, appends results, and loops for the
 * model's final answer. Returns final ID and summed usage to the lifecycle owner,
 * which alone writes terminal metadata and the protocol terminal.
 */
export async function orchestrateToolCalling(params: OrchestrateParams): Promise<OrchestrateResult> {
  if (!params.config.meetingContentRetrievalEnabled) return orchestrateExistingLoop(params);
  const fetchImpl = params.config.fetchImpl ?? fetch;
  return runMeetingTurn({
    ...params,
    contextWindowTokens: contextLengthFor(params.model),
    modelCall: request => bufferedMeetingModelCall(params, request),
    dispatch: (name, args, context, signal, id) => dispatchTool(params.config, fetchImpl, { name, args: JSON.stringify(args), id }, params.entityId, params.roomId, context, signal),
    capability: async signal => {
      const response = await fetchForTurn(fetchImpl, `${params.config.elizaServiceUrl}/capabilities`, { headers: { authorization: `Bearer ${params.config.elizaServiceSecret}` } }, signal);
      if (!response.ok) { if (response.body) ignoreCleanup(() => response.body!.cancel()); return null; }
      // This content-free response has a small independent transport bound.
      const reader = response.body?.getReader();
      if (!reader) return null;
      let bytes = 0; let text = ""; const decoder = new TextDecoder();
      try {
        for (;;) { const chunk = await withAbort(reader.read(), signal); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 4096) return null; text += decoder.decode(chunk.value, { stream: true }); }
        return JSON.parse(text + decoder.decode());
      } finally { ignoreCleanup(() => reader.cancel()); try { reader.releaseLock(); } catch { /* Preserve the capability outcome. */ } }
    },
    runGeneral: () => orchestrateExistingLoop(params, true),
    contentFrame, toolActivityFrame, delegationErrorFrame,
  });
}

async function bufferedMeetingModelCall(params: OrchestrateParams, request: MeetingModelRequest): Promise<BufferedMeetingModelResult> {
  const maxChars = request.maxOutputTokens === 1024 ? 12288 : 24576;
  params.onPhase?.(request.phase);
  const upstream = await fetchForTurn(params.config.fetchImpl ?? fetch, `${params.config.redpillBaseUrl}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${params.config.redpillApiKey}` },
    body: JSON.stringify({ model: params.model, messages: request.messages, ...(request.tool ? { tools: [request.tool], tool_choice: { type: "function", function: { name: "prepare_meeting_turn" } }, reasoning: { enabled: false } } : { reasoning_effort: "low" }), max_tokens: request.maxOutputTokens, stream: true, stream_options: { include_usage: true } }),
  }, request.signal);
  if (!upstream.ok || !upstream.body) { if (upstream.body) ignoreCleanup(() => upstream.body!.cancel()); throw new StreamFailure("upstream_failed"); }
  let content = "", completionId = "", promptTokens = 0, completionTokens = 0, finish: unknown;
  const calls = new Map<number, AccumulatedToolCall>();
  for await (const obj of parseSseJson(upstream.body as unknown as AsyncIterable<Uint8Array>, request.signal)) {
    if (typeof obj.id === "string") completionId = obj.id;
    const usage = obj.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (typeof usage?.prompt_tokens === "number") promptTokens = usage.prompt_tokens;
    if (typeof usage?.completion_tokens === "number") completionTokens = usage.completion_tokens;
    const choice = (obj.choices as Array<{ delta?: { content?: string; tool_calls?: Parameters<typeof accumulateToolCalls>[1] }; finish_reason?: unknown }> | undefined)?.[0];
    if (typeof choice?.delta?.content === "string") content += choice.delta.content;
    if (Array.isArray(choice?.delta?.tool_calls)) {
      accumulateToolCalls(calls, normalizeToolCallDeltas(choice.delta.tool_calls));
    }
    if (content.length + [...calls.values()].reduce((n, call) => n + call.args.length + call.name.length, 0) > maxChars || calls.size > 8) throw new StreamFailure("result_size_limit");
    if (choice?.finish_reason != null) finish = choice.finish_reason;
  }
  let inline = false;
  if (calls.size === 0 && content.includes("<tool_call>")) {
    parseInlineToolCalls(content).forEach((call, i) => calls.set(i, { id: `inline_${i}`, ...call })); inline = calls.size > 0;
  }
  return { content, calls: [...calls.values()], inline, complete: finish === "stop" || finish === "tool_calls", completionId, promptTokens, completionTokens };
}

async function orchestrateExistingLoop(params: OrchestrateParams, generalOnly = false): Promise<OrchestrateResult> {
  const { config, model, write } = params;
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxRounds = generalOnly ? Math.min(config.maxRounds ?? 3, 3) : config.maxRounds ?? 3;
  let convo: ChatMsg[] = [
    {
      role: "system",
      content: generalOnly ? "You are a helpful assistant. Use web_search for public web questions when needed. Answer ordinary conversation directly." : buildMeetingAgentGuidance(params.turnContext),
    },
    ...params.messages,
  ];
  // The original question, for the clean-synthesis forced round (last user message).
  const lastUserQuestion = [...params.messages].reverse().find((m) => m.role === "user")?.content ?? "";

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let finalCompletionId = "";
  let errorCode: StreamErrorCode | undefined;
  let repairing = false;

  for (let round = 0; round < maxRounds; round++) {
    if (params.isAborted?.() || params.signal?.aborted) break;

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
    const meetingCitations = generalOnly ? [] : meetingCitationsIn(toolResults);
    // Meeting answers are held until their citation contract is validated. This
    // lets us retry an uncited synthesis without leaking the invalid draft.
    const bufferMeetingAnswer = meetingCitations.length > 0;

    params.onPhase?.(repairing ? "repair" : isSynthesisRound ? "synthesis" : "model");
    const upstream = await fetchForTurn(fetchImpl, `${config.redpillBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.redpillApiKey}`,
      },
      body: JSON.stringify(
        cleanSynthesis
          ? {
              model,
              messages: generalOnly ? [
                { role: "system", content: "Answer the user's question using the supplied public-web results. Cite source links for factual claims supported by those results." },
                { role: "user", content: `Question: ${lastUserQuestion}\n\nPublic-web results:\n${toolResults.map(message => message.content).join("\n\n")}` },
              ] : buildCleanSynthesisMessages(
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
              tools: generalOnly ? [WEB_SEARCH_TOOL] : [WEB_SEARCH_TOOL, ...TINYCLOUD_MEETING_TOOLS],
              tool_choice: forceAnswer ? "none" : "auto",
              ...(isSynthesisRound ? { reasoning_effort: "low" } : {}),
              stream: true,
              stream_options: { include_usage: true },
            },
      ),
    }, params.signal);

    if (!upstream.ok || !upstream.body) {
      if (upstream.body) ignoreCleanup(() => upstream.body!.cancel());
      errorCode = "upstream_failed";
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
    let generalPending = "";

    const flushPending = async () => {
      if (pendingBuffer) {
        if (!bufferMeetingAnswer) await write(contentFrame(pendingBuffer));
        pendingBuffer = "";
      }
    };

    for await (const obj of parseSseJson(upstream.body as unknown as AsyncIterable<Uint8Array>, params.signal)) {
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
        if (generalOnly) {
          // Hold only a possible markup prefix; ordinary deltas still stream.
          // This also catches inline calls emitted after already-delivered prose.
          if (!leakMode) {
            generalPending += delta.content;
            const marker = generalPending.indexOf(LEAK_PREFIX);
            if (marker >= 0) {
              if (marker) await write(contentFrame(generalPending.slice(0, marker)));
              generalPending = ""; leakMode = true;
            } else {
              let held = Math.min(LEAK_PREFIX.length - 1, generalPending.length);
              while (held > 0 && !LEAK_PREFIX.startsWith(generalPending.slice(-held))) held--;
              const ready = generalPending.slice(0, generalPending.length - held);
              generalPending = held ? generalPending.slice(-held) : "";
              if (ready) await write(contentFrame(ready));
            }
          }
        } else if (leakMode) {
          // Already in leak mode: keep accumulating, forward nothing.
        } else if (decided) {
          if (!bufferMeetingAnswer) await write(contentFrame(delta.content));
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
            await flushPending();
          }
          // else: still ambiguous (e.g. just "<too") — keep buffering.
        }
      }
      if (Array.isArray(delta?.tool_calls)) {
        accumulateToolCalls(toolCalls, normalizeToolCallDeltas(delta.tool_calls));
      }
      const fr = choice?.finish_reason;
      if (typeof fr === "string") finish = fr;
    }

    totalPromptTokens += roundPromptTokens;
    totalCompletionTokens += roundCompletionTokens;
    if (generalOnly && !leakMode && generalPending) await write(contentFrame(generalPending));

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
        await flushPending();
      }
    } else if (!leakMode) {
      // Stream ended while still buffering an ambiguous-but-short prefix (e.g. the
      // entire answer was "<3"): not a leak, so flush what we held.
      await flushPending();
    }

    if (generalOnly && [...toolCalls.values()].some(call => call.name !== "web_search")) { errorCode = "routing_mismatch"; break; }
    if (toolCalls.size > 0 && finish !== "tool_calls") throw new StreamFailure("upstream_incomplete");
    if (finish === "tool_calls") {
      const calls = [...toolCalls.values()];
      if (!calls.length) throw new StreamFailure("upstream_incomplete");
      for (const call of calls) {
        let args: unknown;
        try { args = JSON.parse(call.args); } catch { throw new StreamFailure("upstream_incomplete"); }
        if (!call.id || !call.name || !args || typeof args !== "object" || Array.isArray(args)) throw new StreamFailure("upstream_incomplete");
      }
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
        throwIfAborted(params.signal);
        params.onPhase?.("tool");
        await write(toolActivityFrame(call.name, "running"));
        let outcome: ToolDispatchOutcome;
        try {
          outcome = await dispatchTool(config, fetchImpl, call, params.entityId, params.roomId, params.turnContext, params.signal, generalOnly ? ["web_search"] : undefined);
        } catch {
          throwIfAborted(params.signal);
          outcome = { status: "error", text: `(tool ${call.name} unreachable)` };
        }
        throwIfAborted(params.signal);
        await write(toolActivityFrame(call.name, outcome.status));
        if (outcome.code && DELEGATION_ERROR_CODES.has(outcome.code)) {
          // The response is already streaming, so this cannot become an HTTP
          // status. Preserve it as a typed SSE frame instead of leaving the UI
          // to infer expiry from the model's natural-language apology.
          await write(delegationErrorFrame(outcome.code));
        }
        convo.push({ role: "tool", tool_call_id: call.id, content: outcome.text });
      }
      continue; // loop for the model's answer using the tool results
    }

    if (bufferMeetingAnswer) {
      const hasSuppliedCitation = meetingCitations.some((citation) => roundContent.includes(citation));
      if (!hasSuppliedCitation && !forceAnswer) {
        // Give the final clean-synthesis round one chance to repair an uncited
        // meeting draft. The draft was buffered, so the browser never saw it.
        repairing = true;
        continue;
      }
      await write(contentFrame(hasSuppliedCitation
        ? roundContent
        : "I found matching private meeting evidence, but could not produce a safely cited answer. Please try again."));
    }

    finalCompletionId = currentRoundId;
    break; // finish_reason "stop" (or no tools) — content already streamed
  }


  return { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, completionId: finalCompletionId, ...(errorCode ? { errorCode } : {}) };
}

export type StreamErrorCode = "turn_timeout" | "upstream_incomplete" | "upstream_failed" | "agent_failed" | "routing_mismatch" | "interpretation_failed" | "meeting_feature_unavailable" | "result_size_limit";
type StreamPhase = "model" | "tool" | "synthesis" | "repair" | "terminal";

class StreamFailure extends Error {
  constructor(readonly code: StreamErrorCode) { super(code); }
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
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  log: (summary) => console.info("[agent-chat] stream lifecycle", summary),
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
}

/** Detach noncompliant operations on abort while observing all late rejections. */
function withAbort<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason ?? new Error("cancelled")); };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(operation).then(
      (value) => { signal.removeEventListener("abort", aborted); if (signal.aborted) aborted(); else resolve(value); },
      (error) => { signal.removeEventListener("abort", aborted); reject(signal.aborted ? signal.reason : error); },
    );
    if (signal.aborted) aborted();
  });
}

function ignoreCleanup(cleanup: () => unknown): void {
  try { void Promise.resolve(cleanup()).catch(() => {}); } catch { /* Cleanup cannot replace the primary outcome. */ }
}

async function fetchForTurn(fetchImpl: typeof fetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<globalThis.Response> {
  throwIfAborted(signal);
  try {
    const operation = fetchImpl(url, { ...init, signal });
    // A test double or remote implementation may resolve after cancellation.
    void operation.then((response) => {
      if (signal?.aborted && response.body) ignoreCleanup(() => response.body!.cancel());
    }, () => {});
    return await withAbort(operation, signal);
  } catch (error) {
    throwIfAborted(signal);
    throw error instanceof StreamFailure ? error : new StreamFailure("upstream_failed");
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
  private readonly closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
  deliveryException = false;

  constructor(private req: Request, private res: Response, private policy: AgentStreamPolicy, private runtime: AgentStreamRuntime) {
    this.started = this.lastWrite = runtime.now();
  }

  isOpen = () => this.state === "open";
  remainingMs = () => Math.max(0, this.policy.turnTimeoutMs - (this.runtime.now() - this.started));
  setPhase = (phase: StreamPhase) => { if (this.isOpen()) this.phase = phase; };
  private viable = () => !this.res.destroyed && !this.res.writableEnded && this.state !== "closed";
  private onAborted = () => this.close("cancelled", true);
  private onClose = () => this.close("transport_failed", true);
  private onFinish = () => { if (this.endAttempted) this.close(this.outcome ?? "success", false); };
  private onError = () => this.close("transport_failed", true);
  private onDrain = () => { this.releaseDrain?.(); this.drain = undefined; this.releaseDrain = undefined; };

  async open(): Promise<boolean> {
    this.req.on("aborted", this.onAborted);
    this.res.on("close", this.onClose);
    this.res.on("error", this.onError);
    this.res.on("finish", this.onFinish);
    this.res.on("drain", this.onDrain);
    if (this.req.aborted || !this.viable()) { this.close("cancelled", true); return false; }
    try {
      this.res.setHeader("Content-Type", "text/event-stream");
      this.res.setHeader("Cache-Control", "no-cache");
      this.res.setHeader("X-Accel-Buffering", "no");
      this.res.flushHeaders?.();
      this.headersFlushed = true;
      if (!this.viable()) { this.close("transport_failed", true); return false; }
      this.state = "open";
      this.deadline = this.runtime.setTimeout(() => { void this.fail(new StreamFailure("turn_timeout")); }, this.policy.turnTimeoutMs);
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
    this.busy = new Promise<void>((resolve) => { this.releaseBusy = resolve; });
    try { await this.writeBytes(frame, false); }
    finally { this.releaseBusy?.(); this.busy = undefined; this.releaseBusy = undefined; }
  };

  private async writeBytes(frame: string, terminal: boolean): Promise<void> {
    const bytes = new TextEncoder().encode(frame);
    for (let offset = 0; offset < bytes.length; offset += 16_384) {
      if (!this.viable() || (terminal ? this.state !== "terminating" : !this.isOpen())) throw this.signal.reason ?? new Error("stream closed");
      const end = Math.min(offset + 16_384, bytes.length);
      let accepted: boolean;
      try { accepted = this.res.write(bytes.subarray(offset, end)); }
      catch {
        this.deliveryException = true;
        this.close("transport_failed", true);
        throw new Error("stream write failed");
      }
      const now = this.runtime.now();
      this.maxWriteGap = Math.max(this.maxWriteGap, now - this.lastWrite);
      this.lastWrite = now;
      if (!terminal) this.partialFrame = end < bytes.length;
      if (terminal && frame === "data: [DONE]\n\n" && end === bytes.length) this.doneWritten = true;
      // write(false) accepted these bytes. Only its unsent suffix may be abandoned.
      if (!accepted && this.viable()) {
        this.backpressured = true;
        this.drain ??= new Promise<void>((resolve) => { this.releaseDrain = resolve; });
        if (terminal) await this.drain;
        else await withAbort(this.drain, this.signal);
      }
      if (!this.viable() || (!terminal && !this.isOpen())) throw this.signal.reason ?? new Error("stream closed");
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
    this.grace = this.runtime.setTimeout(() => this.close("transport_failed", true), this.policy.drainGraceMs);
    return true;
  }

  private async deliver(result?: OrchestrateResult, code?: StreamErrorCode): Promise<void> {
    try {
      if (this.busy) await this.busy;
      if (this.drain) await this.drain;
      if (!this.viable()) return;
      if (this.partialFrame) await this.writeBytes("\n\n", true);
      if (code) {
        await this.writeBytes(`data: ${JSON.stringify({ stream_error: { code }, choices: [{ delta: { content: "\n\nThis reply was interrupted before it finished. Please try again." } }] })}\n\n`, true);
      } else if (result) {
        if (result.completionId) await this.writeBytes(idFrame(result.completionId), true);
        await this.writeBytes(usageFrame(result.promptTokens, result.completionTokens), true);
      }
      await this.writeBytes("data: [DONE]\n\n", true);
      if (!this.viable()) return;
      this.endAttempted = true;
      try { this.res.end(); }
      catch { this.deliveryException = true; this.close("transport_failed", true); return; }
      // end() accepts the final flush; finish (or the existing grace) owns closure.
      if (this.res.writableFinished) this.onFinish();
    } catch { this.close("transport_failed", true); }
  }

  private close(outcome: AgentStreamSummary["outcome"], destroy: boolean): void {
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
    if (destroy && !this.res.destroyed && !this.res.writableFinished) ignoreCleanup(() => this.res.destroy());
    const now = this.runtime.now();
    try {
      this.runtime.log({ phase: this.phase, elapsedMs: now - this.started, lastWriteAgeMs: now - this.lastWrite, maxWriteGapMs: this.maxWriteGap, outcome: this.outcome,
        headersFlushed: this.headersFlushed, responseDestroyed: Boolean(this.res.destroyed), responseEnded: Boolean(this.res.writableEnded), responseFinished: Boolean(this.res.writableFinished), backpressured: this.backpressured, applicationDoneWritten: this.doneWritten });
    } catch { /* Logging must not reopen or reject a completed stream. */ }
    this.resolveClosed();
  }
}

export function createAgentChatHandler(config: AgentChatConfig): RequestHandler {
  const policy = validateAgentStreamPolicy(config.streamPolicy);
  return async (req: Request, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: "unauthenticated", message: "Authentication required" });
      return;
    }

    const { model, messages, roomId, clientContext } = (req.body ?? {}) as {
      model?: unknown;
      messages?: unknown;
      roomId?: unknown;
      clientContext?: unknown;
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
    let turnContext: AgentTurnContext | undefined;
    if (clientContext !== undefined) {
      if (!clientContext || typeof clientContext !== "object") {
        res.status(400).json({ error: "invalid_body", message: "clientContext must contain localDate and timeZone" });
        return;
      }
      const candidate = clientContext as { localDate?: unknown; timeZone?: unknown };
      if (
        typeof candidate.localDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.localDate)
        || typeof candidate.timeZone !== "string" || candidate.timeZone.length === 0 || candidate.timeZone.length > 100
      ) {
        res.status(400).json({ error: "invalid_body", message: "clientContext must contain a YYYY-MM-DD localDate and IANA timeZone" });
        return;
      }
      try {
        new Intl.DateTimeFormat("en", { timeZone: candidate.timeZone }).format(new Date());
      } catch {
        res.status(400).json({ error: "invalid_body", message: "clientContext timeZone is invalid" });
        return;
      }
      turnContext = { localDate: candidate.localDate, timeZone: candidate.timeZone };
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
      const ledgerAuthoritative =
        process.env.LEDGER_AUTHORITATIVE === "true" && Boolean(config.rehydrator);
      const missingWeeklyLedgerAnchor =
        ledgerAuthoritative && hasMissingWeeklyLedgerAnchor(tierConfig, anchor);
      const outagePolicy = process.env.LEDGER_OUTAGE_POLICY ?? "bounded_k";

      // Shadow rehydration remains active with the authority flag OFF. In that
      // mode, retain its historic direct K-degrade denial; flag-ON alone lets
      // the selected outage policy decide whether a K-degrade denies.
      if (config.rehydrator && (!ledgerAuthoritative || !missingWeeklyLedgerAnchor)) {
        const atLimit = await config.rehydrator.rehydrateIfNeeded(address, tierConfig, anchor);
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
        res.status(500).json({ error: "internal_error", message: "Failed to resolve model rates" });
        return;
      }
    }

    // Resolve synchronous setup before opening the transport.
    const entityId = config.entityIdFor(req.user.address);
    const owner = new AgentStreamOwner(req, res, policy, config.streamRuntime ?? streamRuntime);
    let orchestrateResult: OrchestrateResult | null = null;
    if (await owner.open()) {
      try {
        orchestrateResult = await orchestrateToolCalling({
          config: { ...config, meetingContentRetrievalEnabled: config.meetingContentRetrievalEnabled === true && (!config.meetingContentAccountAllowed || config.meetingContentAccountAllowed(req.user.address)) }, model: resolvedModel, messages: messages as ChatMsg[], entityId,
          roomId: typeof roomId === "string" ? roomId : undefined, turnContext,
          write: owner.write, signal: owner.signal, onPhase: owner.setPhase, remainingMs: owner.remainingMs,
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
            window_kind: tierCfg.budgetWindow === "week" ? "anchored_week" : "utc_day",
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
              window_kind: tierCfg.budgetWindow === "week" ? "anchored_week" : "utc_day",
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
