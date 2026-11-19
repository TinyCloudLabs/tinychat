import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotAdmission } from "../bot-admission";
import { BotManager, type Sandbox, type SandboxLauncher } from "../bot";
import { gatewayConfig } from "../config";
import { Gateway } from "../gateway";
import type { BotLayout } from "../layout";
import { OwnerManifests } from "../manifest";
import { botIdFor } from "../owner";
import { type Frame, RpcChannel } from "../rpc";
import { createApp } from "../server";
import { signedCallHeader } from "../signed-call";

const owner = `did:pkh:eip155:1:0x${"11".repeat(20)}`;
const otherOwner = `did:pkh:eip155:1:0x${"22".repeat(20)}`;
const sibling = "a".repeat(32);
const foreign = "b".repeat(32);
const unknown = "c".repeat(32);
const secret = "message-bot-" + "x".repeat(64);
const callText = "message from the source model";
const replyText = "reply from the target model";

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
      if (frame.type !== "host_tool_result") {
        this.emit({ type: "response", id: frame.id, success: true, data: { agentInvoked: true } });
      }
    }, stdout);
  }

  take(type: string): Promise<Frame> {
    const seen = this.#seen.get(type)?.shift();
    if (seen) return Promise.resolve(seen);
    const { promise, resolve } = Promise.withResolvers<Frame>();
    this.#waiting.set(type, resolve);
    return promise;
  }

  seen(type: string) { return this.#seen.get(type)?.length ?? 0; }
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

const statusRefusals = {
  suspended: "target_not_active", deleting: "target_not_active", removed: "unknown_target", regular: "different_environment",
} as const;

function setup(onLaunch?: (layout: BotLayout) => void) {
  const root = mkdtempSync(join(tmpdir(), "message-bot-"));
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const manifest = new OwnerManifests(join(root, "manifest"));
  manifest.announce(owner, sibling, "active", 1);
  manifest.announce(otherOwner, foreign, "active", 1);
  const sandboxes = new Map<string, LocalRpc>();
  const started: string[] = [];
  const launcher: SandboxLauncher = {
    hasState: () => false, leftover: () => false,
    launch: async layout => {
      started.push(layout.botId);
      onLaunch?.(layout);
      const sandbox = sandboxes.get(layout.botId);
      if (!sandbox) throw new Error("unexpected launch");
      return sandbox;
    },
  };
  const source = new LocalRpc();
  const target = new LocalRpc();
  sandboxes.set(botIdFor(owner), source);
  sandboxes.set(botIdFor(owner, sibling), target);
  const bots = new BotManager(launcher, roots, {
    idleMs: 60_000, turnTimeoutMs: 4_000, maxTurnBytes: 64_000,
    history: { signerDid: owner, host: "http://127.0.0.1:9573", policy: "notice-then-expiry-30-days" },
  }, 3);
  const decisions: string[][] = [];
  let registryState: "allowed" | keyof typeof statusRefusals = "allowed";
  const admission: BotAdmission = async (account, from, to) => {
    decisions.push([account, from, to]);
    if (account !== owner || from !== "main" || to !== sibling) return { admitted: false, reason: "unknown_target" };
    return registryState === "allowed" ? { admitted: true } : { admitted: false, reason: statusRefusals[registryState] };
  };
  let admit = admission;
  const app = createApp({ bots, secret, accounts: "*", manifest, acceptLegacyOwnerHeader: true, admit: (...args) => admit(...args) });
  const send = (key: string, suffix: string, method: string, payload: unknown, legacy = false) => {
    const path = `/v1/bots/${key}${suffix}`;
    const body = JSON.stringify(payload);
    const authorization = legacy ? `Bearer ${secret}` : signedCallHeader(secret, {
      direction: "to-service", environment: "private", owner, bot: key, method, path, body,
    });
    const headers = { authorization, "x-tinycloud-owner": owner, "content-type": "application/json" };
    return app(new Request(`http://fixture.test${path}`, { method, headers, body }));
  };
  const turn = (key: string, messageableBotKeys?: unknown, legacy?: boolean) =>
    send(key, "/messages", "POST", { text: "owner turn", messageableBotKeys }, legacy);
  const announce = (state: string, seq: number) => send(sibling, "", "PUT", { state, seq });
  const close = async () => {
    await bots.stopAll();
    rmSync(root, { recursive: true, force: true });
  };
  return { source, target, decisions, started, close, announce, turn,
    setAdmission(check: BotAdmission) { admit = check; },
    setRegistryState(state: typeof registryState) { registryState = state; },
    readActivities: () => bots.forOwner(owner).listActivities(),
  };
}

test("message_bot delivers a sibling reply, records only a key and count, and cannot take a second hop", async () => {
  const run = setup();
  try {
    const response = await run.turn("main", [sibling]);
    const tools = await run.source.take("set_host_tools");
    expect(JSON.stringify(tools.tools)).toContain(sibling);
    expect(JSON.stringify(tools.tools)).not.toContain(foreign);
    const sourcePrompt = await run.source.take("prompt");
    run.source.call("foreign", { targetKey: foreign, text: callText });
    expect(await run.source.take("host_tool_result")).toMatchObject({ id: "foreign", isError: true });
    run.source.call("owner", { targetKey: sibling, text: callText, owner: otherOwner });
    expect(await run.source.take("host_tool_result")).toMatchObject({ id: "owner", isError: true });
    expect(run.decisions).toEqual([]);
    for (const id of ["first", "second"]) {
      run.source.call(id, { targetKey: sibling, text: callText });
      const targetPrompt = await run.target.take("prompt");
      expect(targetPrompt.message).toBe(callText);
      expect(run.target.seen("set_host_tools")).toBe(0);
      run.target.call("second-hop", { targetKey: "main", text: replyText });
      expect(await run.target.take("host_tool_result")).toMatchObject({ id: "second-hop", isError: true });
      run.target.finish(targetPrompt, replyText);
      expect(await run.source.take("host_tool_result")).toEqual({
        type: "host_tool_result", id, result: { content: [{ type: "text", text: replyText }] },
      });
      if (id === "first") {
        // A copied host request must not dispatch again.
        run.source.call(id, { targetKey: sibling, text: callText });
        // Send another frame to establish that the copied frame has been read.
        run.source.call("read-barrier", { targetKey: unknown, text: callText });
        expect(await run.source.take("host_tool_result")).toMatchObject({ id: "read-barrier", isError: true });
      }
    }
    run.source.finish(sourcePrompt, "finished");
    expect(await run.source.take("set_host_tools")).toMatchObject({ tools: [] });
    const stream = await response.text();
    const activity = JSON.parse(/^event: activity\ndata: (.+)$/m.exec(stream)![1]!);
    expect(activity).toEqual({ type: "activity", verb: "messaged_bot", id: expect.any(String), at: expect.any(String), count: 2, targetKey: sibling });
    expect(stream).not.toContain(callText);
    expect(stream).not.toContain(replyText);
    expect(await run.readActivities()).toEqual([activity]);
    expect(run.decisions).toEqual([[owner, "main", sibling], [owner, "main", sibling]]);
  } finally {
    await run.close();
  }
}, 15_000);

test("dispatch refuses registry changes while the manifest stays active and ignores a late older active update", async () => {
  const run = setup();
  try {
    const response = await run.turn("main", [sibling]);
    const prompt = await run.source.take("prompt");
    for (const state of ["suspended", "deleting", "removed", "regular"] as const) {
      run.setRegistryState(state);
      run.source.call(state, { targetKey: sibling, text: callText });
      expect(await run.source.take("host_tool_result")).toMatchObject({
        id: state, isError: true, result: { content: [{ type: "text", text: "That bot is unavailable." }] },
      });
    }
    expect(await (await run.announce("suspended", 3)).json()).toEqual({ state: "suspended" });
    expect(await (await run.announce("active", 2)).json()).toEqual({ state: "suspended" });
    run.setRegistryState("allowed");
    run.source.call("local-suspension", { targetKey: sibling, text: callText });
    expect(await run.source.take("host_tool_result")).toMatchObject({ id: "local-suspension", isError: true });
    run.source.finish(prompt, "finished");
    expect(await response.text()).not.toContain("event: activity");
    expect(run.started).toEqual([botIdFor(owner)]);
    await run.source.take("set_host_tools");
    await run.source.take("set_host_tools");

    const afterRegistryCommit = await run.turn("main", []);
    const laterPrompt = await run.source.take("prompt");
    expect(run.source.seen("set_host_tools")).toBe(0);
    run.source.call("stale-model-tool", { targetKey: sibling, text: callText });
    expect(await run.source.take("host_tool_result")).toMatchObject({ id: "stale-model-tool", isError: true });
    run.source.finish(laterPrompt, "finished");
    expect(await afterRegistryCommit.text()).toContain("event: done");
    expect(run.decisions).toHaveLength(5);
  } finally {
    await run.close();
  }
});

test("a malformed roster disables the whole tool and a busy sibling returns a tool error", async () => {
  const run = setup();
  try {
    const malformed = await run.turn("main", [sibling, "not-a-key"]);
    const malformedPrompt = await run.source.take("prompt");
    expect(run.source.seen("set_host_tools")).toBe(0);
    run.source.finish(malformedPrompt, "finished");
    await malformed.text();

    const legacy = await run.turn("main", [sibling], true);
    const legacyPrompt = await run.source.take("prompt");
    expect(run.source.seen("set_host_tools")).toBe(0);
    run.source.finish(legacyPrompt, "finished");
    expect(await legacy.text()).toContain("event: done");

    const target = await run.turn(sibling);
    const targetPrompt = await run.target.take("prompt");
    const response = await run.turn("main", [sibling]);
    const prompt = await run.source.take("prompt");
    run.source.call("busy", { targetKey: sibling, text: callText });
    expect(await run.source.take("host_tool_result")).toMatchObject({
      id: "busy", isError: true, result: { content: [{ type: "text", text: "That bot is busy." }] },
    });
    run.source.finish(prompt, "finished");
    run.target.finish(targetPrompt, "finished");
    expect(await response.text()).not.toContain("event: activity");
    expect(await target.text()).toContain("event: done");
  } finally {
    await run.close();
  }
});

test("cancelled and unknown deliveries never acquire a target sandbox", async () => {
  const run = setup();
  const admissionStarted = Promise.withResolvers<void>();
  const decision = Promise.withResolvers<Awaited<ReturnType<BotAdmission>>>();
  run.setAdmission(async (_, __, target) => {
    if (target === sibling) {
      admissionStarted.resolve();
      return decision.promise;
    }
    return { admitted: true };
  });
  try {
    const response = await run.turn("main", [sibling, unknown]);
    const prompt = await run.source.take("prompt");
    run.source.call("cancel", { targetKey: sibling, text: callText });
    await admissionStarted.promise;
    run.source.emit({ type: "host_tool_cancel", id: "cancel-ack", targetId: "cancel" });
    run.source.call("unknown", { targetKey: unknown, text: callText });
    expect(await run.source.take("host_tool_result")).toMatchObject({ id: "unknown", isError: true });
    decision.resolve({ admitted: true });
    run.source.finish(prompt, "finished");
    expect(await response.text()).toContain("event: done");
    expect(run.source.seen("host_tool_result")).toBe(0);
    expect(run.started).toEqual([botIdFor(owner)]);
  } finally {
    await run.close();
  }
});

test("the source and its messaged sibling spend from one owner budget", async () => {
  const cfg = gatewayConfig({ REDPILL_API_KEY: "fixture", BOTS_OWNER_DAILY_TOKENS: "1000", BOTS_MAX_TOKENS: "500" });
  const gateway = new Gateway(cfg, {
    fetch: async () => Response.json({ usage: { total_tokens: 500 } }),
  });
  const token = (key: string) => botIdFor(owner, key);
  const run = setup(layout => gateway.setToken(layout.botId, layout.botId, layout.ownerId));
  const charge = async (key: string) => {
    const response = await gateway.handle(token(key), new Request("http://gateway/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${token(key)}` },
      body: JSON.stringify({ model: cfg.models[0], messages: [{ role: "user", content: "fixture" }] }),
    }));
    await response.text();
    return response.status;
  };
  try {
    const response = await run.turn("main", [sibling]);
    const sourcePrompt = await run.source.take("prompt");
    expect(await charge("main")).toBe(200);
    run.source.call("fits", { targetKey: sibling, text: callText });
    const first = await run.target.take("prompt");
    expect(await charge(sibling)).toBe(200);
    run.target.finish(first, replyText);
    expect(await run.source.take("host_tool_result")).toMatchObject({ id: "fits" });
    run.source.call("over-budget", { targetKey: sibling, text: callText });
    const second = await run.target.take("prompt");
    expect(await charge(sibling)).toBe(429);
    expect(await charge("main")).toBe(429);
    run.target.emit({ type: "prompt_result", id: second.id, status: "error", sessionSettled: true });
    expect(await run.source.take("host_tool_result")).toMatchObject({ id: "over-budget", isError: true });
    run.source.finish(sourcePrompt, "finished");
    await response.text();
    expect(await run.readActivities()).toEqual([
      expect.objectContaining({ verb: "messaged_bot", count: 1, targetKey: sibling }),
    ]);
  } finally {
    await run.close();
  }
});
