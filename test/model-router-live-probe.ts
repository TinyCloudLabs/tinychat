/** Release evidence only. Run explicitly with REDPILL_API_KEY; never part of CI. */
import { OFFERED_CHAT_MODELS } from "../packages/core/src/chatModels";
const output = new URL("../artifacts/model-router-live-evidence.json", import.meta.url);
const key = process.env.REDPILL_API_KEY;
const base = process.env.REDPILL_BASE_URL ?? "https://api.redpill.ai/v1";
const evidence: Array<Record<string, unknown>> = [];

async function completion(model: string, messages: unknown[], extra: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 8192, ...extra }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Expected SSE stream");
  let text = "";
  let buffer = "";
  let frames = 0;
  let done = false;
  const calls = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
  const decoder = new TextDecoder();
  for await (const bytes of response.body!) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { done = true; continue; }
      const frame = JSON.parse(payload);
      if (frame.error) throw new Error("Upstream streaming error");
      frames++;
      const delta = frame.choices?.[0]?.delta;
      text += delta?.content ?? "";
      for (const part of delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
        if (part.id) call.id = part.id;
        call.function.name += part.function?.name ?? "";
        call.function.arguments += part.function?.arguments ?? "";
        calls.set(part.index, call);
      }
    }
  }
  if (!done || frames === 0) throw new Error("Incomplete SSE stream");
  return { text, frames, calls: [...calls.values()] };
}

for (const { id: model } of OFFERED_CHAT_MODELS) {
  const row: Record<string, unknown> = { model, streaming: "blocked", toolRoundTrip: "blocked", responseSignature: "not-proven" };
  evidence.push(row);
  if (!key) { row.blocker = "REDPILL_API_KEY unavailable; no inference requests made"; continue; }
  try {
    const streamed = await completion(model, [{ role: "user", content: "Reply exactly STREAM_OK." }]);
    if (!streamed.text.includes("STREAM_OK")) throw new Error("Streaming content did not include proof marker");
    row.streaming = "passed";
    row.streamFrames = streamed.frames;
  } catch (error) { row.streaming = "failed"; row.streamingError = String(error); }
  try {
    const messages: unknown[] = [{ role: "user", content: "Call router_echo with value proof, then repeat the exact string returned by the tool." }];
    const tools = [{ type: "function", function: { name: "router_echo", description: "Return a proof string", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } }];
    const first = await completion(model, messages, { tools });
    if (first.calls.length !== 1 || first.calls[0].function.name !== "router_echo" || !first.calls[0].id) throw new Error("Expected one router_echo call");
    if (JSON.parse(first.calls[0].function.arguments).value !== "proof") throw new Error("Tool arguments failed validation");
    const marker = `router-proof-${crypto.randomUUID()}`;
    messages.push({ role: "assistant", content: first.text || null, tool_calls: first.calls });
    messages.push({ role: "tool", tool_call_id: first.calls[0].id, content: marker });
    const second = await completion(model, messages, { tools });
    if (!second.text.includes(marker)) throw new Error("Tool result was not returned in final streamed content");
    row.toolRoundTrip = "passed";
    row.toolFrames = first.frames + second.frames;
  } catch (error) { row.toolRoundTrip = "failed"; row.toolError = String(error); }
}
const releaseReady = evidence.every((row) => row.streaming === "passed" && row.toolRoundTrip === "passed");
await Bun.write(output, JSON.stringify({ checkedAt: new Date().toISOString(), endpoint: base, releaseReady, candidates: evidence }, null, 2) + "\n");
console.log(JSON.stringify({ output: output.pathname, releaseReady }));
if (!releaseReady) process.exitCode = 2;
