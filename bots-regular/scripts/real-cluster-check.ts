// The cluster check (README, "Cluster check"). Not run by the tests or CI. Run it in the deployed service container:
//
//   kubectl exec -n bots-regular deploy/bots-regular -c service -- env BOTS_REGULAR_REAL_CHECK=1 bun scripts/real-cluster-check.ts
//
// It starts one bot under a random owner, sends it a message, calls its bridge and two addresses from its sandbox,
// puts it to sleep, wakes it, and deletes it. Each step prints one line; the last line is "REAL CHECK PASSED" or
// "REAL CHECK FAILED".

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Bot, BotManager, type TurnSink } from "../../bots/src/bot";
import { regularConfig } from "../src/config";
import { socketGatewayControl } from "../src/gateway-front";
import { ARM_COMMAND, GkeProvider, inClusterToken } from "../src/gke-provider";
import { BRIDGE_PORT, RegularLauncher } from "../src/launcher";
import { sandboxIdFor } from "../src/provider";

if (process.env.BOTS_REGULAR_REAL_CHECK !== "1") {
  console.error("Opt-in only: set BOTS_REGULAR_REAL_CHECK=1 to run against the real cluster.");
  process.exit(2);
}
const cfg = regularConfig(process.env);
if (cfg.provider.kind !== "gke") throw new Error("BOTS_REGULAR_PROVIDER must be gke for the real check");

const provider = new GkeProvider({ ...cfg.provider, token: inClusterToken });
const gateway = socketGatewayControl(cfg.gatewayControlSocket);
const root = mkdtempSync(join(cfg.runRoot, "real-check-"));
const bots = new BotManager(
  new RegularLauncher(provider, gateway, {
    model: cfg.model,
    gatewayOrigin: cfg.gatewayOrigin,
    armCommand: ARM_COMMAND,
    touchMs: cfg.touchMs,
    startTimeoutMs: cfg.startTimeoutMs,
  }),
  { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "run", "egress") },
  { idleMs: 10 * 60_000, turnTimeoutMs: cfg.turnTimeoutMs, maxTurnBytes: cfg.maxTurnBytes },
  1,
);
const owner = `did:pkh:eip155:1:0x${randomBytes(20).toString("hex")}`;
const bot = bots.forOwner(owner);
const id = sandboxIdFor(bot.layout.botId);

function step(name: string, ok: boolean, seen: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${seen}`);
  if (!ok) throw new Error(`step failed: ${name}`);
}

async function send(target: Bot, text: string): Promise<{ text: string; end: string }> {
  let reply = "";
  let end = "";
  const sink: TurnSink = {
    status: () => {},
    delta: delta => { reply += delta; },
    done: messageId => { end = `done ${messageId}`; },
    error: code => { end = `error ${code}`; },
  };
  await target.send(text, sink);
  return { text: reply, end };
}

/** Runs a one-line script in the sandbox and returns what it printed. */
async function inSandbox(script: string): Promise<string> {
  const result = await provider.exec(id, `bun -e ${JSON.stringify(script)}`, {}, 30);
  return result.output.trim();
}

const started = Date.now();
try {
  console.log(`sandbox ${id}, started ${new Date(started).toISOString()}`);
  const first = await send(bot, "Reply with exactly one word: ok");
  step("start a bot and get a reply", first.end.startsWith("done"), `${first.end}, reply ${JSON.stringify(first.text.slice(0, 80))}`);

  const endpoint = await provider.endpoint(id, BRIDGE_PORT);
  const noToken = (await fetch(`${endpoint}/rpc`)).status;
  const wrongToken = (await fetch(`${endpoint}/rpc`, { headers: { authorization: `Bearer ${randomBytes(32).toString("hex")}` } })).status;
  step("bridge without the launch token", noToken === 401 && wrongToken === 401, `no token ${noToken}, another token ${wrongToken}`);

  const internet = await inSandbox("fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(r=>console.log('reached '+r.status),()=>console.log('blocked'))");
  step("fetch https://example.com from the sandbox", internet === "blocked", internet);
  const otherBot = randomBytes(32).toString("hex");
  const gatewaySeen = await inSandbox(`fetch('${cfg.gatewayOrigin}/bots/${otherBot}/v1/models',{signal:AbortSignal.timeout(8000)}).then(r=>console.log('status '+r.status),()=>console.log('blocked'))`);
  step("gateway, another bot's path, from the sandbox", gatewaySeen === "status 403", gatewaySeen);

  step("sleep", await bot.stop(), "stopped");

  const second = await send(bot, "Reply with exactly one word: again");
  const listed = await bot.list();
  step("wake", second.end.startsWith("done") && listed.length === 4, `${second.end}, ${listed.length} messages listed after waking`);

  const deleted = await bots.deleteWorkingState(bot.layout.botId, "real_check");
  step("delete", deleted === undefined, deleted ?? "deleted");
  console.log(`REAL CHECK PASSED in ${Math.round((Date.now() - started) / 1000)} s`);
} catch (error) {
  console.log(`REAL CHECK FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await bots.stopAll();
  await provider.destroy(id).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
