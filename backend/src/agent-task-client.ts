/** Versioned, service-authenticated task transport. Accounting never depends on browser writes. */
export interface AgentTaskRequest {
  version: 1;
  executionId: string;
  entityId: string;
  roomId?: string;
  model: { id: string; contextWindowTokens: number };
  messages: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string; tool_calls?: unknown; tool_call_id?: string }>;
  calendar?: { localDate: string; timeZone: string };
  allowedTools: string[];
  accessRevision?: string;
  deadlineAt: number;
}

export interface AgentTaskUsage {
  promptTokens: number;
  completionTokens: number;
  startedAttempts: number;
  reportedAttempts: number;
  finalizedAttempts: number;
  usageCompleteness: "complete" | "partial";
}

export interface AgentTaskActivity {
  type: "activity";
  executionId: string;
  seq: number;
  tool: string;
  callId: string;
  status: "running" | "done" | "error";
}

export interface AgentTaskFinal extends AgentTaskUsage {
  type: "final";
  executionId: string;
  seq: number;
  model: string;
  outcome: "success" | "partial" | "clarification" | "failed" | "cancelled" | "timed_out";
  code?: string;
  answer?: { kind: "model_text" | "meeting_prose" | "safe_fallback"; delivery: "buffered" | "streamed"; text?: string };
  finalProviderCompletionId?: string;
  answerIsProviderVerbatim: boolean;
}

export type AgentTaskErrorCode = "task_unavailable" | "agent_failed" | "upstream_incomplete" | "routing_mismatch" | "result_size_limit" | "turn_timeout";
export type AgentTaskCancelReason = "client_cancelled" | "turn_timeout" | "transport_failed";
export interface AgentTaskResult {
  accepted: boolean;
  cancelled: boolean;
  usage: AgentTaskUsage;
  /** Requires a valid final AND complete provider usage; a complete checkpoint alone is insufficient. */
  observationComplete: boolean;
  final?: AgentTaskFinal;
  errorCode?: AgentTaskErrorCode;
}
export interface AgentTaskCallbacks {
  signal?: AbortSignal;
  cancelReason?: () => AgentTaskCancelReason;
  /** Synchronous bounded enqueue only. Returning false or throwing cancels delivery and drains usage. */
  onContent?: (text: string) => void | boolean;
  /** Optional activity may be dropped by returning false without failing the turn. */
  onActivity?: (event: AgentTaskActivity) => void | boolean;
  onDelegationError?: (code: string) => void | boolean;
}

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_ANSWER_CHARACTERS = 64_000;
const ACCOUNTING_GRACE_MS = 2_000;
const CAPABILITY_TTL_MS = 60_000;
const TOOLS = new Set(["web_search", "tinycloud_find_meetings", "tinycloud_read_meeting", "tinycloud_search_transcripts", "tinycloud_list_meeting_actions"]);
const DELEGATION_CODES = new Set(["delegation_required", "delegation_expired", "delegation_revoked"]);
const USAGE_FIELDS = ["promptTokens", "completionTokens", "startedAttempts", "reportedAttempts", "finalizedAttempts", "usageCompleteness"];
const COUNT_FIELDS = ["promptTokens", "completionTokens", "startedAttempts", "reportedAttempts", "finalizedAttempts"] as const;
const encoder = new TextEncoder();

class TaskFailure extends Error {
  constructor(readonly code: AgentTaskErrorCode) { super(code); }
}
function invalid(): never { throw new TaskFailure("upstream_incomplete"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function usage(value: Record<string, unknown>, previous: AgentTaskUsage): AgentTaskUsage {
  for (const field of COUNT_FIELDS) if (!integer(value[field]) || value[field] < previous[field]) invalid();
  const next = Object.fromEntries(USAGE_FIELDS.map(field => [field, value[field]])) as unknown as AgentTaskUsage;
  if (next.finalizedAttempts > next.reportedAttempts || next.reportedAttempts > next.startedAttempts || next.startedAttempts > 5) invalid();
  if (next.reportedAttempts === 0 && (next.promptTokens !== 0 || next.completionTokens !== 0)) invalid();
  if (next.usageCompleteness !== (next.finalizedAttempts === next.startedAttempts ? "complete" : "partial")) invalid();
  return next;
}

/** Race even an injected/uncooperative fetch or reader against abort, observing late rejection. */
function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new TaskFailure("agent_failed"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createAgentTaskClient(config: { baseUrl: string; apiKey: string; fetch?: typeof fetch }) {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const auth = { Authorization: `Bearer ${config.apiKey}` };
  let capabilityCache: { expiresAt: number; models: string[] } | undefined;

  async function checkCapability(model: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (capabilityCache && performance.now() < capabilityCache.expiresAt) return capabilityCache.models.includes(model);
    try {
      const pending = fetchImpl(`${baseUrl}/capabilities`, { headers: auth, signal });
      const response = signal ? await withAbort(pending, signal) : await pending;
      if (!response.ok) return false;
      const body = signal ? await withAbort(response.json(), signal) : await response.json();
      const tasks = object(object(body).chatTasks);
      if (tasks.version !== 1 || tasks.enabled !== true || tasks.cancellation !== true || tasks.providerProfile !== "tinychat-redpill" || !Array.isArray(tasks.models) || !tasks.models.every(id => text(id, 256))) return false;
      capabilityCache = { models: tasks.models as string[], expiresAt: performance.now() + CAPABILITY_TTL_MS };
      return capabilityCache.models.includes(model);
    } catch { return false; }
  }

  async function run(request: AgentTaskRequest, callbacks: AgentTaskCallbacks = {}): Promise<AgentTaskResult> {
    const result: AgentTaskResult = { accepted: false, cancelled: false, observationComplete: false, usage: { promptTokens: 0, completionTokens: 0, startedAttempts: 0, reportedAttempts: 0, finalizedAttempts: 0, usageCompleteness: "complete" } };
    const transport = new AbortController();
    const cancellation = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let submitted = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSeq = -1;
    let lastData = "";
    let answerCharacters = 0;
    let streamedNonempty = false;

    const cancel = (reason: AgentTaskCancelReason) => {
      if (settled || result.cancelled) return;
      result.cancelled = true;
      result.errorCode ??= reason === "turn_timeout" ? "turn_timeout" : "agent_failed";
      if (!submitted) { transport.abort(); return; }
      graceTimer = setTimeout(() => { cancellation.abort(); transport.abort(); }, ACCOUNTING_GRACE_MS);
      // The cancel request shares the independent grace; it does not inherit the browser signal.
      void (async () => {
        try {
          const response = await withAbort(fetchImpl(`${baseUrl}/tasks/${encodeURIComponent(request.executionId)}/cancel`, {
            method: "POST", headers: { ...auth, "Content-Type": "application/json" }, signal: cancellation.signal,
            body: JSON.stringify({ version: 1, entityId: request.entityId, reason }),
          }), cancellation.signal);
          if (!response.ok) transport.abort();
          void response.body?.cancel().catch(() => {});
        } catch { transport.abort(); }
      })();
    };
    const onAbort = () => cancel(callbacks.cancelReason?.() ?? "client_cancelled");
    const deliver = (callback: (() => void | boolean) | undefined, optional = false) => {
      if (!callback || result.cancelled) return;
      try {
        const delivered = callback();
        if (!optional && delivered === false) cancel("transport_failed");
      } catch { cancel("transport_failed"); }
    };

    function consume(data: string): void {
      let value: Record<string, unknown>;
      try { value = object(JSON.parse(data)); } catch { invalid(); }
      if (value.executionId !== request.executionId) throw new TaskFailure("routing_mismatch");
      if (!integer(value.seq) || value.seq < 1) invalid();
      if (value.seq === lastSeq && data === lastData) return;
      if (value.seq <= lastSeq) invalid();
      const envelope = ["type", "executionId", "seq"];
      const metadata = { ...value };
      if (value.type === "content_delta") delete metadata.text;
      if (value.type === "final" && value.answer) { metadata.answer = { ...object(value.answer) }; delete (metadata.answer as Record<string, unknown>).text; }
      if (encoder.encode(JSON.stringify(metadata)).byteLength > MAX_METADATA_BYTES) throw new TaskFailure("result_size_limit");
      if (!result.accepted && value.type !== "accepted") invalid();
      let nextUsage: AgentTaskUsage | undefined;
      switch (value.type) {
        case "accepted":
          keys(value, [...envelope, "version", "model", "deadlineAt"]);
          if (result.accepted || value.version !== 1 || !integer(value.deadlineAt) || value.deadlineAt === 0 || value.deadlineAt > request.deadlineAt) invalid();
          if (value.model !== request.model.id) throw new TaskFailure("routing_mismatch");
          result.accepted = true;
          if (deadlineTimer) clearTimeout(deadlineTimer);
          deadlineTimer = setTimeout(() => cancel("turn_timeout"), Math.max(0, Math.min(value.deadlineAt - Date.now(), 2_147_483_647)));
          break;
        case "usage":
          keys(value, [...envelope, ...USAGE_FIELDS]);
          nextUsage = usage(value, result.usage);
          break;
        case "content_delta":
          keys(value, [...envelope, "text"]);
          if (!text(value.text, MAX_ANSWER_CHARACTERS)) { if (typeof value.text === "string" && value.text.length > MAX_ANSWER_CHARACTERS) throw new TaskFailure("result_size_limit"); invalid(); }
          answerCharacters += value.text.length;
          if (answerCharacters > MAX_ANSWER_CHARACTERS) throw new TaskFailure("result_size_limit");
          streamedNonempty ||= value.text.trim().length > 0;
          deliver(callbacks.onContent ? () => callbacks.onContent!(value.text as string) : undefined);
          break;
        case "activity":
          keys(value, [...envelope, "tool", "callId", "status"]);
          if (typeof value.tool !== "string" || !TOOLS.has(value.tool) || !request.allowedTools.includes(value.tool) || !text(value.callId, 256) || !["running", "done", "error"].includes(value.status as string)) invalid();
          deliver(callbacks.onActivity ? () => callbacks.onActivity!(value as unknown as AgentTaskActivity) : undefined, true);
          break;
        case "delegation_error":
          keys(value, [...envelope, "code"]);
          if (!DELEGATION_CODES.has(value.code as string)) invalid();
          deliver(callbacks.onDelegationError ? () => callbacks.onDelegationError!(value.code as string) : undefined);
          break;
        case "final": {
          keys(value, [...envelope, ...USAGE_FIELDS, "model", "outcome", "code", "answer", "finalProviderCompletionId", "answerIsProviderVerbatim"]);
          if (value.model !== request.model.id) throw new TaskFailure("routing_mismatch");
          if (!["success", "partial", "clarification", "failed", "cancelled", "timed_out"].includes(value.outcome as string) || typeof value.answerIsProviderVerbatim !== "boolean") invalid();
          if (value.code !== undefined && (typeof value.code !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(value.code))) invalid();
          if (value.finalProviderCompletionId !== undefined && (!text(value.finalProviderCompletionId, 512) || /[\s\x00-\x1f\x7f]/.test(value.finalProviderCompletionId))) invalid();
          const hasAnswer = ["success", "partial", "clarification"].includes(value.outcome as string);
          if (hasAnswer) {
            const answer = object(value.answer);
            keys(answer, ["kind", "delivery", "text"]);
            if (!["model_text", "meeting_prose", "safe_fallback"].includes(answer.kind as string)) invalid();
            if (answer.delivery === "buffered") {
              if (typeof answer.text !== "string" || !answer.text.trim()) invalid();
              answerCharacters += answer.text.length;
              if (answerCharacters > MAX_ANSWER_CHARACTERS) throw new TaskFailure("result_size_limit");
            } else if (answer.delivery !== "streamed" || answer.text !== undefined || !streamedNonempty || answer.kind !== "model_text") invalid();
            if (answer.kind === "safe_fallback" && value.answerIsProviderVerbatim) invalid();
          } else if (value.answer !== undefined || value.answerIsProviderVerbatim) invalid();
          nextUsage = usage(value, result.usage);
          result.final = value as unknown as AgentTaskFinal;
          result.observationComplete = nextUsage.usageCompleteness === "complete";
          break;
        }
        default: invalid();
      }
      if (nextUsage) result.usage = nextUsage;
      lastSeq = value.seq as number;
      lastData = data;
    }

    try {
      callbacks.signal?.addEventListener("abort", onAbort, { once: true });
      if (callbacks.signal?.aborted) onAbort();
      const remaining = request.deadlineAt - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) cancel("turn_timeout");
      else deadlineTimer = setTimeout(() => cancel("turn_timeout"), Math.min(remaining, 2_147_483_647));
      if (result.cancelled) return result;
      if (!await checkCapability(request.model.id, transport.signal)) { result.errorCode ??= "task_unavailable"; return result; }
      if (result.cancelled) return result;
      const body = JSON.stringify(request);
      if (encoder.encode(body).byteLength > 1024 * 1024 + 16 * 1024) throw new TaskFailure("result_size_limit");
      submitted = true;
      const pendingResponse = fetchImpl(`${baseUrl}/tasks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", Accept: "text/event-stream" }, body, signal: transport.signal });
      void pendingResponse.then(response => {
        if (transport.signal.aborted) void response.body?.cancel().catch(() => {});
      }, () => {});
      const response = await withAbort(pendingResponse, transport.signal);
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new TaskFailure(response.status === 503 ? "task_unavailable" : "agent_failed"); }
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) invalid();
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      // Decode complete SSE lines separately: malformed bytes in a later line
      // cannot discard a preceding valid usage checkpoint in the same chunk.
      const lineBuffer = new Uint8Array(MAX_FRAME_BYTES);
      let lineSize = 0;
      let dataLines: string[] = [];
      let frameBytes = 0;
      while (!result.final) {
        const chunk = await withAbort(reader.read(), transport.signal);
        if (chunk.done) throw new TaskFailure("upstream_incomplete");
        for (let offset = 0; offset < chunk.value.byteLength && !result.final; offset++) {
          if (++frameBytes > MAX_FRAME_BYTES) throw new TaskFailure("result_size_limit");
          const byte = chunk.value[offset];
          lineBuffer[lineSize++] = byte;
          if (byte === 10) {
            let line: string;
            try { line = decoder.decode(lineBuffer.subarray(0, lineSize - 1)); }
            catch { invalid(); }
            lineSize = 0;
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (!line) {
              if (dataLines.length) consume(dataLines.join("\n"));
              dataLines = [];
              frameBytes = 0;
            } else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
            else if (!line.startsWith(":")) invalid();
          }
        }
      }
    } catch (error) {
      result.errorCode ??= error instanceof TaskFailure ? error.code : "agent_failed";
      if (submitted && !result.cancelled) cancel("transport_failed");
    } finally {
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (graceTimer) clearTimeout(graceTimer);
      callbacks.signal?.removeEventListener("abort", onAbort);
      cancellation.abort();
      transport.abort();
      void reader?.cancel().catch(() => {});
    }
    return result;
  }
  return { checkCapability, run };
}
