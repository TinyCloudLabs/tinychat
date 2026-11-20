// A whole regular runtime on this machine for the tests: the private runtime's BotManager and Gateway, the regular
// launcher, and LocalProvider sandboxes (real bridges, a stand-in agent). Records what the service hands each sandbox.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Bot, BotManager, type TurnSink } from "../../../bots/src/bot";
import { Gateway } from "../../../bots/src/gateway";
import { type GatewayControl, sandboxFetch } from "../gateway-front";
import { RegularLauncher } from "../launcher";
import { LocalProvider } from "../local-provider";
import type { ExecResult, SandboxProvider } from "../provider";

const HERE = import.meta.dir;
export const FAKE_AGENT = ["bun", join(HERE, "..", "..", "test", "fake-agent.ts")];
const ARM = `bun ${join(HERE, "..", "..", "sandbox", "arm.ts")}`;

/** LocalProvider, with what each sandbox was armed with and a destroy that can be made to fail. */
export class RecordingProvider implements SandboxProvider {
  readonly armed = new Map<string, Record<string, string>[]>();
  failDestroy = false;
  failSleep = false;
  constructor(readonly local: LocalProvider) {}
  acquire(id: string, signal: AbortSignal) { return this.local.acquire(id); }
  exec(id: string, command: string, env: Record<string, string>, timeoutSeconds: number): Promise<ExecResult> {
    this.armed.set(id, [...(this.armed.get(id) ?? []), env]);
    return this.local.exec(id, command, env);
  }
  endpoint(id: string, port: number) { return this.local.endpoint(id, port); }
  touch(id: string) { return this.local.touch(id); }
  async sleep(id: string) {
    if (this.failSleep) throw new Error("sleep refused");
    await this.local.sleep(id);
  }
  async destroy(id: string) {
    if (this.failDestroy) throw new Error("destroy refused");
    await this.local.destroy(id);
  }
}

export interface Runtime {
  root: string;
  provider: RecordingProvider;
  gateway: Gateway;
  gatewayOrigin: string;
  bots: BotManager;
  close(): Promise<void>;
}

export function startRuntime(idleMs = 60_000): Runtime {
  const root = mkdtempSync(join(tmpdir(), "bots-regular-"));
  // A stand-in model provider: lists the one model.
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ data: [{ id: "test-model" }] }) });
  const gateway = new Gateway({
    egressRoot: join(root, "egress"),
    modelKey: "test-key",
    upstream: `http://127.0.0.1:${upstream.port}`,
    models: ["test-model"],
    maxTokens: 1024,
    botDailyTokens: 1000,
    globalDailyTokens: 10_000,
    maxBodyBytes: 65536,
    maxResponseBytes: 65536,
    connectTimeoutMs: 1000,
    totalTimeoutMs: 1000,
    bodyTimeoutMs: 1000,
    budgetFile: join(root, "budget.json"),
  });
  const toSandbox = sandboxFetch(gateway);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => toSandbox(req) });
  const gatewayOrigin = `http://127.0.0.1:${server.port}`;
  const control: GatewayControl = {
    register: async (botId, token, owner) => gateway.setToken(botId, token, owner),
    drop: async botId => gateway.dropToken(botId),
    receipts: async () => [],
  };
  const provider = new RecordingProvider(new LocalProvider(join(root, "host"), FAKE_AGENT));
  const launcher = new RegularLauncher(provider, control, {
    model: "test-model",
    gatewayOrigin,
    armCommand: ARM,
    touchMs: 50,
    startTimeoutMs: 20_000,
  });
  const bots = new BotManager(
    launcher,
    { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "run", "egress") },
    { idleMs, turnTimeoutMs: 15_000, maxTurnBytes: 65536 },
    10,
  );
  return {
    root,
    provider,
    gateway,
    gatewayOrigin,
    bots,
    async close() {
      await bots.stopAll();
      await provider.local.close();
      void server.stop(true);
      void upstream.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One message through a bot: its streamed text and how it ended. */
export async function send(bot: Bot, text: string): Promise<{ text: string; end: string }> {
  let reply = "";
  let end = "";
  const sink: TurnSink = {
    status: () => {},
    delta: delta => { reply += delta; },
    done: id => { end = `done ${id}`; },
    error: code => { end = `error ${code}`; },
  };
  await bot.send(text, sink);
  return { text: reply, end };
}

export async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}
