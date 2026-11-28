// TC-3808: a launcher that cannot say whether the conversation holds owner data counts as held. message_bot is refused
// at dispatch, reaching neither admission nor the sibling, and the owner's Send on a proposal is refused as `held`.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionStore, actionBinding } from "../actions";
import type { BotAdmission } from "../bot-admission";
import { type BotMessenger, BotManager, type Sandbox, type SandboxLauncher } from "../bot";
import { botLayout } from "../layout";
import { OwnerManifests } from "../manifest";
import { MESSAGING_STRINGS } from "../messaging-strings";
import { botIdFor } from "../owner";
import { type Frame, RpcChannel } from "../rpc";
import { createApp } from "../server";
import { signedCallHeader } from "../signed-call";

const owner = `did:pkh:eip155:1:0x${"33".repeat(20)}`;
const sibling = "a".repeat(32);
const secret = "no-reads-held-" + "x".repeat(64);
const mainId = botIdFor(owner);

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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "no-reads-held-"));
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const manifest = new OwnerManifests(join(root, "manifest"));
  manifest.announce(owner, sibling, "active", 1);
  const main = new LocalRpc();
  const target = new LocalRpc();
  const sandboxes = new Map<string, LocalRpc>([[mainId, main], [botIdFor(owner, sibling), target]]);
  // No readsHeld: the launcher cannot answer.
  const launcher: SandboxLauncher = {
    hasState: () => false, leftover: () => false, mountPoints: () => [],
    launch: async layout => {
      const sandbox = sandboxes.get(layout.botId);
      if (!sandbox) throw new Error("unexpected launch");
      return sandbox;
    },
    spendAction: async () => true,
  };
  const bots = new BotManager(launcher, roots, { idleMs: 60_000, turnTimeoutMs: 4_000, maxTurnBytes: 64_000 }, 3);
  const decisions: string[][] = [];
  const admit: BotAdmission = async (account, from, to) => {
    decisions.push([account, from, to]);
    return { admitted: true };
  };
  const app = createApp({ bots, secret, accounts: "*", manifest, acceptLegacyOwnerHeader: true, admit });
  const turn = (key: string, messageableBotKeys?: string[]) => {
    const path = `/v1/bots/${key}/messages`;
    const body = JSON.stringify({ text: "owner turn", messageableBotKeys });
    const authorization = signedCallHeader(secret, { direction: "to-service", environment: "private", owner, bot: key, method: "POST", path, body });
    return app(new Request(`http://fixture.test${path}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body }));
  };
  return { bots, roots, decisions, turn, main, target, close: async () => { await bots.stopAll(); rmSync(root, { recursive: true, force: true }); } };
}

test("message_bot is refused when the launcher cannot say whether the chat holds owner data", async () => {
  const run = setup();
  try {
    const first = await run.turn("main", [sibling]);
    await run.main.take("set_host_tools");
    const prompt = await run.main.take("prompt");
    run.main.call("unknown", { targetKey: sibling, text: "pass this on" });
    expect(await run.main.take("host_tool_result")).toMatchObject({
      id: "unknown", isError: true, result: { content: [{ type: "text", text: MESSAGING_STRINGS.held }] },
    });
    expect(run.decisions).toEqual([]);
    expect(run.target.seen("prompt")).toBe(0);
    run.main.finish(prompt, "finished");
    expect(await first.text()).toContain("event: done");
  } finally { await run.close(); }
}, 30_000);

test("an exact owner-approved Send does not depend on the unapproved-export hold check", async () => {
  const run = setup();
  try {
    const layout = botLayout(mainId, run.roots);
    const payload = { kind: "message_bots" as const, targets: [sibling], text: "Please send me your status by noon." };
    const binding = actionBinding(layout.ownerId, mainId, payload);
    const id = "9c41e0d2a7b3f6c18e5d2a91";
    new ActionStore(layout).ingest([{ id, ...payload, binding, askedAt: Date.now(), outside: false }]);
    const sent: string[] = [];
    const messenger: BotMessenger = { keys: [sibling], dispatch: async (_key, text) => { sent.push(text); return { text: "Delivered" }; } };
    expect((await run.bots.forOwner(owner).approveRequest(id, binding, messenger)).ok).toBe(true);
    await Bun.sleep(0);
    expect(sent).toEqual([payload.text]);
    expect(new ActionStore(layout).list().map(request => request.state)).toEqual(["done"]);
  } finally { await run.close(); }
});
