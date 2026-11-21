import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_REPLIES, type AsksGateway, requestsFile, syncAsks, writeAsksEnabled } from "../asks";
import type { BotAdmission } from "../bot-admission";
import { BotManager, type Sandbox, type SandboxLauncher } from "../bot";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import { Gateway } from "../gateway";
import { type BotLayout, botLayout } from "../layout";
import { OwnerManifests } from "../manifest";
import { botIdFor } from "../owner";
import { type Frame, RpcChannel } from "../rpc";
import { createApp } from "../server";
import { signedCallHeader } from "../signed-call";

const owner = `did:pkh:eip155:1:0x${"11".repeat(20)}`;
const secret = "ask-off-" + "x".repeat(64);
const TOKEN = "1".repeat(64);
const QUESTION = "SECRET-QUESTION-text-4c1e";
const CHOICE = "SECRET-CHOICE-text-0b7a";
const STOPPED_SENTENCE = "The person turned off questions from you, so your open questions were closed without an answer. Carry on without asking.";
const DAY = 24 * 3_600_000;

/** Stands in for OMP behind the RPC channel: records the frames it is sent and lets the test answer them. */
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
        const seen = this.#seen.get(frame.type) ?? [];
        seen.push(frame);
        this.#seen.set(frame.type, seen);
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

const gatewayConfig = (): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 3, botDailyPages: 2, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
});

interface Listed { id: string; state: string; undelivered?: true; question?: string; choices?: string[]; answer?: string; outside: boolean }
interface Run {
  readonly main: LocalRpc;
  readonly gateway: Gateway;
  layout(): BotLayout;
  call(method: string, rest: string, payload?: unknown): Promise<Response>;
  /** The box asks a question; the answer is what the gateway told it. */
  boxAsks(question: string, choices?: string[]): Promise<{ text: string; isError: boolean }>;
  setting(enabled: boolean): Promise<Response>;
  /** The question reaches the owner's list (listing collects it from the gateway); answers its id. */
  asked(question?: string, choices?: string[]): Promise<string>;
  requests(): Promise<Listed[]>;
  /** The app sends the reply for one request and the box's turn is played; answers what Main was sent. */
  reply(requestId: string): Promise<{ status: number; body: string; prompt?: string }>;
  history(): Promise<Array<{ id: string; role: string; text: string; at: string; origin?: string; decision?: string }>>;
  close(): Promise<void>;
}

const realNow = Date.now;
let skew = 0;

function setup(): Run {
  const root = mkdtempSync(join(tmpdir(), "asks-off-"));
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const manifest = new OwnerManifests(join(root, "manifest"));
  const mainId = botIdFor(owner);
  const main = new LocalRpc();
  const gateway = new Gateway(gatewayConfig(), { fetch: async () => Response.json({}), now: () => Date.now(), store: { load: () => undefined, save: () => {} } });
  gateway.setToken(mainId, TOKEN);
  const launcher: SandboxLauncher = {
    hasState: () => false,
    leftover: () => false,
    launch: async () => main,
    syncAsks: (layout, turn) => {
      const adapter: AsksGateway = {
        drain: async () => ({ asks: gateway.drainAsks(layout.botId), outside: gateway.asksOutside(layout.botId) }),
        push: async body => gateway.setAsks(layout.botId, body),
      };
      return syncAsks(layout, adapter, turn, () => Date.now());
    },
  };
  const bots = new BotManager(launcher, roots, {
    idleMs: 60_000, turnTimeoutMs: 4_000, maxTurnBytes: 64_000,
    history: { signerDid: owner, host: "http://127.0.0.1:9573", policy: "notice-then-expiry-30-days" },
  }, 3);
  const admit: BotAdmission = async () => ({ admitted: true });
  const app = createApp({ bots, secret, accounts: "*", manifest, acceptLegacyOwnerHeader: true, admit });

  const call: Run["call"] = (method, rest, payload) => {
    const path = `/v1/bots/main${rest}`;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const authorization = signedCallHeader(secret, { direction: "to-service", environment: "private", owner, bot: "main", method, path, body });
    return app(new Request(`http://fixture.test${path}`, {
      method, headers: { authorization, "x-tinycloud-owner": owner, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }),
    }));
  };
  const requests = async () => ((await (await call("GET", "/requests")).json()) as { requests: Listed[] }).requests;
  const boxAsks: Run["boxAsks"] = async (question, choices) => {
    const response = await gateway.handle(mainId, new Request("http://localhost/v1/mcp/app", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_owner", arguments: { question, ...(choices ? { choices } : {}) } } }),
    }));
    const result = ((await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    return { text: result.content[0]!.text, isError: result.isError === true };
  };
  return {
    main, gateway, call, requests, boxAsks,
    layout: () => botLayout(mainId, roots),
    setting: enabled => call("PUT", "/asks", { enabled }),
    asked: async (question = QUESTION, choices = [CHOICE]) => {
      await call("PUT", "/asks", { enabled: true });
      const asked = await boxAsks(question, choices);
      expect(asked.isError).toBe(false);
      await requests();
      return (JSON.parse(asked.text) as { id: string }).id;
    },
    reply: async requestId => {
      const response = await call("POST", "/messages", { appReply: { requestId } });
      if (response.status !== 200) return { status: response.status, body: await response.text() };
      const prompt = await main.take("prompt");
      main.finish(prompt, "noted");
      return { status: 200, body: await response.text(), prompt: prompt.message as string };
    },
    history: async () => ((await (await call("GET", "/messages")).json()) as { messages: Array<{ id: string; role: string; text: string; at: string; origin?: string; decision?: string }> }).messages,
    close: async () => { await bots.stopAll(); rmSync(root, { recursive: true, force: true }); },
  };
}

let run: Run;
let dateNow: { mockRestore(): void };
let logs: { mockRestore(): void };
let lines: string[];
beforeEach(() => {
  skew = 0;
  lines = [];
  dateNow = spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  logs = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  run = setup();
});
afterEach(async () => { await run.close(); dateNow.mockRestore(); logs.mockRestore(); });

describe("turning the setting off", () => {
  test("closes every pending question at once: stopped, undelivered, the text gone from the records and from the list", async () => {
    const first = await run.asked("First SECRET-QUESTION-text-4c1e?");
    const second = await run.asked("Second SECRET-QUESTION-text-4c1e?");
    expect(await run.requests()).toMatchObject([{ id: first, state: "pending" }, { id: second, state: "pending" }]);

    const off = await run.setting(false);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ enabled: false });

    const listed = await run.requests();
    expect(listed.map(request => [request.id, request.state, request.undelivered])).toEqual([[first, "stopped", true], [second, "stopped", true]]);
    for (const request of listed) {
      expect(request.question).toBeUndefined();
      expect(request.choices).toBeUndefined();
      expect(request.answer).toBeUndefined();
    }
    const stored = readFileSync(requestsFile(run.layout()), "utf8");
    expect(stored).not.toContain("SECRET");
    expect(JSON.parse(stored).asks.map((ask: { state: string }) => ask.state)).toEqual(["stopped", "stopped"]);
  });

  test("tells Main once per closed question, in the fixed sentence, while the setting is still off", async () => {
    const first = await run.asked("First?");
    const second = await run.asked("Second?");
    await run.setting(false);

    const one = await run.reply(first);
    expect(one.status).toBe(200);
    expect(one.prompt).toBe(STOPPED_SENTENCE);
    expect(one.prompt).toBe(ASK_REPLIES.stopped);
    expect(await run.reply(first)).toMatchObject({ status: 409, body: JSON.stringify({ error: "no_reply" }) });
    expect((await run.reply(second)).prompt).toBe(STOPPED_SENTENCE);
    expect((await run.reply(second)).status).toBe(409);

    const told = (await run.history()).filter(message => message.origin === "app");
    expect(told).toEqual([
      { id: expect.any(String), role: "user", text: STOPPED_SENTENCE, at: expect.any(String), origin: "app", decision: "stopped" },
      { id: expect.any(String), role: "user", text: STOPPED_SENTENCE, at: expect.any(String), origin: "app", decision: "stopped" },
    ]);
    expect((await run.requests()).map(request => [request.state, request.undelivered])).toEqual([["stopped", undefined], ["stopped", undefined]]);
  });

  test("does not count the closing as an answer, and a closed question is not held against being asked again once the setting is back on", async () => {
    const id = await run.asked("Which city?");
    await run.setting(false);
    expect((await run.requests())[0]).toMatchObject({ id, state: "stopped" });
    expect((await run.requests())[0]!.answer).toBeUndefined();

    await run.setting(true);
    // Nothing comes back as pending, and the same question may be asked at once: only a decline makes a cooldown.
    expect((await run.requests()).filter(request => request.state === "pending")).toEqual([]);
    const again = await run.boxAsks("Which city?");
    expect(again.isError).toBe(false);
    expect((await run.requests()).map(request => request.state)).toEqual(["pending", "stopped"]);
  });

  test("leaves a question the owner declined with its cooldown, which only a decline makes", async () => {
    const declined = await run.asked("Which city?");
    await run.call("POST", `/requests/${declined}/answer`, { decision: "decline" });
    await run.setting(false);
    await run.setting(true);
    const refused = await run.boxAsks("Which city?");
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("not now");
  });

  test("drops a question the gateway holds and the supervisor has not collected, and it is never stored", async () => {
    await run.call("PUT", "/asks", { enabled: true });
    expect((await run.boxAsks(QUESTION)).isError).toBe(false);
    await run.setting(false);
    expect(run.gateway.drainAsks(run.layout().botId)).toEqual([]);
    expect(await run.requests()).toEqual([]);
    await run.setting(true);
    expect(await run.requests()).toEqual([]);
  });

  test("a question that reaches the gateway while the setting is already off is not stored as pending when it is collected", async () => {
    await run.call("PUT", "/asks", { enabled: true });
    expect((await run.boxAsks(QUESTION)).isError).toBe(false);
    // The owner's setting is saved off before the gateway has been told.
    writeAsksEnabled(run.layout(), false);
    expect(await run.requests()).toEqual([]);
    expect(run.gateway.drainAsks(run.layout().botId)).toEqual([]);
    expect((await run.boxAsks("After it was told?")).isError).toBe(true);
  });

  test("a question that arrives between the collection and the off push is dropped by the push", async () => {
    await run.call("PUT", "/asks", { enabled: true });
    expect((await run.boxAsks(QUESTION)).isError).toBe(false);
    run.gateway.setAsks(run.layout().botId, { enabled: false, pending: 0, day: "2025-01-01", today: 0, declined: [] });
    expect(run.gateway.drainAsks(run.layout().botId)).toEqual([]);
  });

  test("leaves answered, declined and expired requests as they were", async () => {
    const expired = await run.asked("Expires?");
    skew = DAY + 1000;
    expect((await run.requests())[0]).toMatchObject({ id: expired, state: "expired" });
    const answered = await run.asked("Answered?");
    const declined = await run.asked("Declined?");
    await run.call("POST", `/requests/${answered}/answer`, { decision: "answer", answer: "Oslo" });
    await run.call("POST", `/requests/${declined}/answer`, { decision: "decline" });
    const pending = await run.asked("Still open?");
    const before = await run.requests();
    expect(Object.fromEntries(before.map(request => [request.id, request.state]))).toEqual({ [pending]: "pending", [answered]: "answered", [declined]: "declined", [expired]: "expired" });
    await run.setting(false);
    const after = await run.requests();
    const byId = new Map(after.map(request => [request.id, request]));
    expect(byId.get(pending)).toMatchObject({ state: "stopped", undelivered: true });
    expect(byId.get(answered)).toEqual(before.find(request => request.id === answered)!);
    expect(byId.get(declined)).toEqual(before.find(request => request.id === declined)!);
    expect(byId.get(expired)).toEqual(before.find(request => request.id === expired)!);
    expect(byId.get(answered)).toMatchObject({ state: "answered", answer: "Oslo", undelivered: true });
  });

  test("writes no question, choice or reply text to any log line", async () => {
    const id = await run.asked(QUESTION, [CHOICE]);
    await run.setting(false);
    await run.reply(id);
    await run.setting(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("SECRET");
      expect(line).not.toContain(STOPPED_SENTENCE);
      expect(line).not.toContain(id);
    }
  });
});
