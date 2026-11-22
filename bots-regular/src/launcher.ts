// Starts and stops regular bots on a sandbox host. Each launch: acquires the bot's sandbox, makes a new bridge token
// and a new gateway token, registers the gateway token for the bot, arms the bridge through `exec`, connects to it and
// runs OMP's RPC through the RPC client from bots/.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Sandbox, SandboxLauncher } from "../../bots/src/bot";
import { type BotLayout, botRole } from "../../bots/src/layout";
import { SANDBOX_SESSION_DIR } from "../../bots/src/oci";
import { RpcChannel } from "../../bots/src/rpc";
import { type BridgeConnection, connectBridge } from "./bridge-client";
import type { GatewayControl } from "./gateway-front";
import { sandboxIdFor, type SandboxProvider } from "./provider";

export const BRIDGE_PORT = 7070;

export interface LauncherOptions {
  model: string;
  /** The gateway's origin as sandboxes reach it, e.g. http://bots-regular-gateway.bots-regular.svc:8081. */
  gatewayOrigin: string;
  /** The command that arms the bridge, run in the sandbox with the tokens in its environment. */
  armCommand: string;
  /** How often a running sandbox is touched. */
  touchMs: number;
  /** Waking or creating a sandbox, arming its bridge and OMP's ready, together. */
  startTimeoutMs: number;
}

function log(event: string, botId: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ bots: event, bot: botId.slice(0, 12), ...extra }));
}

export class RegularLauncher implements SandboxLauncher {
  readonly #provider: SandboxProvider;
  readonly #gateway: GatewayControl;
  readonly #options: LauncherOptions;

  constructor(provider: SandboxProvider, gateway: GatewayControl, options: LauncherOptions) {
    this.#provider = provider;
    this.#gateway = gateway;
    this.#options = options;
  }

  /** The bot has run: its marker file holds its sandbox id. */
  hasState(layout: BotLayout): boolean {
    return existsSync(layout.stateSnapshot);
  }

  /** Always false: a sandbox that did not sleep is left to the host's sweeper. */
  leftover(): boolean {
    return false;
  }

  /** No mounts on the service's machine. */
  mountPoints(): string[] {
    return [];
  }

  provenance(layout: BotLayout): Promise<unknown> {
    return this.#gateway.receipts(layout.botId);
  }

  /** Deletes the bot's sandbox and its snapshots, and drops its gateway token. */
  async removeState(layout: BotLayout): Promise<void> {
    await this.#provider.destroy(sandboxIdFor(layout.botId));
    await this.#gateway.drop(layout.botId);
  }

  async launch(layout: BotLayout): Promise<Sandbox> {
    const id = sandboxIdFor(layout.botId);
    const deadline = Date.now() + this.#options.startTimeoutMs;
    const bridgeToken = randomBytes(32).toString("hex");
    const gatewayToken = randomBytes(32).toString("hex");
    // Created first, so deleteBot finds a directory for any bot that may have a sandbox.
    mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
    let connection: BridgeConnection | undefined;
    let touches: Timer | undefined;
    let teardown: Promise<void> | undefined;
    const destroy = () =>
      (teardown ??= (async () => {
        clearInterval(touches);
        connection?.close();
        await Promise.race([connection?.closed, Bun.sleep(5000)]);
        await this.#provider.sleep(id).then(
          () => log("asleep", layout.botId),
          error => log("sleep_failed", layout.botId, { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }),
        );
        await this.#gateway.drop(layout.botId).catch(() => {});
      })());
    try {
      await this.#gateway.register(layout.botId, gatewayToken, layout.ownerId);
      await this.#provider.acquire(id, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      writeFileSync(layout.stateSnapshot, id, { mode: 0o600 });
      const armed = await this.#provider.exec(id, this.#options.armCommand, {
        BOT_BRIDGE_TOKEN: bridgeToken,
        BOT_TOKEN: gatewayToken,
        BOT_GATEWAY_URL: `${this.#options.gatewayOrigin}/bots/${layout.botId}/v1`,
        BOT_MODEL: this.#options.model,
        BOT_ROLE: botRole(layout),
      }, 30);
      if (armed.exitCode !== 0) throw new Error("bridge not armed");
      const open = await connectBridge(await this.#provider.endpoint(id, BRIDGE_PORT), bridgeToken, deadline);
      connection = open;
      touches = setInterval(() => {
        this.#provider.touch(id).catch(() => log("touch_failed", layout.botId));
      }, this.#options.touchMs);
      const rpc = new RpcChannel(line => open.send(line), open.output);
      const exited = Promise.race([rpc.closed, open.closed]).then(() => destroy()).catch(() => {});
      await rpc.ready(Math.max(1, deadline - Date.now()));
      await rpc.request({ type: "set_event_filter", events: ["message_update", "message_end"], messageUpdates: "delta" });
      await rpc.request(
        { type: "open_session", sessionDir: SANDBOX_SESSION_DIR, provider: "tinycloud", modelId: this.#options.model },
        Math.max(1, deadline - Date.now()),
      );
      return {
        nextId: () => rpc.nextId(),
        request: (command, timeoutMs) => rpc.request(command, timeoutMs),
        onFrame: listener => rpc.onFrame(listener),
        exited,
        refreshEgress: () => this.#gateway.register(layout.botId, gatewayToken, layout.ownerId),
        // The host saves the files when the sandbox sleeps.
        snapshot: async () => {},
        stop: destroy,
      };
    } catch (error) {
      await destroy();
      throw error;
    }
  }
}
