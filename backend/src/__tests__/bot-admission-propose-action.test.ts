// propose_action's fan-out end to end through the real admission path: Main proposes on the gateway, the owner's Send
// reaches the bots service, and each delivery asks the gateway's relay, which calls this backend's
// POST /api/internal/bots/admit over the owner's registry record. Imports the bots service's code (bots/src).
// Details: TC-3793
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import express from "express";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotsRegistry } from "../bots-registry.js";
import { mountBotAdmissionRoute } from "../routes/bot-admission.js";
import { fakeRegistryStore } from "./helpers/fake-registry-store.js";
import { syncActions } from "../../../bots/src/actions";
import { type AsksGateway, syncAsks } from "../../../bots/src/asks";
import { admissionControlKey, createAdmissionClient, createAdmissionRelay } from "../../../bots/src/bot-admission";
import { BotManager, promptText, type Sandbox, type SandboxLauncher } from "../../../bots/src/bot";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../../../bots/src/config";
import { Gateway } from "../../../bots/src/gateway";
import { OwnerManifests } from "../../../bots/src/manifest";
import { botIdFor } from "../../../bots/src/owner";
import { type Frame, RpcChannel } from "../../../bots/src/rpc";
import { createApp } from "../../../bots/src/server";
import { signedCallHeader } from "../../../bots/src/signed-call";

const ownerAddress = `0x${"11".repeat(20)}`;
const otherAddress = `0x${"22".repeat(20)}`;
const owner = `did:pkh:eip155:1:${ownerAddress}`;
const first = "a".repeat(32);
const second = "b".repeat(32);
const othersBot = "c".repeat(32);
const serviceSecret = "service-" + "x".repeat(64);
const backendCallSecret = "backend-call-" + "y".repeat(64);
const TOKEN = "1".repeat(64);
const BACKEND_ORIGIN = "https://backend.test";
const MESSAGE = "Please each send me your status by noon.";

/** A sandbox that speaks OMP's RPC frames: records what the service sends it and lets the test answer. */
class LocalRpc implements Sandbox {
  readonly #channel: RpcChannel;
  readonly #exit = Promise.withResolvers<void>();
  readonly #encoder = new TextEncoder();
  readonly #seen = new Map<string, Frame[]>();
  readonly #waiting = new Map<string, (frame: Frame) => void>();
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly exited = this.#exit.promise;
  prompts = 0;

  constructor() {
    const stdout = new ReadableStream<Uint8Array>({ start: controller => { this.#controller = controller; } });
    this.#channel = new RpcChannel(line => {
      const frame = JSON.parse(line) as Frame;
      if (frame.type === "prompt") this.prompts++;
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

const gatewayConfig = (egressRoot: string): GatewayConfig => ({
  egressRoot, modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 3, botDailyPages: 2, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
});

interface Listed {
  id: string;
  kind: string;
  state: string;
  binding?: string;
  outcomes?: Array<{ key: string; delivered: boolean }>;
}

const cleanup: Array<() => Promise<void> | void> = [];
/** Resolves when the supervisor logs that an approved send is over. */
let sent: ReturnType<typeof Promise.withResolvers<void>>;
beforeEach(() => {
  sent = Promise.withResolvers<void>();
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    if (args.some(arg => String(arg).includes(`"bots":"action_sent"`))) sent.resolve();
  });
  cleanup.push(() => spy.mockRestore());
});
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup() {
  // The backend: the real route over the real registry. The owner has Main and two other bots; another owner has one.
  const keys = [first, second, othersBot];
  const registry = new BotsRegistry(fakeRegistryStore(), { newKey: () => keys.shift()! });
  expect(await registry.create(ownerAddress, { name: "Scout", shape: "sprout", colour: "teal" }, 3)).toMatchObject({ ok: true });
  expect(await registry.create(ownerAddress, { name: "Clerk", shape: "sprout", colour: "teal" }, 3)).toMatchObject({ ok: true });
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
  const root = mkdtempSync(join(tmpdir(), "propose-admission-e2e-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const egressRoot = join(root, "egress");
  mkdirSync(egressRoot);
  const relay = createAdmissionRelay(BACKEND_ORIGIN, backendCallSecret, (url, init) => fetch(url.replace(BACKEND_ORIGIN, `http://127.0.0.1:${port}`), init));
  const control = Bun.serve({ unix: join(egressRoot, "control.sock"), fetch: relay });
  cleanup.push(() => control.stop(true));

  // The bots service: the manifest lists all three keys as active for this owner; only the backend knows whose they are.
  const manifest = new OwnerManifests(join(root, "manifest"));
  for (const key of ["main", first, second, othersBot]) manifest.announce(owner, key, "active", 1);
  const mainId = botIdFor(owner);
  const boxes = new Map([mainId, ...[first, second, othersBot].map(key => botIdFor(owner, key))].map(botId => [botId, new LocalRpc()]));
  const box = (key: string) => boxes.get(key === "main" ? mainId : botIdFor(owner, key))!;
  const gateway = new Gateway(gatewayConfig(egressRoot), { fetch: async () => Response.json({}), now: () => Date.now(), store: { load: () => undefined, save: () => {} } });
  gateway.setToken(mainId, TOKEN);
  const spends: boolean[] = [];
  const launcher: SandboxLauncher = {
    hasState: () => false, leftover: () => false, mountPoints: () => [],
    readsHeld: async () => false,
    launch: async layout => {
      const sandbox = boxes.get(layout.botId);
      if (!sandbox) throw new Error("unexpected launch");
      return sandbox;
    },
    syncAsks: (layout, turn) => {
      const adapter: AsksGateway = {
        drain: async () => ({ asks: gateway.drainAsks(layout.botId), outside: gateway.asksOutside(layout.botId) }),
        push: async body => gateway.setAsks(layout.botId, body),
      };
      return syncAsks(layout, adapter, turn, () => Date.now());
    },
    syncActions: (layout, turnKeys) => syncActions(layout, {
      drain: async () => ({ actions: gateway.drainActions(layout.botId) }),
      push: async body => gateway.setActions(layout.botId, body),
    }, turnKeys),
    spendAction: async (layout, id, binding) => {
      const spent = gateway.spendAction(layout.botId, id, binding);
      spends.push(spent);
      return spent;
    },
  };
  const bots = new BotManager(launcher, { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot }, {
    idleMs: 60_000, turnTimeoutMs: 4_000, maxTurnBytes: 64_000,
  }, 4);
  cleanup.push(() => bots.stopAll());
  const app = createApp({
    bots, secret: serviceSecret, accounts: "*", manifest, acceptLegacyOwnerHeader: false,
    admit: createAdmissionClient(egressRoot, admissionControlKey(backendCallSecret)),
  });

  const call = (method: string, rest: string, payload?: unknown) => {
    const path = `/v1/bots/main${rest}`;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const authorization = signedCallHeader(serviceSecret, { direction: "to-service", environment: "private", owner, bot: "main", method, path, body });
    return app(new Request(`http://bots.test${path}`, { method, headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }) }));
  };
  const requests = async () => ((await (await call("GET", "/requests")).json()) as { requests: Listed[] }).requests.filter(request => request.kind === "action");

  /** An owner turn in which Main proposes MESSAGE to `targets` on the gateway, as OMP would; the request the owner sees. */
  const propose = async (targets: string[]) => {
    expect((await call("PUT", "/asks", { enabled: true })).status).toBe(200);
    const response = await call("POST", "/messages", { text: "ask them", messageableBotKeys: targets });
    const prompt = await box("main").take("prompt");
    const tool = await gateway.handle(mainId, new Request("http://localhost/v1/mcp/app", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "propose_action", arguments: { kind: "message_bots", targets, text: MESSAGE } } }),
    }));
    expect(((await tool.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    box("main").finish(prompt, "proposed");
    expect(await response.text()).toContain("event: done");
    const pending = (await requests()).find(request => request.state === "pending");
    expect(pending?.binding).toBeDefined();
    return pending!;
  };
  /** The owner's Send, with the keys the backend fills in for Main. */
  const approve = (pending: Listed, targets: string[]) =>
    call("POST", `/requests/${pending.id}/answer`, { decision: "approve", binding: pending.binding, messageableBotKeys: targets });
  /** The request once the supervisor has logged the end of its send. */
  const settled = async (id: string) => {
    await sent.promise;
    return (await requests()).find(request => request.id === id)!;
  };
  return { box, backendCalls, spends, propose, approve, settled };
}

test("Send delivers Main's message to both of the owner's bots, each admitted by the backend once", async () => {
  const run = await setup();
  const pending = await run.propose([first, second]);
  expect(run.backendCalls).toEqual([]);

  expect((await run.approve(pending, [first, second])).status).toBe(200);
  for (const key of [first, second]) {
    const prompt = await run.box(key).take("prompt");
    expect(prompt.message).toBe(promptText(MESSAGE, "bot"));
    run.box(key).finish(prompt, "on it");
  }
  const done = await run.settled(pending.id);
  expect(done.state).toBe("done");
  expect(done.outcomes).toEqual([{ key: first, delivered: true }, { key: second, delivered: true }]);
  expect(run.spends).toEqual([true]);
  expect(run.backendCalls).toEqual(["POST /api/internal/bots/admit", "POST /api/internal/bots/admit"]);
}, 15_000);

test("a target the backend refuses gets nothing, while the owner's other bot gets the message", async () => {
  const run = await setup();
  // The manifest lists another owner's bot as active for this owner; the backend's registry says otherwise.
  const pending = await run.propose([first, othersBot]);

  expect((await run.approve(pending, [first, othersBot])).status).toBe(200);
  const prompt = await run.box(first).take("prompt");
  expect(prompt.message).toBe(promptText(MESSAGE, "bot"));
  run.box(first).finish(prompt, "on it");
  const done = await run.settled(pending.id);
  expect(done.outcomes).toEqual([{ key: first, delivered: true }, { key: othersBot, delivered: false }]);
  expect(run.box(othersBot).prompts).toBe(0);
  expect(run.spends).toEqual([true]);
  expect(run.backendCalls).toEqual(["POST /api/internal/bots/admit", "POST /api/internal/bots/admit"]);
}, 15_000);
