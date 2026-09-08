/** Bounded live provider contract check; synthetic prompts, no tool execution or retries. */
import { appendFile, writeFile } from "node:fs/promises";
import { OFFERED_CHAT_MODELS } from "../../../packages/core/src/chatModels";

const dir = new URL(".", import.meta.url);
const apiKey = process.env.REDPILL_API_KEY;
if (!apiKey) throw new Error("REDPILL_API_KEY is required");
const diagnostic = process.argv.includes("--diagnostic");
const completion = process.argv.includes("--complete-missing");
if (diagnostic && completion) throw new Error("Choose one probe mode");
const filePrefix = diagnostic ? "diagnostic-" : completion ? "completion-" : "";
const requestPlan = OFFERED_CHAT_MODELS.flatMap(({ id: model }) =>
  (["plain", "tool"] as const).map((test) => ({ model, test })))
  .filter((_, index) => diagnostic ? index === 0 : completion ? index !== 0 : true);
const endpoint = "https://api.redpill.ai/v1/chat/completions";
const startedAt = new Date().toISOString();
const maxTokens = 256;
const requestPauseMs = 15_000;
const requestTimeoutMs = 60_000;
const plainPrompt = "Reply exactly READY_67 and nothing else.";
const toolPrompt = "Call synthetic_echo with value PING_67. Do not answer directly. This is a synthetic test; the tool will not be executed.";
const tool = {
  type: "function",
  function: {
    name: "synthetic_echo",
    description: "A harmless synthetic echo tool used only to inspect tool-call JSON. It will not be executed.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
};
type Call = { id: string; type: string; name: string; arguments: string };
type Row = {
  model: string; test: "plain" | "tool"; startedAt: string; durationMs: number;
  httpStatus: number | null; headersMs: number | null; firstEventMs: number | null;
  firstContentMs: number | null; firstToolMs: number | null; eof: boolean;
  dataEvents: number; doneEvent: number | null; usageEvents: number[];
  finishEvents: number[]; finishReason: string | null; content: string;
  reasoningCharacters: number; calls: Array<Omit<Call, "id"> & { hasId: boolean }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number | null } | null;
  usageBeforeDone: boolean; completeAnswer: boolean; wellFormedToolCall: boolean;
  pass: boolean; failure: string | null;
  providerFailureClass: string | null; retryAfterSeconds: number | null;
  maxTokens: number;
};
const results: Row[] = [];
let authFailed = false;
let stopReason: string | null = null;

async function request(model: string, test: Row["test"]): Promise<Row> {
  const now = performance.now();
  const row: Row = {
    model, test, startedAt: new Date().toISOString(), durationMs: 0,
    httpStatus: null, headersMs: null, firstEventMs: null, firstContentMs: null,
    firstToolMs: null, eof: false, dataEvents: 0, doneEvent: null, usageEvents: [],
    finishEvents: [], finishReason: null, content: "", reasoningCharacters: 0,
    calls: [], usage: null, usageBeforeDone: false, completeAnswer: false,
    wellFormedToolCall: false, pass: false, failure: null,
    providerFailureClass: null, retryAfterSeconds: null,
    maxTokens: model === "qwen/qwen3.6-35b-a3b" ? 512 : maxTokens,
  };
  const calls = new Map<number, Call>();
  const elapsed = () => Math.round(performance.now() - now);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: test === "plain" ? plainPrompt : toolPrompt }],
        ...(test === "tool" ? { tools: [tool], tool_choice: "auto" } : {}),
        stream: true, stream_options: { include_usage: true }, max_tokens: row.maxTokens,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    row.httpStatus = response.status;
    row.headersMs = elapsed();
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter && /^\d+$/.test(retryAfter)) row.retryAfterSeconds = Number(retryAfter);
    else if (retryAfter && Number.isFinite(Date.parse(retryAfter))) {
      row.retryAfterSeconds = Math.max(0, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000));
    }
    if (response.status === 401 || response.status === 403) authFailed = true;
    if (!response.ok) {
      const body = await response.text();
      // Classify internally; never persist the provider's raw message or body.
      let details = "";
      try {
        const parsed = JSON.parse(body);
        details = JSON.stringify(parsed.error ?? parsed).toLowerCase();
      } catch { details = body.toLowerCase(); }
      row.providerFailureClass = /insufficient.{0,30}(credit|balance|fund)|credit.{0,30}(insufficient|exhaust|low)|balance.{0,30}(insufficient|low)|payment.required/.test(details)
        ? "insufficient_credits_or_balance"
        : /quota|daily.limit|monthly.limit/.test(details) ? "quota_exceeded"
        : /rate.limit|too.many.requests/.test(details) ? "rate_limited"
        : /no.{0,20}provider|overload|capacity|unavailable/.test(details) ? "provider_capacity_or_availability"
        : "unclassified_http_failure";
      if (authFailed || response.status === 429 || response.status === 402) stopReason = `http_${response.status}`;
      throw new Error(`http_${response.status}`);
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
      await response.body?.cancel();
      throw new Error("missing_sse_body");
    }
    let eventLines: string[] = [];
    function line(value: string) {
      if (value !== "") { if (value.startsWith("data:")) eventLines.push(value.slice(5).trimStart()); return; }
      const data = eventLines.join("\n"); eventLines = [];
      if (!data) return;
      row.dataEvents++;
      row.firstEventMs ??= elapsed();
      if (data === "[DONE]") { row.doneEvent ??= row.dataEvents; return; }
      const frame = JSON.parse(data);
      if (frame.error) throw new Error("provider_sse_error");
      if (frame.usage) {
        row.usageEvents.push(row.dataEvents);
        const usage = frame.usage;
        if (![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens]
          .every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0)) {
          throw new Error("malformed_usage");
        }
        row.usage = {
          promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens, costUsd: typeof usage.cost === "number" ? usage.cost : null,
        };
      }
      const choice = frame.choices?.[0];
      if (choice?.finish_reason) { row.finishReason = choice.finish_reason; row.finishEvents.push(row.dataEvents); }
      const delta = choice?.delta;
      if (typeof delta?.content === "string" && delta.content) { row.firstContentMs ??= elapsed(); row.content += delta.content; }
      row.reasoningCharacters += (delta?.reasoning_content ?? delta?.reasoning ?? "").length;
      for (const part of delta?.tool_calls ?? []) {
        row.firstToolMs ??= elapsed();
        if (!Number.isInteger(part.index) || part.index < 0) throw new Error("invalid_tool_index");
        const call = calls.get(part.index) ?? { id: "", type: "", name: "", arguments: "" };
        if (part.id) call.id = part.id;
        if (part.type) call.type = part.type;
        call.name += part.function?.name ?? "";
        call.arguments += part.function?.arguments ?? "";
        calls.set(part.index, call);
      }
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, at).replace(/\r$/, "")); buffer = buffer.slice(at + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) line(buffer.replace(/\r$/, ""));
    if (eventLines.length) line("");
    row.eof = true;
    row.usageBeforeDone = row.doneEvent !== null && row.usageEvents.length > 0 &&
      row.usageEvents.every((index) => index < row.doneEvent!) && row.usage !== null &&
      row.usage.promptTokens > 0 && row.usage.completionTokens > 0 &&
      row.usage.totalTokens === row.usage.promptTokens + row.usage.completionTokens;
    row.completeAnswer = test === "plain" && row.finishReason === "stop" && row.content.trim() === "READY_67" && calls.size === 0;
    if (test === "tool" && calls.size === 1) {
      const call = [...calls.values()][0];
      const args = JSON.parse(call.arguments);
      row.wellFormedToolCall = !!call.id && call.type === "function" && call.name === "synthetic_echo" &&
        args?.value === "PING_67" && Object.keys(args).length === 1 && row.finishReason === "tool_calls";
    }
    row.pass = row.usageBeforeDone && row.doneEvent === row.dataEvents &&
      row.finishEvents.every((index) => index < row.doneEvent!) &&
      (test === "plain" ? row.completeAnswer : row.wellFormedToolCall);
    if (!row.pass) row.failure = row.finishReason === "length" ? "output_token_limit_reached" : "contract_assertion_failed";
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    row.failure = /^(http_\d+|missing_sse_body|provider_sse_error|malformed_usage|invalid_tool_index)$/.test(reason)
      ? reason : error instanceof Error && error.name === "TimeoutError" ? "request_timeout" : "stream_or_json_error";
  }
  row.calls = [...calls.values()].map(({ id, ...call }) => ({ ...call, hasId: !!id }));
  row.durationMs = elapsed();
  return row;
}

await writeFile(new URL(`${filePrefix}method.json`, dir), JSON.stringify({
  startedAt, endpoint, models: OFFERED_CHAT_MODELS.map(({ id }) => id),
  source: "packages/core/src/chatModels.ts at 5e6550f52ff5c4075767e103eb3d06e5b0fee17b",
  maxRequests: requestPlan.length, requestPlan, concurrency: 1, maxTokens,
  qwenMaxTokens: 512, requestPauseMs, requestTimeoutMs,
  retries: 0, stopOnHttpStatuses: [401, 402, 403, 429], plainPrompt, toolPrompt, tool,
  notes: ["Synthetic public fixtures only; no tool is executed.", "Production sampling defaults; no reasoning override.",
    "Reads through HTTP EOF (bounded by timeout) to detect usage after DONE.",
    "No raw response headers, completion IDs, credentials, or hidden reasoning are persisted.",
    "A small snapshot verifies observed event order, not a provider guarantee or sustained availability.",
    "Direct RedPill requests do not validate TinyChat's production transport or browser recovery."],
}, null, 2) + "\n");
await writeFile(new URL(`${filePrefix}results.jsonl`, dir), "");
for (const { model, test } of requestPlan) {
    await Bun.sleep(requestPauseMs);
    const row = await request(model, test);
    results.push(row);
    await appendFile(new URL(`${filePrefix}results.jsonl`, dir), JSON.stringify(row) + "\n");
    console.log(JSON.stringify({ model, test, status: row.httpStatus, pass: row.pass,
      usageBeforeDone: row.usageBeforeDone, durationMs: row.durationMs, failure: row.failure,
      providerFailureClass: row.providerFailureClass, retryAfterSeconds: row.retryAfterSeconds }));
    if (stopReason) break;
}
await writeFile(new URL(`${filePrefix}results.json`, dir), JSON.stringify({
  startedAt, finishedAt: new Date().toISOString(), authFailed, stopReason,
  pass: results.length === requestPlan.length && results.every((row) => row.pass), results,
}, null, 2) + "\n");
