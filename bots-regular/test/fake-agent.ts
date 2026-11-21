// A stand-in for OMP in RPC mode, for tests and local runs. It answers ready, set_event_filter, open_session, prompt
// (one streamed reply), the message listings and abort. Its session is $HOME/bot/sessions/main/messages.json.
//
// Replies: "pong <n>: <text>", n counting this session's turns. Two commands show what a bot can reach:
//   probe <64 hex bot id>   calls that bot's path on the gateway with this bot's own token and replies with the status
//   probe self              the same for its own path

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME!;
const sessionDir = join(home, "bot", "sessions", "main");
const sessionFile = join(sessionDir, "messages.json");
let messages: Record<string, unknown>[] = [];

const write = (frame: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const respond = (id: unknown, data: unknown = {}) => write({ type: "response", id, success: true, data });

function gatewayUrl(): string {
  const yml = readFileSync(join(home, ".omp", "agent", "models.yml"), "utf8");
  return JSON.parse(/baseUrl: (".*")/.exec(yml)![1]!) as string;
}

async function replyTo(text: string): Promise<string> {
  const probe = /^probe (self|[0-9a-f]{64})$/.exec(text.trim());
  if (!probe) return `pong ${messages.filter(m => m.role === "user").length}: ${text}`;
  const own = gatewayUrl();
  const url = probe[1] === "self" ? own : own.replace(/\/bots\/[0-9a-f]{64}\/v1$/, `/bots/${probe[1]}/v1`);
  const response = await fetch(`${url}/models`, { headers: { authorization: `Bearer ${process.env.BOT_TOKEN}` } }).catch(() => undefined);
  return `gateway answered ${response?.status ?? "nothing"} for ${probe[1] === "self" ? "my own path" : "another bot's path"}`;
}

async function prompt(id: unknown, text: string): Promise<void> {
  respond(id, { agentInvoked: true });
  const at = Date.now();
  messages.push({ role: "user", content: text, timestamp: at });
  const reply = await replyTo(text);
  const message = { role: "assistant", content: [{ type: "text", text: reply }], timestamp: at + 1 };
  write({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: reply } });
  messages.push(message);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(sessionFile, JSON.stringify(messages));
  write({ type: "message_end", message });
  write({ type: "prompt_result", id, status: "completed", sessionSettled: true });
  write({ type: "session_settled" });
}

write({ type: "ready" });
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let newline: number;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const frame = JSON.parse(line) as Record<string, unknown>;
    if (frame.type === "open_session") {
      messages = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, "utf8")) : [];
      respond(frame.id);
    } else if (frame.type === "prompt") void prompt(frame.id, String(frame.message));
    else if (frame.type === "get_messages_page" || frame.type === "get_messages") respond(frame.id, { messages });
    else respond(frame.id);
  }
}
