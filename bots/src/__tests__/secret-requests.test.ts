import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASK_REPLIES, type AsksGateway, type AsksPush, AskStore, DECLINE_COOLDOWN_MS, EXPIRY_MS, MAX_GRANT_MS, type NewSecret, requestsFile,
  SECRET_ERRORS, SECRET_REPLIES, secretHash, type SecretsGateway, syncAsks, utcDay, writeAsksEnabled,
} from "../asks";
import { type GatewayConfig, PINNED_FETCH_URL, PINNED_UPSTREAM, PINNED_WEB_API } from "../config";
import { Gateway } from "../gateway";
import { botLayout } from "../layout";

const T0 = Date.parse("2026-11-22T12:12:00Z");
const HOUR = 3_600_000;
const BOT_ID = "c".repeat(64);
const A = "a".repeat(24);
const B = "b".repeat(24);
const WHY = "To make UNIQUE-WHY-text summaries of your notes.";
const LINK = "https://openkey.so/approve/abc";

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "secret-requests-"));
  clock = T0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const layout = () => botLayout(BOT_ID, { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") });
const store = () => new AskStore(layout(), () => clock);
const secret = (id: string, over: Partial<NewSecret> = {}): NewSecret =>
  ({ kind: "secret", id, name: "OPENAI_API_KEY", why: WHY, sites: ["api.openai.com"], askedAt: clock, outside: false, ...over });

/** Stands in for the gateway's control socket, lane A's secret routes included. */
function fakeGateway(asks: unknown[] = []) {
  const pushes: AsksPush[] = [];
  const outcomes: unknown[] = [];
  const links: Array<{ id: string; request: unknown }> = [];
  const forgotten: string[] = [];
  let linkFails = false;
  const secrets: SecretsGateway = {
    drain: async () => ({ outcomes: outcomes.splice(0) }),
    link: async (id, request) => {
      if (linkFails) throw new Error("503");
      links.push({ id, request });
      return { approveUrl: `${LINK}/${id}` };
    },
    forget: async id => void forgotten.push(id),
  };
  const adapter: AsksGateway = {
    drain: async () => ({ asks: asks.splice(0), outside: false }),
    push: async body => void pushes.push(body),
    secrets,
  };
  return { adapter, pushes, outcomes, links, forgotten, failLinks: () => void (linkFails = true) };
}

const sync = (adapter: AsksGateway) => syncAsks(layout(), adapter, undefined, () => clock);

describe("a secret request in the supervisor's store", () => {
  test("is pending with its name, sites, service and sentence, gets an OpenKey link, and never holds a value", async () => {
    writeAsksEnabled(layout(), true);
    const gw = fakeGateway([secret(A)]);
    await sync(gw.adapter);
    expect(gw.links).toEqual([{ id: A, request: { name: "OPENAI_API_KEY", sites: ["api.openai.com"], header: "authorization", why: WHY } }]);
    expect(store().list()).toEqual([{
      id: A, kind: "secret", state: "pending", askedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + EXPIRY_MS).toISOString(), outside: false,
      name: "OPENAI_API_KEY", sites: ["api.openai.com"], service: "OpenAI", writes: ["POST"], why: WHY, approveUrl: `${LINK}/${A}`,
    }]);
    expect(gw.pushes.at(-1)!.secrets).toEqual([{ id: A, name: "OPENAI_API_KEY", state: "pending", sites: ["api.openai.com"] }]);
  });

  test("keeps a known secret to its catalog site whatever the gateway handed over, and refuses a damaged one", async () => {
    writeAsksEnabled(layout(), true);
    const gw = fakeGateway([
      { ...secret(A), sites: ["evil.example.com"] },
      { ...secret(B), name: "lower_case" },
    ]);
    await sync(gw.adapter);
    // The whole batch is refused when one entry is malformed: nothing is stored.
    expect(store().list()).toEqual([]);
    const ok = fakeGateway([{ ...secret(A), sites: ["evil.example.com"] }]);
    await sync(ok.adapter);
    expect(store().list()[0]).toMatchObject({ id: A, sites: ["api.openai.com"] });
  });

  test("approval: Main is told once, in its fixed sentence; the card shows the end; Stop now revokes and forgets the key", async () => {
    writeAsksEnabled(layout(), true);
    const gw = fakeGateway([secret(A)]);
    await sync(gw.adapter);
    const until = T0 + HOUR;
    gw.outcomes.push({ id: A, outcome: "approved", until });
    await sync(gw.adapter);
    expect(store().list()[0]).toMatchObject({ state: "approved", until: new Date(until).toISOString(), undelivered: true });
    expect(store().list()[0]).not.toHaveProperty("why");
    expect(store().list()[0]).not.toHaveProperty("approveUrl");
    expect(store().reply(A)).toEqual({
      text: "The owner approved OPENAI_API_KEY for api.openai.com until 2026-11-22 13:12 UTC. Use it with call_with_secret. You can’t see its value.",
      decision: "approved",
      secret: { name: "OPENAI_API_KEY", sites: ["api.openai.com"], service: "OpenAI", until: new Date(until).toISOString() },
    });
    store().delivered(A);
    expect(store().reply(A)).toBeUndefined();
    expect(gw.pushes.at(-1)!.secrets).toEqual([{ id: A, name: "OPENAI_API_KEY", state: "approved", sites: ["api.openai.com"], until }]);

    expect(store().answer(A, { decision: "decline" })).toEqual({ ok: false, error: "not_pending" });
    const stopped = store().answer(A, { decision: "stop" });
    expect(stopped.ok && stopped.request.state).toBe("revoked");
    expect(store().reply(A)?.text).toBe(SECRET_REPLIES.revoked("OPENAI_API_KEY"));
    expect(store().reply(A)?.text).toBe("The owner stopped your access to OPENAI_API_KEY. Carry on without it, and don’t ask again unless they bring it up.");
    await sync(gw.adapter);
    expect(gw.forgotten).toEqual([A]);
    await sync(gw.adapter);
    expect(gw.forgotten).toEqual([A]);
  });

  test("an approval longer than 7 days is not kept: the request fails and its key is forgotten", async () => {
    writeAsksEnabled(layout(), true);
    const gw = fakeGateway([secret(A)]);
    await sync(gw.adapter);
    gw.outcomes.push({ id: A, outcome: "approved", until: T0 + MAX_GRANT_MS + 60_000 });
    await sync(gw.adapter);
    expect(store().list()[0]).toMatchObject({ state: "failed", why: WHY });
    expect(store().reply(A)).toBeUndefined();
    expect(gw.forgotten).toEqual([A]);
  });

  test("an approval ends at its time without a message, and a sentence-free record stays", async () => {
    writeAsksEnabled(layout(), true);
    const gw = fakeGateway([secret(A)]);
    await sync(gw.adapter);
    gw.outcomes.push({ id: A, outcome: "approved", until: T0 + HOUR });
    await sync(gw.adapter);
    store().delivered(A);
    clock = T0 + HOUR;
    expect(store().list()[0]).toMatchObject({ state: "ended", until: new Date(T0 + HOUR).toISOString() });
    expect(store().reply(A)).toBeUndefined();
    await sync(gw.adapter);
    expect(gw.forgotten).toEqual([A]);
    expect(readFileSync(requestsFile(layout()), "utf8")).not.toContain("UNIQUE-WHY");
  });

  test("decline (on the card or in OpenKey) tells Main once, starts the cooldown, and drops the sentence", async () => {
    writeAsksEnabled(layout(), true);
    const gw = fakeGateway([secret(A), secret(B, { name: "STRIPE_KEY", sites: ["api.stripe.com"] })]);
    await sync(gw.adapter);
    expect(store().answer(A, { decision: "decline" }).ok).toBe(true);
    gw.outcomes.push({ id: B, outcome: "declined" });
    await sync(gw.adapter);
    expect(store().reply(A)?.text).toBe("The owner declined your request for OPENAI_API_KEY. Carry on without it, and don’t ask again unless they bring it up.");
    expect(store().reply(B)).toMatchObject({ decision: "declined", secret: { name: "STRIPE_KEY", sites: ["api.stripe.com"] } });
    expect(store().reply(B)!.secret).not.toHaveProperty("service");
    expect(gw.pushes.at(-1)!.declined.map(entry => entry.until)).toEqual([T0 + DECLINE_COOLDOWN_MS, T0 + DECLINE_COOLDOWN_MS]);
    expect(readFileSync(requestsFile(layout()), "utf8")).not.toContain("UNIQUE-WHY");
  });

  test("a link the gateway cannot make fails the request; Try again makes it pending for another 24 hours with a new link", async () => {
    writeAsksEnabled(layout(), true);
    const gw = fakeGateway([secret(A)]);
    gw.failLinks();
    await sync(gw.adapter);
    expect(store().list()[0]).toMatchObject({ state: "failed", why: WHY });
    clock = T0 + 2 * HOUR;
    const retried = store().answer(A, { decision: "retry" });
    expect(retried.ok && retried.request).toMatchObject({ state: "pending", expiresAt: new Date(clock + EXPIRY_MS).toISOString() });
    const healthy = fakeGateway();
    await sync(healthy.adapter);
    // The old key is forgotten before a new link is made.
    expect(healthy.forgotten).toEqual([A]);
    expect(healthy.links.map(link => link.id)).toEqual([A]);
    expect(store().list()[0]).toMatchObject({ state: "pending", approveUrl: `${LINK}/${A}` });
  });

  test("only an https://openkey.so/ link is kept", () => {
    store().ingest([secret(A)]);
    expect(store().approvalLink(A, "https://openkey.so.evil.example/approve")).toBe(false);
    expect(store().approvalLink(A, "http://openkey.so/approve")).toBe(false);
    expect(store().approvalLink(A, LINK)).toBe(true);
  });

  test("without the owner's account no link is asked for, and the request waits", async () => {
    writeAsksEnabled(layout(), true);
    const gw = fakeGateway([secret(A)]);
    const { link: _, ...noLink } = gw.adapter.secrets!;
    await sync({ ...gw.adapter, secrets: noLink });
    expect(store().list()[0]).toMatchObject({ state: "pending" });
    expect(store().list()[0]).not.toHaveProperty("approveUrl");
  });

  test("a gateway without the secret routes still gets the setting and the counts", async () => {
    writeAsksEnabled(layout(), true);
    const gw = fakeGateway([secret(A)]);
    await sync({ ...gw.adapter, secrets: { drain: async () => { throw new Error("404"); }, forget: async () => {} } });
    expect(gw.pushes.at(-1)).toMatchObject({ enabled: true, pending: 1 });
  });

  test("turning requests off closes pending secret requests with the questions, in one message, and leaves approvals running", async () => {
    writeAsksEnabled(layout(), true);
    const gw = fakeGateway([secret(A), secret(B, { name: "STRIPE_KEY", sites: ["api.stripe.com"] })]);
    await sync(gw.adapter);
    gw.outcomes.push({ id: B, outcome: "approved", until: T0 + HOUR });
    await sync(gw.adapter);
    store().delivered(B);
    expect(store().cancelPending()).toBe(1);
    expect(store().list().map(request => [request.id, request.state])).toEqual([[B, "approved"], [A, "stopped"]]);
    expect(store().reply(A)).toEqual({ text: ASK_REPLIES.stopped, decision: "stopped" });
    expect(ASK_REPLIES.stopped).toBe("The person turned off questions and requests from you, so your open questions and secret requests were closed without an answer. Carry on without asking.");
  });

  test("a pending request expires after 24 hours without a message, and OpenKey's expiry does the same", async () => {
    writeAsksEnabled(layout(), true);
    const gw = fakeGateway([secret(A), secret(B, { name: "STRIPE_KEY", sites: ["api.stripe.com"] })]);
    await sync(gw.adapter);
    gw.outcomes.push({ id: B, outcome: "expired" });
    await sync(gw.adapter);
    expect(store().list().find(request => request.id === B)).toMatchObject({ state: "expired" });
    clock = T0 + EXPIRY_MS;
    expect(store().list().find(request => request.id === A)).toMatchObject({ state: "expired" });
    expect(store().reply(A)).toBeUndefined();
    expect(store().reply(B)).toBeUndefined();
  });
});

const cfg = (): GatewayConfig => ({
  egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: ["m"], maxTokens: 100, botDailyTokens: 1000,
  globalDailyTokens: 1500, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000, totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000, budgetFile: "/unused",
  web: { key: "web-key", apiUrl: PINNED_WEB_API, botDailySearches: 3, botDailyPages: 2, globalDailySearches: 100, globalDailyPages: 100, timeoutMs: 1000, fetchUrl: PINNED_FETCH_URL, fetchTimeoutMs: 1000 },
});
const BOT = "a".repeat(64);
const TOKEN = "1".repeat(64);

describe("request_secret on the app MCP server", () => {
  let spy: { mockRestore(): void };
  let lines: string[];
  beforeEach(() => {
    lines = [];
    spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  });
  afterEach(() => spy.mockRestore());

  const setup = () => {
    const gateway = new Gateway(cfg(), { fetch: async () => Response.json({}), now: () => clock, store: { load: () => undefined, save: () => {} } });
    gateway.setToken(BOT, TOKEN);
    return gateway;
  };
  const on = (gateway: Gateway, extra: Partial<AsksPush> = {}) =>
    gateway.setAsks(BOT, { enabled: true, pending: 0, day: utcDay(clock), today: 0, declined: [], ...extra });
  let rpcId = 0;
  const call = async (gateway: Gateway, args: Record<string, unknown>, name = "request_secret") => {
    const response = await gateway.handle(BOT, new Request("http://localhost/v1/mcp/app", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    }));
    const body = (await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return { text: body.result.content[0]!.text, isError: body.result.isError === true };
  };
  const refused = (text: string) => ({ text, isError: true });

  test("is refused while the owner's setting is off, in its own sentence", async () => {
    expect(await call(setup(), { name: "OPENAI_API_KEY", why: WHY })).toEqual(refused("The owner hasn’t allowed requests from you. Don’t ask for the secret in chat."));
  });

  test("checks the name, the sentence and the sites, in that order, each with a fixed sentence", async () => {
    const gateway = setup();
    on(gateway);
    expect(await call(gateway, { name: "openai_key", why: WHY })).toEqual(refused(SECRET_ERRORS.name()));
    expect(await call(gateway, { name: "OPENAI_API_KEY", why: WHY, extra: 1 })).toEqual(refused(SECRET_ERRORS.name()));
    expect(await call(gateway, { name: "OPENAI_API_KEY", why: "x".repeat(201) })).toEqual(refused("Say what the secret is for in one plain sentence of up to 200 characters."));
    for (const sites of [undefined, [], ["127.0.0.1"], ["api.example.com:8443"], ["printer.local"], ["a.com", "b.com", "c.com", "d.com"]]) {
      expect(await call(gateway, { name: "STRIPE_KEY", why: WHY, sites })).toEqual(refused("Name 1 to 3 public sites, like api.example.com. Addresses, ports and private networks aren’t allowed."));
    }
    expect(gateway.drainAsks(BOT)).toEqual([]);
  });

  test("takes a known secret's site from the catalog and an unknown secret's from Main, and returns at once", async () => {
    const gateway = setup();
    on(gateway);
    const known = await call(gateway, { name: "OPENAI_API_KEY", why: WHY, sites: ["evil.example.com"] });
    expect(known.isError).toBe(false);
    expect(JSON.parse(known.text)).toMatchObject({ state: "pending", name: "OPENAI_API_KEY", sites: ["api.openai.com"] });
    const unknown = JSON.parse((await call(gateway, { name: "STRIPE_KEY", why: WHY, sites: ["API.Stripe.com", "files.stripe.com"] })).text);
    expect(unknown).toMatchObject({ state: "pending", sites: ["api.stripe.com", "files.stripe.com"] });
    expect(gateway.drainAsks(BOT).map(request => request.kind === "secret" && request.sites)).toEqual([["api.openai.com"], ["api.stripe.com", "files.stripe.com"]]);
    expect(lines.join("\n")).not.toContain("UNIQUE-WHY");
  });

  test("is listed only while the owner's setting is on", async () => {
    const gateway = setup();
    const listed = async () => {
      const response = await gateway.handle(BOT, new Request("http://localhost/v1/mcp/app", {
        method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }),
      }));
      return ((await response.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(tool => tool.name);
    };
    expect(await listed()).not.toContain("request_secret");
    on(gateway);
    expect(await listed()).toContain("request_secret");
    gateway.setAsks(BOT, { enabled: false, pending: 0, day: utcDay(clock), today: 0, declined: [] });
    expect(await listed()).not.toContain("request_secret");
  });

  test("refuses a secret already approved, already asked for or declined recently, then the shared caps", async () => {
    const gateway = setup();
    const until = clock + HOUR;
    on(gateway, {
      secrets: [
        { id: A, name: "OPENAI_API_KEY", state: "approved", sites: ["api.openai.com"], until },
        { id: B, name: "STRIPE_KEY", state: "pending", sites: ["api.stripe.com"] },
      ],
      declined: [{ hash: secretHash("RESEND_API_KEY"), until: clock + DECLINE_COOLDOWN_MS }],
    });
    expect(await call(gateway, { name: "OPENAI_API_KEY", why: WHY })).toEqual(refused("You can already use OPENAI_API_KEY with api.openai.com until 2026-11-22 13:12 UTC. Use call_with_secret."));
    expect(await call(gateway, { name: "STRIPE_KEY", why: WHY, sites: ["api.stripe.com"] })).toEqual(refused("You already asked for STRIPE_KEY. Wait for the owner; don’t ask in chat."));
    expect(await call(gateway, { name: "RESEND_API_KEY", why: WHY })).toEqual(refused("The owner declined RESEND_API_KEY recently. Don’t ask again unless they bring it up."));
    expect((await call(gateway, { name: "GITHUB_TOKEN", why: WHY })).isError).toBe(false);
    expect(await call(gateway, { name: "GITHUB_TOKEN", why: WHY })).toEqual(refused("You already asked for GITHUB_TOKEN. Wait for the owner; don’t ask in chat."));

    // Questions and secret requests share the 3 open requests.
    gateway.drainAsks(BOT);
    on(gateway, { pending: 2 });
    expect((await call(gateway, { question: "Which city?" }, "ask_owner")).isError).toBe(false);
    expect(await call(gateway, { name: "ANTHROPIC_API_KEY", why: WHY })).toEqual(refused("Too many open requests for now. Carry on without asking."));
    on(gateway, { pending: 0, today: 10 });
    expect(await call(gateway, { name: "ANTHROPIC_API_KEY", why: WHY })).toEqual(refused(SECRET_ERRORS.many()));
  });
});
