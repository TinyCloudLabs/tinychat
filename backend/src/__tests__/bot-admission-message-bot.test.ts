// message_bot end to end through the real admission path: the bots service's admission client asks the gateway's relay
// over the control socket, the relay calls this backend's POST /api/internal/bots/admit, and the route answers from the
// owner's registry record. Imports the bots service's code (bots/src, its dependencies installed under bots/).
// Details: TC-3809
import { afterEach, expect, test } from "bun:test";
import express from "express";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotsRegistry } from "../bots-registry.js";
import { mountBotAdmissionRoute } from "../routes/bot-admission.js";
import { fakeRegistryStore } from "./helpers/fake-registry-store.js";
import { admissionControlKey, createAdmissionClient, createAdmissionRelay } from "../../../bots/src/bot-admission";
import { BotManager, promptText, type Sandbox, type SandboxLauncher } from "../../../bots/src/bot";
import { OwnerManifests } from "../../../bots/src/manifest";
import { botIdFor } from "../../../bots/src/owner";
import { type Frame, RpcChannel } from "../../../bots/src/rpc";
import { createApp } from "../../../bots/src/server";
import { signedCallHeader } from "../../../bots/src/signed-call";

const ownerAddress = `0x${"11".repeat(20)}`;
const otherAddress = `0x${"22".repeat(20)}`;
const owner = `did:pkh:eip155:1:${ownerAddress}`;
const sibling = "a".repeat(32);
const othersBot = "b".repeat(32);
const serviceSecret = "service-" + "x".repeat(64);
const backendCallSecret = "backend-call-" + "y".repeat(64);
const BACKEND_ORIGIN = "https://backend.test";

/** A sandbox that speaks OMP's RPC frames: records what the service sends it and emits what the test scripts. */
class LocalRpc implements Sandbox {
  readonly #channel: RpcChannel;
  readonly #exit = Promise.withResolvers<void>();
  readonly #encoder = new TextEncoder();
  readonly #seen = new Map<string, Frame[]>();
  readonly #waiting = new Map<string, (frame: Frame) => void>();
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly exited = this.#exit.promise;

  constructor() {
    const stdout = new ReadableStream<Uint8Array>({ start: controller => { this.#controller = controller; } });
    this.#channel = new RpcChannel(line => {
      const frame = JSON.parse(line) as Frame;
      const waiting = this.#waiting.get(frame.type);
      if (waiting) {
        this.#waiting.delete(frame.type);
        waiting(frame);
      } else {
        this.#seen.set(frame.type, [...(this.#seen.get(frame.type) ?? []), frame]);
      }
      if (frame.type !== "host_tool_result") this.emit({ type: "response", id: frame.id, success: true, data: { agentInvoked: true } });
    }, stdout);
  }

  take(type: string): Promise<Frame> {
    const seen = this.#seen.get(type)?.shift();
    if (seen) return Promise.resolve(seen);
    const { promise, resolve } = Promise.withResolvers<Frame>();
    this.#waiting.set(type, resolve);
    return promise;
  }

  emit(frame: Frame) { this.#controller.enqueue(this.#encoder.encode(JSON.stringify(frame) + "\n")); }
  call(id: string, args: Record<string, unknown>) {
    this.emit({ type: "host_tool_call", id, toolCallId: id, toolName: "message_bot", arguments: args });
  }
  finish(prompt: Frame, text: string) {
    this.emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: text } });
    this.emit({ type: "prompt_result", id: prompt.id, status: "completed", sessionSettled: true });
  }

  nextId = () => this.#channel.nextId();
  request: Sandbox["request"] = (command, timeout) => this.#channel.request(command, timeout);
  onFrame: Sandbox["onFrame"] = callback => this.#channel.onFrame(callback);
  onHostToolCall: NonNullable<Sandbox["onHostToolCall"]> = callback => this.#channel.onHostToolCall(callback);
  async refreshEgress() {}
  async snapshot() {}
  async stop() { this.#controller.close(); this.#exit.resolve(); }
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

test("message_bot is admitted between the owner's two active bots, and refused for another owner's bot", async () => {
  // The backend: the real route over the real registry. The owner has Main and one sibling; another owner has a bot.
  const keys = [sibling, othersBot];
  const registry = new BotsRegistry(fakeRegistryStore(), { newKey: () => keys.shift()! });
  expect(await registry.create(ownerAddress, { name: "Scout", shape: "sprout", colour: "teal" }, 3)).toMatchObject({ ok: true });
  expect(await registry.create(otherAddress, { name: "Other", shape: "sprout", colour: "teal" }, 3)).toMatchObject({ ok: true });
  const backend = express();
  const backendCalls: string[] = [];
  backend.use((req, _res, next) => { backendCalls.push(`${req.method} ${req.originalUrl}`); next(); });
  mountBotAdmissionRoute(backend, backendCallSecret, registry);
  const server = backend.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => { server.close(); });
  const { port } = server.address() as AddressInfo;

  // The gateway's relay on the supervisor-only control socket, sending to the backend.
  const root = mkdtempSync(join(tmpdir(), "admission-e2e-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const egressRoot = join(root, "egress");
  mkdirSync(egressRoot);
  const relay = createAdmissionRelay(BACKEND_ORIGIN, backendCallSecret, (url, init) => fetch(url.replace(BACKEND_ORIGIN, `http://127.0.0.1:${port}`), init));
  const control = Bun.serve({ unix: join(egressRoot, "control.sock"), fetch: relay });
  cleanup.push(() => control.stop(true));

  // The bots service: the manifest lists both keys as active for this owner; only the backend knows whose they are.
  const manifest = new OwnerManifests(join(root, "manifest"));
  manifest.announce(owner, sibling, "active", 1);
  manifest.announce(owner, othersBot, "active", 1);
  const source = new LocalRpc();
  const target = new LocalRpc();
  const sandboxes = new Map([[botIdFor(owner), source], [botIdFor(owner, sibling), target]]);
  const launcher: SandboxLauncher = {
    hasState: () => false, leftover: () => false,
    launch: async layout => {
      const sandbox = sandboxes.get(layout.botId);
      if (!sandbox) throw new Error("unexpected launch");
      return sandbox;
    },
  };
  const bots = new BotManager(launcher, { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot }, {
    idleMs: 60_000, turnTimeoutMs: 4_000, maxTurnBytes: 64_000,
    history: { signerDid: owner, host: "http://127.0.0.1:9573", policy: "notice-then-expiry-30-days" },
  }, 3);
  cleanup.push(() => bots.stopAll());
  const app = createApp({
    bots, secret: serviceSecret, accounts: "*", manifest, acceptLegacyOwnerHeader: false,
    admit: createAdmissionClient(egressRoot, admissionControlKey(backendCallSecret)),
  });

  const path = "/v1/bots/main/messages";
  const body = JSON.stringify({ text: "owner turn", messageableBotKeys: [sibling, othersBot] });
  const authorization = signedCallHeader(serviceSecret, { direction: "to-service", environment: "private", owner, bot: "main", method: "POST", path, body });
  const response = await app(new Request(`http://bots.test${path}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body }));
  await source.take("set_host_tools");
  const sourcePrompt = await source.take("prompt");

  source.call("to-sibling", { targetKey: sibling, text: "hello from Main" });
  const targetPrompt = await target.take("prompt");
  expect(targetPrompt.message).toBe(promptText("hello from Main", "bot"));
  target.finish(targetPrompt, "hello back");
  expect(await source.take("host_tool_result")).toEqual({
    type: "host_tool_result", id: "to-sibling", result: { content: [{ type: "text", text: "hello back" }] },
  });

  source.finish(sourcePrompt, "done");
  expect(await response.text()).toContain("event: done");

  // A turn reaches one recipient, so the other owner's bot is asked for in the owner's next turn.
  const nextAuthorization = signedCallHeader(serviceSecret, { direction: "to-service", environment: "private", owner, bot: "main", method: "POST", path, body });
  const next = await app(new Request(`http://bots.test${path}`, { method: "POST", headers: { authorization: nextAuthorization, "content-type": "application/json" }, body }));
  const nextPrompt = await source.take("prompt");
  source.call("to-other-owners-bot", { targetKey: othersBot, text: "hello" });
  expect(await source.take("host_tool_result")).toMatchObject({
    id: "to-other-owners-bot", isError: true, result: { content: [{ type: "text", text: "That bot is unavailable." }] },
  });
  source.finish(nextPrompt, "done");
  expect(await next.text()).toContain("event: done");
  // Both answers came from the backend: the manifest held both keys as active.
  expect(backendCalls).toEqual(["POST /api/internal/bots/admit", "POST /api/internal/bots/admit"]);
}, 15_000);
