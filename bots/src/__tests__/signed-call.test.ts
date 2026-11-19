import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListedMessage, TurnSink } from "../bot";
import { legacyOwnerHeaderAccepted } from "../config";
import { OwnerManifests } from "../manifest";
import { type BotApi, createApp } from "../server";
import { type Call, CALL_LIFETIME_MS, type CallClaims, CLOCK_SKEW_MS, signClaims, signedCallHeader, SIGNED_SCHEME, bodyHash } from "../signed-call";

const SECRET = "s".repeat(64);
const REGULAR_SECRET = "r".repeat(64);
const A = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const B = "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb";
const KEY = "ab".repeat(16);
const ORIGIN = "http://bots.internal";
const tmp = mkdtempSync(join(tmpdir(), "signed-call-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** `from-env`: no acceptLegacyOwnerHeader option, so createApp reads BOTS_ACCEPT_LEGACY_OWNER_HEADER. */
function service(acceptLegacyOwnerHeader: boolean | "from-env" = false) {
  const reached: string[] = [];
  const bot = (key: string, owner: string): BotApi => ({
    send: async (_text: string, sink: TurnSink) => { reached.push(`${owner} ${key} send`); sink.done("b-1"); },
    list: async (): Promise<ListedMessage[]> => { reached.push(`${owner} ${key} list`); return []; },
  });
  const manifest = new OwnerManifests(join(mkdtempSync(join(tmp, "service-")), "owners"));
  manifest.announce(A, KEY, "active", 1);
  const app = createApp({
    secret: SECRET,
    accounts: new Set([A.slice(-42), B.slice(-42)]),
    environment: "private",
    acceptLegacyOwnerHeader: acceptLegacyOwnerHeader === "from-env" ? undefined : acceptLegacyOwnerHeader,
    manifest,
    bots: { forOwner: owner => bot("main", owner), forBot: (owner, key) => bot(key, owner) },
  });
  return { app, reached };
}

/** A request signed as the backend signs it; `over` replaces signed fields, `headers` adds unsigned ones. */
function signed(method: string, path: string, options: { call?: Partial<Call>; now?: number; body?: string; secret?: string; headers?: Record<string, string> } = {}) {
  const bot = /^\/v1\/bots\/([^/]+)/.exec(path)![1]!;
  const call: Call = { direction: "to-service", environment: "private", owner: A, bot, method, path, body: options.body, ...options.call };
  const authorization = signedCallHeader(options.secret ?? SECRET, call, options.now);
  return { authorization, request: (to = path) => new Request(ORIGIN + to, { method, headers: { authorization, ...options.headers }, body: options.body }) };
}

describe("signed calls from the backend", () => {
  test("a signed call reaches the signed owner's bot, for a list and for a turn", async () => {
    const { app, reached } = service();
    const list = await app(signed("GET", "/v1/bots/main/messages").request());
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ messages: [] });
    const turn = await app(signed("POST", "/v1/bots/main/messages", { body: '{"text":"hi"}' }).request());
    expect(await turn.text()).toContain("event: done");
    const sibling = await app(signed("GET", `/v1/bots/${KEY}/messages`).request());
    expect(sibling.status).toBe(200);
    expect(reached).toEqual([`${A} main list`, `${A} main send`, `${A} ${KEY} list`]);
  });

  test("an unsigned call is refused, with or without the bearer secret", async () => {
    const { app, reached } = service();
    const unsigned: Record<string, string>[] = [{}, { authorization: `Bearer ${SECRET}` }, { authorization: `Bearer ${SECRET}`, "x-tinycloud-owner": A }];
    for (const headers of unsigned) {
      const res = await app(new Request(`${ORIGIN}/v1/bots/main/messages`, { headers }));
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    }
    expect(reached).toEqual([]);
  });

  test("a forged owner header neither authenticates nor changes the signed owner", async () => {
    const { app, reached } = service();
    expect((await app(signed("GET", "/v1/bots/main/messages", { headers: { "x-tinycloud-owner": B } }).request())).status).toBe(200);
    expect(reached).toEqual([`${A} main list`]);
  });

  test("an expired call is refused; the clock skew allowed is bounded both ways", async () => {
    const { app, reached } = service();
    const now = Date.now();
    // Signed so long ago that it expired more than the skew ago.
    const expired = signed("GET", "/v1/bots/main/messages", { now: now - CALL_LIFETIME_MS - CLOCK_SKEW_MS - 1000 });
    expect((await app(expired.request())).status).toBe(401);
    // Expiring further ahead than a lifetime plus the skew: a signer clock that far off, or a call minted to last.
    const ahead = signed("GET", "/v1/bots/main/messages", { now: now + CLOCK_SKEW_MS + 1000 });
    expect((await app(ahead.request())).status).toBe(401);
    expect(reached).toEqual([]);
    // Within the skew on either side it passes.
    expect((await app(signed("GET", "/v1/bots/main/messages", { now: now - CALL_LIFETIME_MS - CLOCK_SKEW_MS + 1000 }).request())).status).toBe(200);
    expect((await app(signed("GET", "/v1/bots/main/messages", { now: now + CLOCK_SKEW_MS - 1000 }).request())).status).toBe(200);
  });

  test("a call signed for the other environment, or with the other environment's secret, is refused", async () => {
    const { app, reached } = service();
    expect((await app(signed("GET", "/v1/bots/main/messages", { call: { environment: "regular" } }).request())).status).toBe(401);
    expect((await app(signed("GET", "/v1/bots/main/messages", { secret: REGULAR_SECRET }).request())).status).toBe(401);
    expect((await app(signed("GET", "/v1/bots/main/messages", { call: { environment: "regular" }, secret: REGULAR_SECRET }).request())).status).toBe(401);
    expect(reached).toEqual([]);
  });

  test("a call signed in the other direction is refused", async () => {
    const { app, reached } = service();
    expect((await app(signed("GET", "/v1/bots/main/messages", { call: { direction: "to-backend" } }).request())).status).toBe(401);
    expect(reached).toEqual([]);
  });

  test("a call replayed to another bot, path, method or body is refused", async () => {
    const { app, reached } = service();
    // Main's signature on the sibling's path, and the other way round.
    expect((await app(signed("GET", "/v1/bots/main/messages").request(`/v1/bots/${KEY}/messages`))).status).toBe(401);
    expect((await app(signed("GET", `/v1/bots/${KEY}/messages`).request("/v1/bots/main/messages"))).status).toBe(401);
    // The bot signed differs from the bot in the path, the path itself matching.
    expect((await app(signed("GET", "/v1/bots/main/messages", { call: { bot: KEY } }).request())).status).toBe(401);
    // Another operation on the same bot.
    expect((await app(signed("GET", "/v1/bots/main/messages").request("/v1/bots/main/history"))).status).toBe(401);
    const list = signed("GET", "/v1/bots/main/messages");
    expect((await app(new Request(`${ORIGIN}/v1/bots/main/messages`, { method: "POST", headers: { authorization: list.authorization }, body: '{"text":"hi"}' }))).status).toBe(401);
    const turn = signed("POST", "/v1/bots/main/messages", { body: '{"text":"hi"}' });
    expect((await app(new Request(`${ORIGIN}/v1/bots/main/messages`, { method: "POST", headers: { authorization: turn.authorization }, body: '{"text":"bye"}' }))).status).toBe(401);
    expect(reached).toEqual([]);
  });

  test("the same signed call is accepted once", async () => {
    const { app, reached } = service();
    const call = signed("GET", "/v1/bots/main/messages");
    expect((await app(call.request())).status).toBe(200);
    expect((await app(call.request())).status).toBe(401);
    expect(reached).toEqual([`${A} main list`]);
  });

  test("a changed signature or claim, and an owner off the allowlist, are refused", async () => {
    const { app, reached } = service();
    const { authorization } = signed("GET", "/v1/bots/main/messages");
    const [payload, mac] = authorization.slice(SIGNED_SCHEME.length).split(".") as [string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as CallClaims;
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, owner: B })).toString("base64url");
    const offList = "did:pkh:eip155:1:0x00000000000000000000000000000000000000cc";
    for (const header of [
      `${SIGNED_SCHEME}${forgedPayload}.${mac}`,
      `${SIGNED_SCHEME}${payload}.${mac.slice(0, -2)}`,
      `${SIGNED_SCHEME}${payload}.`,
      `${SIGNED_SCHEME}${payload}`,
      `${SIGNED_SCHEME}${signClaims("x".repeat(64), claims)}`,
      `${SIGNED_SCHEME}${signClaims(SECRET, { ...claims, owner: offList })}`,
      `${SIGNED_SCHEME}${signClaims(SECRET, { ...claims, owner: A.toUpperCase() })}`,
    ]) {
      expect((await app(new Request(`${ORIGIN}/v1/bots/main/messages`, { headers: { authorization: header } }))).status).toBe(401);
    }
    expect(reached).toEqual([]);
  });

  test("a signed body arrives intact for the route that reads it", async () => {
    const { app } = service();
    const body = JSON.stringify({ text: "x".repeat(8001) });
    expect(bodyHash(body)).toHaveLength(64);
    // Over the length limit: the route read the body (an error event, not a 401), so it was passed on after its hash was checked.
    const res = await app(signed("POST", "/v1/bots/main/messages", { body }).request());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"code":"invalid"');
  });
});

describe("the legacy owner header during the rollout", () => {
  test("off: the bearer secret and owner header are refused", async () => {
    const { app } = service(false);
    expect((await app(new Request(`${ORIGIN}/v1/bots/main/messages`, { headers: { authorization: `Bearer ${SECRET}`, "x-tinycloud-owner": A } }))).status).toBe(401);
  });

  test("flag unset: an owner header alone, or with the bearer secret, is refused", async () => {
    const saved = process.env.BOTS_ACCEPT_LEGACY_OWNER_HEADER;
    delete process.env.BOTS_ACCEPT_LEGACY_OWNER_HEADER;
    try {
      const { app, reached } = service("from-env");
      const url = `${ORIGIN}/v1/bots/main/messages`;
      expect((await app(new Request(url, { headers: { "x-tinycloud-owner": A } }))).status).toBe(401);
      expect((await app(new Request(url, { headers: { authorization: `Bearer ${SECRET}`, "x-tinycloud-owner": A } }))).status).toBe(401);
      expect(reached).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.BOTS_ACCEPT_LEGACY_OWNER_HEADER;
      else process.env.BOTS_ACCEPT_LEGACY_OWNER_HEADER = saved;
    }
  });

  test("on: both the legacy call and a signed call are accepted", async () => {
    const { app, reached } = service(true);
    expect((await app(new Request(`${ORIGIN}/v1/bots/main/messages`, { headers: { authorization: `Bearer ${SECRET}`, "x-tinycloud-owner": B } }))).status).toBe(200);
    expect((await app(signed("GET", "/v1/bots/main/messages").request())).status).toBe(200);
    expect(reached).toEqual([`${B} main list`, `${A} main list`]);
  });

  test("BOTS_ACCEPT_LEGACY_OWNER_HEADER is off unless exactly 1", () => {
    expect(legacyOwnerHeaderAccepted({})).toBe(false);
    expect(legacyOwnerHeaderAccepted({ BOTS_ACCEPT_LEGACY_OWNER_HEADER: "" })).toBe(false);
    expect(legacyOwnerHeaderAccepted({ BOTS_ACCEPT_LEGACY_OWNER_HEADER: "0" })).toBe(false);
    expect(legacyOwnerHeaderAccepted({ BOTS_ACCEPT_LEGACY_OWNER_HEADER: "1" })).toBe(true);
    expect(() => legacyOwnerHeaderAccepted({ BOTS_ACCEPT_LEGACY_OWNER_HEADER: "true" })).toThrow("BOTS_ACCEPT_LEGACY_OWNER_HEADER");
  });
});
