// The stdio bridge: the boot process of every regular bot sandbox. It runs OMP and carries OMP's stdin and stdout over
// one WebSocket.
//
//   127.0.0.1:ARM_PORT  POST /arm  {"bridgeToken","gatewayToken","gatewayUrl","model","role","ompConfig","botName"}
//                       from `arm.ts`. Kept in memory. Arming again replaces them and closes any open connection.
//   0.0.0.0:BRIDGE_PORT GET /rpc   WebSocket, `Authorization: Bearer <bridgeToken>`. One connection at a time. Opening
//                       it starts OMP; closing it ends OMP, and OMP ending closes it.

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket, Subprocess } from "bun";

const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_ARM_BYTES = 4096;
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 7070);
const ARM_PORT = Number(process.env.ARM_PORT ?? 7071);
const BRIDGE_HOST = process.env.BRIDGE_HOST ?? "0.0.0.0";
const HOME = process.env.HOME ?? "/root";
/** The agent to run; tests and the local check pass a stand-in. */
const AGENT = process.argv.length > 2 ? process.argv.slice(2) : ["omp", "--mode", "rpc", "--no-ui"];
/** The prompt files from bots/sandbox/prompts, one per role; the sandbox image holds them here. */
const PROMPT_DIR = process.env.BOT_PROMPT_DIR ?? "/opt/tinycloud/prompts";
const ROLES = ["main", "sibling"] as const;
/** The name the owner sees, as bots/src/owner.ts botNameFrom takes it: one line of 1 to 24 characters. */
// eslint-disable-next-line no-control-regex
const BOT_NAME = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]{1,24}$/u;
/** Where a prompt puts the bot's name (TC-3790). */
const NAME_TAG = "{{botName}}";

interface Armed {
  bridgeToken: string;
  gatewayToken: string;
  gatewayUrl: string;
  model: string;
  /** Main or a sibling; picks the bot's system prompt. Absent from an older service. */
  role?: (typeof ROLES)[number];
  /** OMP's config.yml from the service (bots/ `configYml()`), which turns off the tools a bot does not get. Required:
   * OMP never starts on no config or on one left in the box. */
  ompConfig: string;
  /** The name the owner sees, for the prompt's wording only. Absent from an older service: the prompt says TrustBot. */
  botName?: string;
}

let armed: Armed | undefined;
let open: { ws: ServerWebSocket<undefined>; agent: Subprocess<"pipe", "pipe", "ignore"> } | undefined;

const digest = (value: string) => createHash("sha256").update(value).digest();
function log(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ bridge: event, ...extra }));
}

/** OMP's provider config: the model at the bot's path on the gateway. `apiKey: BOT_TOKEN` names an env var. */
function modelsYml(gatewayUrl: string, model: string): string {
  return [
    "# Written by the bridge. BOT_TOKEN is the bot's own gateway token, never a model key.",
    "providers:",
    "  tinycloud:",
    `    baseUrl: ${JSON.stringify(gatewayUrl)}`,
    "    api: openai-completions",
    "    apiKey: BOT_TOKEN",
    "    models:",
    `      - id: ${JSON.stringify(model)}`,
    `        name: ${JSON.stringify(model)}`,
    "        reasoning: false",
    "",
  ].join("\n");
}

function parseArm(value: unknown): Armed | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { bridgeToken, gatewayToken, gatewayUrl, model, role, ompConfig, botName } = value as Record<string, unknown>;
  if (typeof bridgeToken !== "string" || !HEX_64.test(bridgeToken)) return undefined;
  if (typeof gatewayToken !== "string" || !HEX_64.test(gatewayToken)) return undefined;
  if (typeof gatewayUrl !== "string" || !/^http:\/\/[^\s"]+\/bots\/[0-9a-f]{64}\/v1$/.test(gatewayUrl)) return undefined;
  if (typeof model !== "string" || !/^[\w.:/-]{1,128}$/.test(model)) return undefined;
  const known = ROLES.find(entry => entry === role);
  if (role !== undefined && !known) return undefined;
  if (typeof ompConfig !== "string" || ompConfig.length === 0 || ompConfig.length > 2048) return undefined;
  if (botName !== undefined && (typeof botName !== "string" || botName.trim() !== botName || !BOT_NAME.test(botName))) return undefined;
  return { bridgeToken, gatewayToken, gatewayUrl, model, ompConfig, ...(known ? { role: known } : {}), ...(botName !== undefined ? { botName } : {}) };
}

function closeOpen(reason: string): void {
  if (!open) return;
  const { ws, agent } = open;
  open = undefined;
  agent.kill("SIGKILL");
  ws.close(1000, reason);
}

const armServer = Bun.serve({
  hostname: "127.0.0.1",
  port: ARM_PORT,
  maxRequestBodySize: MAX_ARM_BYTES,
  async fetch(req) {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/arm") return new Response(null, { status: 404 });
    const next = parseArm(await req.json().catch(() => null));
    if (!next) return new Response(null, { status: 400 });
    closeOpen("rearmed");
    armed = next;
    log("armed");
    return new Response(null, { status: 204 });
  },
});

const rpcServer = Bun.serve<undefined>({
  hostname: BRIDGE_HOST,
  port: BRIDGE_PORT,
  fetch(req, server) {
    if (new URL(req.url).pathname !== "/rpc") return new Response(null, { status: 404 });
    const header = req.headers.get("authorization");
    if (!armed || !header?.startsWith("Bearer ") || !timingSafeEqual(digest(header.slice(7)), digest(armed.bridgeToken))) {
      log("refused", { cause: armed ? "token" : "unarmed" });
      return new Response(null, { status: 401 });
    }
    if (open) return new Response(null, { status: 409 });
    return server.upgrade(req, { data: undefined }) ? undefined : new Response(null, { status: 400 });
  },
  websocket: {
    maxPayloadLength: 1024 * 1024,
    open(ws) {
      if (open || !armed) {
        ws.close(1013, "busy");
        return;
      }
      const config = armed;
      const agentDir = join(HOME, ".omp", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "models.yml"), modelsYml(config.gatewayUrl, config.model));
      writeFileSync(join(agentDir, "config.yml"), config.ompConfig);
      // Without a role, or without its file (OMP would take the path itself as the prompt), OMP finds the role-neutral
      // ~/.omp/agent/SYSTEM.md instead. The bot's name goes where the prompt says {{botName}}, in a copy.
      const template = config.role && join(PROMPT_DIR, `${config.role}.md`);
      let prompt: string | undefined;
      if (template && existsSync(template)) {
        prompt = join(agentDir, "system-prompt.md");
        writeFileSync(prompt, readFileSync(template, "utf8").split(NAME_TAG).join(config.botName ?? "TrustBot"));
      }
      const agent = Bun.spawn(prompt ? [...AGENT, "--system-prompt", prompt] : AGENT, {
        cwd: HOME,
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME, BOT_TOKEN: config.gatewayToken, PI_NO_TITLE: "1" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      open = { ws, agent };
      log("connected");
      void (async () => {
        for await (const chunk of agent.stdout) {
          if (open?.agent !== agent) break;
          ws.send(chunk);
        }
      })().catch(() => {});
      void agent.exited.then(code => {
        log("agent_exited", { code });
        if (open?.agent === agent) closeOpen("agent_exited");
      });
    },
    message(ws, message) {
      if (open?.ws !== ws) return;
      open.agent.stdin.write(message);
      void open.agent.stdin.flush();
    },
    close(ws) {
      if (open?.ws !== ws) return;
      const { agent } = open;
      open = undefined;
      agent.kill("SIGKILL");
      log("disconnected");
    },
  },
});

log("listening", { port: rpcServer.port, arm: armServer.port });
