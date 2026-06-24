// Deterministic reproduction of the live agent tool-calling turn — calls the
// exported orchestrateToolCalling directly (no auth), prints every emitted frame
// classified, so we can see: tool dispatch, content frames, usage. Diagnoses the
// empty-answer live e2e turn.
import { orchestrateToolCalling } from "../backend/src/routes/agent-chat.ts";

const backendEnvText = await Bun.file(new URL("../backend/.env", import.meta.url).pathname).text();
const elizaEnvText = await Bun.file(new URL("../../tinycloud-agents/packages/eliza-service/.env", import.meta.url).pathname).text();
const readEnv = (text: string, k: string): string => {
  const m = text.split("\n").find((l) => l.startsWith(k + "="));
  return m ? m.slice(k.length + 1).trim() : "";
};

const config = {
  agentId: "tinychat",
  entityIdFor: (_a: string) => "b7da5202-d81f-0f0f-a602-46f696ae2b8a",
  elizaServiceUrl: "http://localhost:3000",
  elizaServiceSecret: readEnv(elizaEnvText, "ELIZA_SERVICE_SECRET"),
  redpillApiKey: readEnv(backendEnvText, "REDPILL_API_KEY"),
  redpillBaseUrl: readEnv(backendEnvText, "REDPILL_BASE_URL") || "https://api.redpill.ai/v1",
  defaultModel: () => "phala/gpt-oss-120b",
  isModelOffered: () => true,
  maxRounds: 3,
};

let contentText = "";
const toolActivity: string[] = [];
let usage = "";
let idSeen = "";

const result = await orchestrateToolCalling({
  config,
  model: process.env.PROBE_MODEL ?? "phala/gpt-oss-120b",
  messages: [{ role: "user", content: "Use web search to give me one current news headline today, and cite the source." }],
  entityId: "b7da5202-d81f-0f0f-a602-46f696ae2b8a",
  write: (frame: string) => {
    const m = frame.match(/^data: (.*)\n\n$/s);
    if (!m || m[1] === "[DONE]") return;
    try {
      const o = JSON.parse(m[1]);
      if (o.tool_activity) {
        toolActivity.push(`${o.tool_activity.name}:${o.tool_activity.status}`);
        console.log(`  [TOOL] ${o.tool_activity.name} → ${o.tool_activity.status}`);
      }
      const c = o.choices?.[0]?.delta?.content;
      if (typeof c === "string" && c) contentText += c;
      if (o.usage) usage = JSON.stringify(o.usage);
      if (o.id) idSeen = o.id;
    } catch { /* ignore */ }
  },
});

console.log("\n=== RESULT ===");
console.log("tool activity:", toolActivity.length ? toolActivity.join(", ") : "(NONE — tool never dispatched)");
console.log("visible content length:", contentText.length);
console.log("visible content:", JSON.stringify(contentText.slice(0, 800)));
console.log("usage frame:", usage);
console.log("completionId:", idSeen);
console.log("result:", JSON.stringify(result));
