// The cluster check (README, "Cluster check"). Not run by the tests or CI. Run it in the deployed service container:
//
//   kubectl exec -n bots-regular deploy/bots-regular -c service -- env BOTS_REGULAR_REAL_CHECK=1 bun scripts/real-cluster-check.ts
//
// It starts one bot under a random owner, sends it two messages, calls its bridge and two addresses from its sandbox,
// puts it to sleep, wakes it, and deletes it. With BOTS_REGULAR_MEASURE_FIT_MAX=<n> it then starts up to n more bots,
// one at a time, until one does not start, and deletes them. Each step prints one line to stderr. stdout gets one JSON
// object: the steps, times, memory per sandbox and how many bots were awake at once.

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
// The service's own log lines go to stderr, so stdout holds the result only.
console.log = console.error;

const cfg = regularConfig(process.env);
if (cfg.provider.kind !== "gke") throw new Error("BOTS_REGULAR_PROVIDER must be gke for the real check");
const fitMax = Number(process.env.BOTS_REGULAR_MEASURE_FIT_MAX ?? 0);
if (!Number.isSafeInteger(fitMax) || fitMax < 0) throw new Error("BOTS_REGULAR_MEASURE_FIT_MAX must be an integer >= 0");

/** GkeProvider, recording how long each sandbox's latest acquire took. */
class TimedProvider extends GkeProvider {
  readonly acquireMs = new Map<string, number>();
  override async acquire(id: string, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    await super.acquire(id, signal);
    this.acquireMs.set(id, Date.now() - started);
  }
}

const provider = new TimedProvider({ ...cfg.provider, token: inClusterToken });
const root = mkdtempSync(join(cfg.runRoot, "real-check-"));
const bots = new BotManager(
  new RegularLauncher(provider, socketGatewayControl(cfg.gatewayControlSocket), {
    model: cfg.model,
    gatewayOrigin: cfg.gatewayOrigin,
    armCommand: ARM_COMMAND,
    touchMs: cfg.touchMs,
    startTimeoutMs: cfg.startTimeoutMs,
  }),
  { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "run", "egress") },
  { idleMs: 10 * 60_000, turnTimeoutMs: cfg.turnTimeoutMs, maxTurnBytes: cfg.maxTurnBytes },
  1 + fitMax,
);
const randomOwner = () => `did:pkh:eip155:1:0x${randomBytes(20).toString("hex")}`;
const bot = bots.forOwner(randomOwner());
const id = sandboxIdFor(bot.layout.botId);
const fitBots: Bot[] = [];

interface Turn { end: string; text: string; first_reply_ms: number | null; total_ms: number }
interface Memory { usage_bytes: number; working_set_bytes: number }

const result: {
  passed: boolean;
  error?: string;
  sandbox: string;
  started_at: string;
  resources: typeof cfg.provider.resources;
  max_running: number;
  steps: { name: string; ok: boolean; seen: string }[];
  cold_start?: { acquire_ms: number | null; turn: Turn };
  warm_turn?: Turn;
  memory?: { idle: Memory; turn_peak: Memory | null; turn_samples: number };
  sleep_ms?: number;
  wake?: { acquire_ms: number | null; turn: Turn };
  fit?: { tried: number; awake_at_once: number; acquire_ms: number[]; first_refusal: string | null };
} = {
  passed: false,
  sandbox: id,
  started_at: new Date().toISOString(),
  resources: cfg.provider.resources,
  max_running: cfg.maxRunning,
  steps: [],
};

function step(name: string, ok: boolean, seen: string): void {
  result.steps.push({ name, ok, seen });
  console.error(`${ok ? "ok  " : "FAIL"} ${name}: ${seen}`);
  if (!ok) throw new Error(`step failed: ${name}`);
}

async function send(target: Bot, text: string): Promise<Turn> {
  const started = Date.now();
  let firstReply: number | null = null;
  let reply = "";
  let end = "";
  const sink: TurnSink = {
    status: () => {},
    delta: delta => { firstReply ??= Date.now() - started; reply += delta; },
    done: messageId => { end = `done ${messageId}`; },
    error: code => { end = `error ${code}`; },
  };
  await target.send(text, sink);
  return { end, text: reply.slice(0, 80), first_reply_ms: firstReply, total_ms: Date.now() - started };
}

/** Runs a one-line script in the sandbox and returns what it printed. */
async function inSandbox(script: string): Promise<string> {
  const result = await provider.exec(id, `bun -e ${JSON.stringify(script)}`, {}, 30);
  return result.output.trim();
}

/** The sandbox's memory use from its cgroup: all of it, and without inactive file cache (as the kubelet counts it). */
async function memory(): Promise<Memory> {
  const { output } = await provider.exec(
    id,
    "cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || cat /sys/fs/cgroup/memory.current; " +
      "grep -hE '^(total_)?inactive_file ' /sys/fs/cgroup/memory/memory.stat /sys/fs/cgroup/memory.stat 2>/dev/null | head -n 1",
    {},
    15,
  );
  const [usage, inactive] = output.trim().split("\n");
  const usageBytes = Number(usage);
  const inactiveBytes = Number(inactive?.split(" ")[1] ?? 0);
  if (!Number.isFinite(usageBytes)) throw new Error(`memory: unexpected output ${JSON.stringify(output.slice(0, 200))}`);
  return { usage_bytes: usageBytes, working_set_bytes: usageBytes - inactiveBytes };
}

try {
  console.error(`sandbox ${id}, started ${result.started_at}`);
  const first = await send(bot, "Reply with exactly one word: ok");
  result.cold_start = { acquire_ms: provider.acquireMs.get(id) ?? null, turn: first };
  step("start a bot and get a reply", first.end.startsWith("done"), `${first.end}, reply ${JSON.stringify(first.text)}`);

  const idle = await memory();
  let peak: Memory | null = null;
  let samples = 0;
  let turnDone = false;
  const warmTurn = send(bot, "Reply with exactly one word: warm").finally(() => { turnDone = true; });
  while (!turnDone) {
    const sample = await memory().catch(() => null);
    if (sample && !turnDone) {
      samples++;
      if (!peak || sample.working_set_bytes > peak.working_set_bytes) peak = sample;
    }
  }
  result.warm_turn = await warmTurn;
  result.memory = { idle, turn_peak: peak, turn_samples: samples };
  step("warm turn", result.warm_turn.end.startsWith("done"), `${result.warm_turn.end}, ${result.warm_turn.total_ms} ms`);

  const endpoint = await provider.endpoint(id, BRIDGE_PORT);
  const noToken = (await fetch(`${endpoint}/rpc`)).status;
  const wrongToken = (await fetch(`${endpoint}/rpc`, { headers: { authorization: `Bearer ${randomBytes(32).toString("hex")}` } })).status;
  step("bridge without the launch token", noToken === 401 && wrongToken === 401, `no token ${noToken}, another token ${wrongToken}`);

  const internet = await inSandbox("fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(r=>console.log('reached '+r.status),()=>console.log('blocked'))");
  step("fetch https://example.com from the sandbox", internet === "blocked", internet);
  const otherBot = randomBytes(32).toString("hex");
  const gatewaySeen = await inSandbox(`fetch('${cfg.gatewayOrigin}/bots/${otherBot}/v1/models',{signal:AbortSignal.timeout(8000)}).then(r=>console.log('status '+r.status),()=>console.log('blocked'))`);
  step("gateway, another bot's path, from the sandbox", gatewaySeen === "status 403", gatewaySeen);

  const sleepStarted = Date.now();
  const stopped = await bot.stop();
  result.sleep_ms = Date.now() - sleepStarted;
  step("sleep", stopped, `stopped in ${result.sleep_ms} ms`);

  const second = await send(bot, "Reply with exactly one word: again");
  result.wake = { acquire_ms: provider.acquireMs.get(id) ?? null, turn: second };
  const listed = await bot.list();
  step("wake", second.end.startsWith("done") && listed.length === 6, `${second.end}, ${listed.length} messages listed after waking`);

  const deleted = await bots.deleteWorkingState(bot.layout.botId, "real_check");
  step("delete", deleted === undefined, deleted ?? "deleted");

  if (fitMax > 0) {
    const fit = { tried: 0, awake_at_once: 0, acquire_ms: [] as number[], first_refusal: null as string | null };
    result.fit = fit;
    while (fit.tried < fitMax) {
      const next = bots.forOwner(randomOwner());
      fitBots.push(next);
      fit.tried++;
      const turn = await send(next, "Reply with exactly one word: ok");
      if (!turn.end.startsWith("done")) {
        fit.first_refusal = turn.end;
        break;
      }
      fit.awake_at_once++;
      fit.acquire_ms.push(provider.acquireMs.get(sandboxIdFor(next.layout.botId)) ?? -1);
    }
    console.error(`fit: ${fit.awake_at_once} bots awake at once (tried ${fit.tried})`);
  }
  result.passed = true;
  console.error(`REAL CHECK PASSED in ${Math.round((Date.now() - Date.parse(result.started_at)) / 1000)} s`);
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  console.error(`REAL CHECK FAILED: ${result.error}`);
  process.exitCode = 1;
} finally {
  await bots.stopAll();
  for (const target of [bot, ...fitBots]) {
    await bots.deleteWorkingState(target.layout.botId, "real_check").catch(() => {});
    await provider.destroy(sandboxIdFor(target.layout.botId)).catch(() => {});
  }
  rmSync(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
