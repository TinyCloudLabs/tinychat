import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsksGateway, asksFile, readOutsideSeen, syncAsks } from "../asks";
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
const sibling = "a".repeat(32);
const secret = "ask-outside-" + "x".repeat(64);
const TOKEN = "1".repeat(64);

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

interface Run {
  readonly main: LocalRpc;
  readonly sibling: LocalRpc;
  readonly mainId: string;
  readonly gateways: { current: Gateway };
  readonly bots: BotManager;
  readonly outside: boolean[];
  layout(): BotLayout;
  newGateway(): Gateway;
  call(method: string, key: string, rest: string, payload?: unknown): Promise<Response>;
  enable(): Promise<void>;
  boxAsks(question: string): Promise<void>;
  boxSearches(): Promise<void>;
  /** One message from the owner to Main; `during` runs inside the turn, which the box then finishes. */
  ownerTurn(during?: () => Promise<void>): Promise<void>;
  /** Reads the questions the box has asked since the last time, notes whether each was marked, and declines them. */
  record(): Promise<void>;
  close(): Promise<void>;
}

function setup(): Run {
  const root = mkdtempSync(join(tmpdir(), "asks-outside-"));
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const manifest = new OwnerManifests(join(root, "manifest"));
  manifest.announce(owner, sibling, "active", 1);
  manifest.announce(owner, "main", "active", 1);
  const mainId = botIdFor(owner);
  const siblingId = botIdFor(owner, sibling);
  // Each launch gets the sandbox made ready for it; when that one stops, the next is made ready.
  const boxes = new Map<string, LocalRpc>();
  const ready = (botId: string) => {
    const box = new LocalRpc();
    const stop = box.stop.bind(box);
    box.stop = async () => { await stop(); ready(botId); };
    boxes.set(botId, box);
  };
  ready(mainId);
  ready(siblingId);
  const newGateway = () => {
    const created = new Gateway(gatewayConfig(), { fetch: async () => Response.json({}), now: () => Date.now(), store: { load: () => undefined, save: () => {} } });
    created.setToken(mainId, TOKEN);
    return created;
  };
  const gateways = { current: newGateway() };
  const launcher: SandboxLauncher = {
    hasState: () => false,
    leftover: () => false,
    mountPoints: () => [],
    launch: async layout => boxes.get(layout.botId)!,
    syncAsks: (layout, turn) => {
      const adapter: AsksGateway = {
        drain: async () => ({ asks: gateways.current.drainAsks(layout.botId), outside: gateways.current.asksOutside(layout.botId) }),
        push: async body => gateways.current.setAsks(layout.botId, body),
      };
      return syncAsks(layout, adapter, turn, () => Date.now());
    },
  };
  const bots = new BotManager(launcher, roots, { idleMs: 60_000, turnTimeoutMs: 4_000, maxTurnBytes: 64_000 }, 3);
  const admit: BotAdmission = async () => ({ admitted: true });
  const app = createApp({ bots, secret, accounts: "*", manifest, acceptLegacyOwnerHeader: true, admit });

  const call: Run["call"] = (method, key, rest, payload) => {
    const path = `/v1/bots/${key}${rest}`;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const authorization = signedCallHeader(secret, { direction: "to-service", environment: "private", owner, bot: key, method, path, body });
    return app(new Request(`http://fixture.test${path}`, {
      method, headers: { authorization, "x-tinycloud-owner": owner, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }),
    }));
  };
  const rpc = (path: string, params: unknown) => new Request(`http://localhost${path}`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
  });
  const outside: boolean[] = [];
  return {
    get main() { return boxes.get(mainId)!; },
    get sibling() { return boxes.get(siblingId)!; },
    mainId, gateways, bots, outside, newGateway, call,
    layout: () => botLayout(mainId, roots),
    enable: async () => void (await call("PUT", "main", "/asks", { enabled: true })),
    boxAsks: async question => {
      const response = await gateways.current.handle(mainId, rpc("/v1/mcp/app", { name: "ask_owner", arguments: { question } }));
      expect(((await response.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    },
    // The gateway sees the call whatever the search provider answers.
    boxSearches: async () => void (await (await gateways.current.handle(mainId, rpc("/v1/mcp", { name: "search", arguments: { query: "anything" } }))).text()),
    ownerTurn: async (during = async () => {}) => {
      const response = await call("POST", "main", "/messages", { text: "hello", messageableBotKeys: [sibling] });
      const main = boxes.get(mainId)!;
      const prompt = await main.take("prompt");
      await during();
      main.finish(prompt, "ok");
      await response.text();
    },
    record: async () => {
      const listed = (await (await call("GET", "main", "/requests")).json()) as { requests: Array<{ id: string; state: string; outside: boolean }> };
      for (const request of listed.requests.filter(entry => entry.state === "pending")) {
        outside.push(request.outside);
        await call("POST", "main", `/requests/${request.id}/answer`, { decision: "decline" });
      }
    },
    close: async () => { await bots.stopAll(); rmSync(root, { recursive: true, force: true }); },
  };
}

let run: Run;
beforeEach(() => { run = setup(); });
afterEach(async () => { await run.close(); });

/** A turn in which Main asks one question, and what the supervisor then makes of it. */
const asksInTurn = async (question: string) => {
  await run.ownerTurn(async () => { await run.boxAsks(question); });
  await run.record();
};

describe("whether outside text has reached Main's conversation", () => {
  test("a web call in one turn marks the questions of the turns after it, across a restart of the sandbox and of the gateway", async () => {
    await run.enable();
    await asksInTurn("before the web?");
    await run.ownerTurn(async () => { await run.boxSearches(); });
    await asksInTurn("next turn?");
    await asksInTurn("the turn after?");
    // The sandbox ends and the gateway forgets it; the next one starts from what the supervisor kept.
    run.gateways.current.dropToken(run.mainId);
    run.gateways.current.setToken(run.mainId, TOKEN);
    await asksInTurn("after a new sandbox?");
    // A gateway that restarted knows nothing of the conversation either.
    run.gateways.current = run.newGateway();
    await asksInTurn("after a new gateway?");
    expect(run.outside).toEqual([false, true, true, true, true]);
  });

  test("a turn that began with another bot's message marks every question after it, and only after it", async () => {
    await run.enable();
    await asksInTurn("from the owner?");
    // The other bot reaches Main: Main's turn on that message is one from a bot.
    const response = await run.call("POST", sibling, "/messages", { text: "please relay", messageableBotKeys: ["main"] });
    const siblingPrompt = await run.sibling.take("prompt");
    run.sibling.emit({ type: "host_tool_call", id: "relay", toolCallId: "relay", toolName: "message_bot", arguments: { targetKey: "main", text: "a note from the other bot" } });
    const mainPrompt = await run.main.take("prompt");
    expect(mainPrompt.message).toBe("a note from the other bot");
    run.main.finish(mainPrompt, "noted");
    await run.sibling.take("host_tool_result");
    run.sibling.finish(siblingPrompt, "done");
    await response.text();
    await asksInTurn("a turn later?");
    await asksInTurn("another turn later?");
    expect(run.outside).toEqual([false, true, true]);
  });

  test("a reply from another bot marks what Main asks after it in the same turn and in later turns", async () => {
    await run.enable();
    await run.ownerTurn(async () => {
      await run.boxAsks("before the reply?");
      run.main.emit({ type: "host_tool_call", id: "relay", toolCallId: "relay", toolName: "message_bot", arguments: { targetKey: sibling, text: "what do you know?" } });
      const siblingPrompt = await run.sibling.take("prompt");
      run.sibling.finish(siblingPrompt, "something a page said");
      await run.main.take("host_tool_result");
      await run.boxAsks("after the reply?");
    });
    await run.record();
    await asksInTurn("a turn later?");
    expect(run.outside).toEqual([false, true, true]);
  });

  test("the owner's own messages and a refused call to another bot mark nothing", async () => {
    await run.enable();
    await run.ownerTurn(async () => {
      run.main.emit({ type: "host_tool_call", id: "bad", toolCallId: "bad", toolName: "message_bot", arguments: { targetKey: sibling } });
      await run.main.take("host_tool_result");
      await run.boxAsks("only the owner so far?");
    });
    await run.record();
    await asksInTurn("and a turn later?");
    expect(run.outside).toEqual([false, false]);
    expect(readOutsideSeen(run.layout())).toBe(false);
  });

  test("it is kept in asks.json beside the setting, and changing the setting does not lose it", async () => {
    await run.enable();
    await run.ownerTurn(async () => { await run.boxSearches(); });
    await run.call("GET", "main", "/requests");
    expect(JSON.parse(readFileSync(asksFile(run.layout()), "utf8"))).toEqual({ enabled: true, outsideSeen: true });
    await run.call("PUT", "main", "/asks", { enabled: false });
    expect(JSON.parse(readFileSync(asksFile(run.layout()), "utf8"))).toEqual({ enabled: false, outsideSeen: true });
    await run.enable();
    await asksInTurn("after the setting changed?");
    expect(run.outside).toEqual([true]);
  });

  test("a web call nobody has collected yet is kept when the sandbox is stopped", async () => {
    await run.enable();
    await run.ownerTurn();
    await run.boxSearches();
    expect(readOutsideSeen(run.layout())).toBe(false);
    await run.bots.stopAll();
    expect(readOutsideSeen(run.layout())).toBe(true);
  });

  test("resetting the bot's working state clears it, and what Main asks afterwards is not marked", async () => {
    await run.enable();
    await run.ownerTurn(async () => { await run.boxSearches(); });
    await run.call("GET", "main", "/requests");
    expect(readOutsideSeen(run.layout())).toBe(true);

    expect(await run.bots.forOwner(owner).deleteWorkingState("test")).toBeUndefined();
    expect(existsSync(asksFile(run.layout()))).toBe(false);
    // The sandbox's end is the gateway's cue to forget it too.
    run.gateways.current.dropToken(run.mainId);
    run.gateways.current.setToken(run.mainId, TOKEN);
    await run.enable();
    await asksInTurn("after the reset?");
    expect(run.outside).toEqual([false]);
    expect(readOutsideSeen(run.layout())).toBe(false);
  });
});
