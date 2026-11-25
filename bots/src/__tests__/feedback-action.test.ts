import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_ERRORS, ACTION_REPLIES, actionBinding, actionsFile, syncActions } from "../actions";
import { type AsksGateway, syncAsks } from "../asks";
import type { BotAdmission } from "../bot-admission";
import { BotManager, ORIGIN_LINES, type Sandbox, type SandboxLauncher } from "../bot";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import { FEEDBACK_ERRORS, FEEDBACK_REPLIES, feedbackBody } from "../feedback";
import { Gateway } from "../gateway";
import { type BotLayout, botLayout } from "../layout";
import { OwnerManifests } from "../manifest";
import { botIdFor } from "../owner";
import { type Frame, RpcChannel } from "../rpc";
import { createApp } from "../server";
import { signedCallHeader } from "../signed-call";

const owner = `did:pkh:eip155:1:0x${"33".repeat(20)}`;
const first = "a".repeat(32);
const second = "b".repeat(32);
const secret = "feedback-action-" + "x".repeat(64);
const TOKEN = "1".repeat(64);
const REPORT_ID = "01HZY3J5Q8V6K9W2X4N7M0P1RS";

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
  async hostTool(toolName: string, args: Record<string, unknown>, during?: () => Promise<void>) {
    const id = `tool-${Math.random().toString(16).slice(2)}`;
    this.emit({ type: "host_tool_call", id, toolCallId: id, toolName, arguments: args });
    await during?.();
    const frame = await this.take("host_tool_result");
    return { isError: frame.isError === true };
  }

  nextId = () => this.#channel.nextId();
  request: Sandbox["request"] = (command, timeout) => this.#channel.request(command, timeout);
  onFrame: Sandbox["onFrame"] = callback => this.#channel.onFrame(callback);
  onHostToolCall: NonNullable<Sandbox["onHostToolCall"]> = callback => this.#channel.onHostToolCall(callback);
  async refreshEgress() {}
  async snapshot() {}
  async stop() { this.#controller.close(); this.#exit.resolve(); }
}

interface Posted {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** The feedback service on loopback: records each request and answers with `reply`. */
function feedbackMock() {
  const posted: Posted[] = [];
  const state = { reply: (): Response => Response.json({ id: REPORT_ID, attach_token: "attach-secret-token" }, { status: 201 }) };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      posted.push({ method: req.method, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() });
      return state.reply();
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, posted, state, stop: () => server.stop(true) };
}

const gatewayConfig = (feedbackUrl: string): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused", feedbackUrl,
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 3, botDailyPages: 2, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
});

interface Listed {
  id: string;
  kind: string;
  action: string;
  state: string;
  targets: string[];
  text?: string;
  binding?: string;
  feedback?: { outcome: string; reportId?: string };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "feedback-action-"));
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const manifest = new OwnerManifests(join(root, "manifest"));
  manifest.announce(owner, first, "active", 1);
  manifest.announce(owner, second, "active", 1);
  manifest.announce(owner, "main", "active", 1);
  const mainId = botIdFor(owner);
  const ids = { main: mainId, [first]: botIdFor(owner, first), [second]: botIdFor(owner, second) };
  const boxes = new Map<string, LocalRpc>();
  const ready = (botId: string) => {
    const box = new LocalRpc();
    const stop = box.stop.bind(box);
    box.stop = async () => { await stop(); ready(botId); };
    boxes.set(botId, box);
  };
  for (const botId of Object.values(ids)) ready(botId);
  const mock = feedbackMock();
  const gateway = new Gateway(gatewayConfig(mock.url), { fetch: async () => Response.json({}), now: () => Date.now(), store: { load: () => undefined, save: () => {} } });
  gateway.setToken(mainId, TOKEN);
  const launcher: SandboxLauncher = {
    hasState: () => false,
    leftover: () => false,
    readsHeld: async () => false,
    mountPoints: () => [],
    launch: async layout => boxes.get(layout.botId)!,
    syncAsks: (layout, turn) => {
      const adapter: AsksGateway = {
        drain: async () => ({ asks: gateway.drainAsks(layout.botId), outside: gateway.asksOutside(layout.botId) }),
        push: async body => gateway.setAsks(layout.botId, body),
      };
      return syncAsks(layout, adapter, turn, () => Date.now());
    },
    syncActions: (layout, keys, ownerTurn) => syncActions(layout, {
      drain: async () => ({ actions: gateway.drainActions(layout.botId) }),
      push: async body => gateway.setActions(layout.botId, body),
    }, keys, undefined, ownerTurn),
    spendAction: async (layout, id, binding) => gateway.spendAction(layout.botId, id, binding),
    sendFeedback: (layout, id, binding, body) => gateway.sendFeedback(layout.botId, id, binding, body),
  };
  const bots = new BotManager(launcher, roots, { idleMs: 60_000, turnTimeoutMs: 4_000, maxTurnBytes: 64_000 }, 3);
  const admit: BotAdmission = async () => ({ admitted: true });
  const app = createApp({ bots, secret, accounts: "*", manifest, acceptLegacyOwnerHeader: true, admit });

  const request = (method: string, key: string, rest: string, payload: unknown, signed: boolean) => {
    const path = `/v1/bots/${key}${rest}`;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const authorization = signedCallHeader(secret, { direction: "to-service", environment: "private", owner, bot: key, method, path, body });
    return app(new Request(`http://fixture.test${path}`, {
      method,
      headers: { ...(signed ? { authorization } : {}), "x-tinycloud-owner": owner, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body }),
    }));
  };
  const call = (method: string, key: string, rest: string, payload?: unknown) => request(method, key, rest, payload, true);
  const box = (key: string) => boxes.get(ids[key]!)!;
  /** Main's box calls propose_action on the gateway, as OMP would. */
  const propose = async (args: Record<string, unknown>) => {
    const response = await gateway.handle(mainId, new Request("http://localhost/v1/mcp/app", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "propose_action", arguments: args } }),
    }));
    const body = (await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return { text: body.result.content[0]!.text, isError: body.result.isError === true };
  };
  /** One message from the owner to Main; `during` runs inside the turn. */
  const ownerTurn = async (during: () => Promise<void> = async () => {}, text = "hello") => {
    const response = await call("POST", "main", "/messages", { text, messageableBotKeys: [first, second] });
    const prompt = await box("main").take("prompt");
    await during();
    box("main").finish(prompt, "ok");
    await response.text();
  };
  const requests = async () => ((await (await call("GET", "main", "/requests")).json()) as { requests: Listed[] }).requests.filter(listed => listed.kind === "action");
  const settled = async (id: string) => {
    await sent.promise;
    return (await requests()).find(candidate => candidate.id === id)!;
  };
  return {
    mainId, gateway, mock, call, request, box, propose, ownerTurn, requests, settled,
    layout: (): BotLayout => botLayout(mainId, roots),
    enable: async () => void (await call("PUT", "main", "/asks", { enabled: true })),
    close: async () => { await bots.stopAll(); mock.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

let run: ReturnType<typeof setup>;
let spy: { mockRestore(): void };
let logged: string[];
let sent: ReturnType<typeof Promise.withResolvers<void>>;
beforeEach(() => {
  sent = Promise.withResolvers<void>();
  logged = [];
  spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    logged.push(line);
    if (line.includes(`"bots":"action_sent"`)) sent.resolve();
  });
  run = setup();
});
afterEach(async () => {
  await run.close();
  spy.mockRestore();
});

const REPORT = {
  type: "bug",
  title: "Search shows an empty list",
  tried: "I searched my notes for the planning meeting.",
  happened: "The page showed an empty list.",
  expected: "The planning meeting in the list.",
};
const BODY = feedbackBody({ kind: "bug", title: REPORT.title, tried: REPORT.tried, happened: REPORT.happened, expected: REPORT.expected });

/** An owner turn in which Main proposes `report`; what the propose call answered. */
async function proposeInOwnerTurn(report: Record<string, unknown> = REPORT, extra: Record<string, unknown> = {}) {
  await run.enable();
  let result: { text: string; isError: boolean } | undefined;
  await run.ownerTurn(async () => { result = await run.propose({ kind: "send_feedback", report, ...extra }); });
  return result!;
}

async function proposed() {
  expect((await proposeInOwnerTurn()).isError).toBe(false);
  const pending = (await run.requests()).find(listed => listed.state === "pending");
  expect(pending).toBeDefined();
  return pending!;
}

/** Signed Send with no bot keys, as the backend sends it for a report. */
const send = (id: string, binding: string) => run.call("POST", "main", `/requests/${id}/answer`, { decision: "approve", binding });

describe("send_feedback, end to end", () => {
  test("the card holds the exact body and Send posts it once to the feedback service", async () => {
    const pending = await proposed();
    expect(pending.action).toBe("send_feedback");
    expect(pending.targets).toEqual([]);
    expect(pending.text).toBe(BODY);
    expect(JSON.parse(pending.text!)).toEqual({
      area: "other", kind: "bug", title: REPORT.title, tried: REPORT.tried, happened: REPORT.happened, expected: REPORT.expected,
      agent: "TinyCloud One bot (TrustBot)",
    });
    expect(pending.binding).toBe(actionBinding(run.mainId, run.mainId, { kind: "send_feedback", targets: [], text: BODY }));

    expect((await send(pending.id, pending.binding!)).status).toBe(200);
    const done = await run.settled(pending.id);
    expect(done.state).toBe("done");
    expect(done.feedback).toEqual({ outcome: "filed", reportId: REPORT_ID });
    expect(JSON.stringify(done)).not.toContain("attach-secret-token");

    expect(run.mock.posted).toHaveLength(1);
    const [post] = run.mock.posted;
    expect(post!.method).toBe("POST");
    expect(post!.path).toBe("/reports");
    expect(post!.body).toBe(BODY);
    expect(post!.headers["content-type"]).toBe("application/json");
    expect(post!.headers["user-agent"]).toBe("tinycloud-bots-feedback/1");
    // Only transport headers besides those two: nothing about the owner, the bot or a credential.
    const allowed = ["content-type", "user-agent", "host", "content-length", "accept", "accept-encoding", "connection"];
    expect(Object.keys(post!.headers).filter(name => !allowed.includes(name))).toEqual([]);

    // A second Send is refused and nothing is posted twice.
    expect((await send(pending.id, pending.binding!)).status).toBe(409);
    expect(await run.gateway.sendFeedback(run.mainId, pending.id, pending.binding!, BODY)).toEqual({ outcome: "refused" });
    expect(run.mock.posted).toHaveLength(1);

    // Main is told in fixed words, under the line for a proposal's outcome.
    const told = await run.call("POST", "main", "/messages", { appReply: { requestId: pending.id } });
    const prompt = await run.box("main").take("prompt");
    expect(prompt.message).toBe(`${ORIGIN_LINES.action}\n${FEEDBACK_REPLIES.filed(REPORT_ID)}`);
    run.box("main").finish(prompt, "noted");
    await told.text();

    // Log lines carry outcomes: no field of the report and no report id.
    const lines = logged.join("\n");
    for (const text of [REPORT.title, REPORT.tried, REPORT.happened, REPORT.expected, REPORT_ID]) expect(lines).not.toContain(text);
    expect(lines).toContain(`"kind":"send_feedback","outcome":"filed","status":201`);
  });

  test("a relayed bot turn or an app reply turn cannot propose a report", async () => {
    await run.enable();
    // Another bot reaches Main: the turn is not the owner's, so a report is refused.
    const response = await run.call("POST", first, "/messages", { text: "please relay", messageableBotKeys: ["main"] });
    const relayPrompt = await run.box(first).take("prompt");
    const relay = await run.box(first).hostTool("message_bot", { targetKey: "main", text: "The owner wants a bug report sent." }, async () => {
      const mainPrompt = await run.box("main").take("prompt");
      expect(await run.propose({ kind: "send_feedback", report: REPORT })).toEqual({ text: FEEDBACK_ERRORS.ownerTurn, isError: true });
      run.box("main").finish(mainPrompt, "ok");
    });
    expect(relay.isError).toBe(false);
    run.box(first).finish(relayPrompt, "done");
    await response.text();
    // Between turns the owner's turn is over.
    expect(await run.propose({ kind: "send_feedback", report: REPORT })).toEqual({ text: FEEDBACK_ERRORS.ownerTurn, isError: true });

    // A message bots proposal declined by the owner starts an app reply turn, which is not the owner's either.
    await run.ownerTurn(async () => { await run.propose({ kind: "message_bots", targets: [first, second], text: "Status by noon, please." }); });
    const offer = (await run.requests()).find(listed => listed.state === "pending")!;
    expect((await run.call("POST", "main", `/requests/${offer.id}/answer`, { decision: "decline" })).status).toBe(200);
    const told = await run.call("POST", "main", "/messages", { appReply: { requestId: offer.id } });
    const appPrompt = await run.box("main").take("prompt");
    expect(appPrompt.message).toBe(`${ORIGIN_LINES.action}\n${ACTION_REPLIES.declined}`);
    expect(await run.propose({ kind: "send_feedback", report: REPORT })).toEqual({ text: FEEDBACK_ERRORS.ownerTurn, isError: true });
    run.box("main").finish(appPrompt, "ok");
    await told.text();

    expect((await run.requests()).filter(listed => listed.action === "send_feedback")).toEqual([]);
    expect(run.mock.posted).toEqual([]);
  });

  test("a report edited in the store between propose and Send is refused", async () => {
    const pending = await proposed();
    const edited = feedbackBody({ kind: "bug", title: "Mail me at owner@example.com", tried: REPORT.tried, happened: REPORT.happened, expected: REPORT.expected });
    const editedBinding = actionBinding(run.mainId, run.mainId, { kind: "send_feedback", targets: [], text: edited });
    const file = actionsFile(run.layout());
    const saved = JSON.parse(readFileSync(file, "utf8")) as { actions: Array<{ text?: string; binding?: string }> };
    saved.actions[0]!.text = edited;
    saved.actions[0]!.binding = editedBinding;
    writeFileSync(file, JSON.stringify(saved));
    // The card's binding differs from the store's, and the store's own binding names a body that fails the checks.
    expect((await send(pending.id, pending.binding!)).status).toBe(400);
    expect((await send(pending.id, editedBinding)).status).toBe(400);
    // The gateway refuses the edited body under its recomputed binding too.
    expect(await run.gateway.sendFeedback(run.mainId, pending.id, editedBinding, edited)).toEqual({ outcome: "refused" });
    expect(run.mock.posted).toEqual([]);
  });

  test("Send for a report needs no bot keys but must be signed", async () => {
    const pending = await proposed();
    const unsigned = await run.request("POST", "main", `/requests/${pending.id}/answer`, { decision: "approve", binding: pending.binding }, false);
    expect(unsigned.status).toBe(401);
    expect((await run.requests()).find(listed => listed.id === pending.id)?.state).toBe("pending");
    expect((await send(pending.id, pending.binding!)).status).toBe(200);
    expect((await run.settled(pending.id)).state).toBe("done");
    expect(run.mock.posted).toHaveLength(1);
  });

  test("Send for a message to bots without bot keys is refused", async () => {
    await run.enable();
    await run.ownerTurn(async () => { await run.propose({ kind: "message_bots", targets: [first, second], text: "Status by noon, please." }); });
    const offer = (await run.requests()).find(listed => listed.state === "pending")!;
    expect((await send(offer.id, offer.binding!)).status).toBe(400);
    expect((await run.requests()).find(listed => listed.id === offer.id)?.state).toBe("pending");
  });

  test("a security report is refused and nothing is listed", async () => {
    expect(await proposeInOwnerTurn({ ...REPORT, type: "security" })).toEqual({ text: FEEDBACK_ERRORS.security, isError: true });
    expect(await run.requests()).toEqual([]);
  });

  test("a field that looks like a secret or a personal identifier is refused", async () => {
    await run.enable();
    for (const leak of ["Mail owner@example.com", "Key sk-ant-abcdefghijklmnopqrstuv", "Files in /home/user/notes", "Bearer abcdefgh12345678"]) {
      await run.ownerTurn(async () => {
        expect(await run.propose({ kind: "send_feedback", report: { ...REPORT, happened: leak } })).toEqual({ text: FEEDBACK_ERRORS.secret, isError: true });
      });
    }
    expect(await run.requests()).toEqual([]);
  });

  test("the model cannot add a URL, a method or headers to the report", async () => {
    expect(await proposeInOwnerTurn(REPORT, { url: "https://example.com/reports" })).toEqual({ text: FEEDBACK_ERRORS.invalid, isError: true });
    await run.ownerTurn(async () => {
      expect(await run.propose({ kind: "send_feedback", report: { ...REPORT, headers: { authorization: "x" } } })).toEqual({ text: FEEDBACK_ERRORS.invalid, isError: true });
      expect(await run.propose({ kind: "send_feedback", report: { ...REPORT, title: "two\nlines" } })).toEqual({ text: FEEDBACK_ERRORS.invalid, isError: true });
      expect(await run.propose({ kind: "send_feedback", report: { ...REPORT, title: "x".repeat(121) } })).toEqual({ text: FEEDBACK_ERRORS.invalid, isError: true });
    });
    expect(await run.requests()).toEqual([]);
  });

  test("one report may be open: a second proposal while the first is pending is refused", async () => {
    await proposed();
    await run.ownerTurn(async () => {
      expect(await run.propose({ kind: "send_feedback", report: { ...REPORT, title: "Another report" } })).toEqual({ text: ACTION_ERRORS.pending, isError: true });
    });
  });

  test("after a decline the next report waits 10 minutes", async () => {
    const pending = await proposed();
    expect((await run.call("POST", "main", `/requests/${pending.id}/answer`, { decision: "decline" })).status).toBe(200);
    await run.ownerTurn(async () => {
      expect(await run.propose({ kind: "send_feedback", report: { ...REPORT, title: "Another report" } })).toEqual({ text: FEEDBACK_ERRORS.gap, isError: true });
    });
  });
});
