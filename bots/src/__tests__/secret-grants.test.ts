import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckedApprovalResult, Ed25519PrivateJwk, OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import * as realLinks from "@tinycloud/share-envelope/links";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type { SecretPush } from "../asks";
import type { Conn, GuardDeps } from "../fetch-guard";
import { isRecord } from "../guards";
import { botIdFor, MAIN_BOT_NAME } from "../owner";
import { DAILY_CALLS_PER_SECRET } from "../secret-call";
import { KNOWN_SECRETS, type KnownSecret } from "../secret-catalog";
import {
  type ApprovalLinks, type GrantSession, LINK_MS, MAX_GRANT_SECONDS, type ReadValue, SecretGrants, type SecretReader, SUGGESTED_GRANT_SECONDS, verifiedGrant,
} from "../secret-grants";
import { secretRoute } from "../secret-routes";
import { type GrantStore, sealedGrantStore } from "../secret-store";

// Fake keys and values only.
const OWNER_KEY = privateKeyToAccount(`0x${"11".repeat(32)}`);
const OTHER_KEY = privateKeyToAccount(`0x${"22".repeat(32)}`);
const OWNER = `did:pkh:eip155:1:${OWNER_KEY.address.toLowerCase()}`;
const MAIN = botIdFor(OWNER);
const BOT = "b".repeat(64);
const VALUE = "sk-test-FAKE-0123456789";
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 22, 12, 0);
const ID = "9c41e0d2a7b3f6c18e5d2a90";
const ID2 = "0d2a7b3f6c18e5d2a909c41e";

const ASK = { name: "OPENAI_API_KEY", sites: ["api.openai.com"], header: "authorization", why: "To transcribe a call.", ownerDid: OWNER };

interface GrantOptions {
  signer?: typeof OWNER_KEY;
  address?: string;
  audience?: string;
  lifetimeMs?: number;
  ownerDid?: string;
  spaceOwner?: string;
  resourceOwner?: string;
  issuedAt?: number;
  /** The secret the grant reads; OPENAI_API_KEY unless named. */
  secret?: string;
}

function recap(att: Record<string, unknown>): string {
  return `urn:recap:${Buffer.from(JSON.stringify({ att, prf: [] })).toString("base64url")}`;
}

/** What OpenKey hands back for `request`, signed by the owner's wallet the way OpenKey's delegate page does. */
async function grantFor(request: OpenKeyApprovalRequestV1, options: GrantOptions = {}): Promise<CheckedApprovalResult> {
  const address = options.address ?? OWNER_KEY.address;
  const issued = options.issuedAt ?? T0;
  const expires = issued + (options.lifetimeMs ?? HOUR);
  const audience = options.audience ?? request.targetDid;
  const spaceOwner = options.spaceOwner ?? address;
  const resourceOwner = options.resourceOwner ?? address;
  const siwe = createSiweMessage({
    domain: "openkey.so", address: address as `0x${string}`, uri: `${audience}#${audience.slice("did:key:".length)}`, version: "1", chainId: 1,
    nonce: "abcdefgh12345678", issuedAt: new Date(issued), expirationTime: new Date(expires),
    resources: [recap({
      [`tinycloud:pkh:eip155:1:${resourceOwner}:secrets/kv/vault/secrets/${options.secret ?? "OPENAI_API_KEY"}`]: { "tinycloud.kv/get": [{}] },
      [`urn:tinycloud:encryption:did:pkh:eip155:1:${resourceOwner}:default`]: { "tinycloud.encryption/decrypt": [{}] },
    })],
  });
  const signature = await (options.signer ?? OWNER_KEY).signMessage({ message: siwe });
  return {
    ownerDid: options.ownerDid ?? OWNER,
    delegationExpiresAt: new Date(expires).toISOString(),
    delegation: {
      siwe, signature, delegationCid: "bafy-delegation", spaceId: `tinycloud:pkh:eip155:1:${spaceOwner}:secrets`, address, chainId: 1,
      verificationMethod: `${audience}#${audience.slice("did:key:".length)}`, delegationHeader: { Authorization: "Bearer fake-ucan" },
    },
  };
}

type Answer = "pending" | "ready" | { error: realLinks.ApprovalClientErrorCode };

/** Links API and OpenKey, played from a script. */
function openkey() {
  const requests: OpenKeyApprovalRequestV1[] = [];
  const answers = new Map<string, Answer>();
  const acks: string[] = [];
  let made = 0;
  let signed: CheckedApprovalResult | undefined;
  const links = {
    generateRelayKey: realLinks.generateRelayKey,
    signerFromJwk: realLinks.signerFromJwk,
    isApprovalClientError: realLinks.isApprovalClientError,
    createApprovalRequest: async (input: { request: OpenKeyApprovalRequestV1; expiresAt: Date }) => {
      requests.push(input.request);
      made++;
      return { link: `https://openkey.so/a/req${made}#k`, id: `req${made}`, bodyCid: `bafy-body-${made}`, expiresAt: input.expiresAt.toISOString(), record: { header: "h", signature: "s" } };
    },
    discoverApprovalResult: async (state: { requestId: string }) => {
      const answer = answers.get(state.requestId) ?? "pending";
      if (answer === "pending") return { status: "pending" };
      if (answer !== "ready") throw new realLinks.ApprovalClientError(answer.error, "scripted");
      return { status: "ready", resultRef: `ref-${state.requestId}`, expiresAt: new Date(T0 + HOUR).toISOString() };
    },
    fetchApprovalResult: async () => ({}),
    openRelayResult: async () => ({}),
    checkApprovalResultBinding: () => {
      if (!signed) throw new realLinks.ApprovalClientError("result_invalid", "scripted");
      return signed;
    },
    ackApprovalResult: async (_state: unknown, ref: string) => {
      acks.push(ref);
      return "acknowledged";
    },
  };
  return { links, requests, answers, acks, sign: (grant: CheckedApprovalResult) => void (signed = grant) };
}

function memoryStore() {
  const files = new Map<string, { botId: string; record: unknown }>();
  const store: GrantStore = {
    load: () => [...files].map(([id, file]) => ({ id, botId: file.botId, record: structuredClone(file.record) })),
    save: (id, botId, record) => void files.set(id, { botId, record: structuredClone(record) }),
    remove: id => void files.delete(id),
  };
  return { store, files };
}

function reader(answer: () => ReadValue = () => ({ value: VALUE })) {
  const forgotten: string[] = [];
  const sessions: GrantSession[] = [];
  const secretReader: SecretReader = {
    read: async (_id, session) => {
      sessions.push(session);
      return answer();
    },
    forget: id => void forgotten.push(id),
  };
  return { secretReader, forgotten, sessions };
}

/** A site that answers every call with `body`, at a public address; records what was sent. */
function site(body = '{"ok":true}', hold?: Promise<void>) {
  const sent: string[] = [];
  const net: GuardDeps = {
    lookup: async () => ["93.184.216.34"],
    connect: async (): Promise<Conn> => ({
      write: data => void sent.push(data),
      destroy: () => undefined,
      read: () => ({
        async *[Symbol.asyncIterator]() {
          if (hold) await hold;
          yield new TextEncoder().encode(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
        },
      }),
    }),
  };
  return { net, sent };
}

let clock = T0;
let logs: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  clock = T0;
  logs = [];
  spy = spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
});
afterEach(() => spy.mockRestore());

function setup(store = memoryStore(), read = reader()) {
  const ok = openkey();
  const grants = new SecretGrants({
    store: store.store, reader: read.secretReader, links: ok.links as unknown as ApprovalLinks, now: () => clock,
    origins: { node: "https://node.example", linksApi: "https://links.example", openkey: "https://openkey.so", openkeyApi: "https://api.openkey.example" },
  });
  return { grants, ok, store, read };
}

const CALL = { name: "OPENAI_API_KEY", method: "GET", url: "https://api.openai.com/v1/models", headers: { Authorization: "Bearer {{secret}}" } };
const textOf = (outcome: { result: { content: Array<{ text: string }> } }) => outcome.result.content[0]!.text;

async function approved(env = setup(), grant: GrantOptions = {}, ask = ASK) {
  await env.grants.ask(BOT, ID, ask);
  env.ok.answers.set("req1", "ready");
  // The grant is signed for the request the gateway made, so the fake OpenKey signs it once it has the request.
  env.ok.sign(await grantFor(env.ok.requests[0]!, { secret: ask.name, ...grant }));
  await env.grants.poll();
  return env;
}

/** A request's sealed record as the store holds it. */
function saved(store: ReturnType<typeof memoryStore>, id: string): Record<string, unknown> {
  const record = store.files.get(id)?.record;
  if (!isRecord(record)) throw new Error("no record");
  return record;
}

describe("asking", () => {
  test("signs one request with a fresh key that is both issuer and audience, for one secret and decrypt, one hour at most and suggested", async () => {
    const { grants, ok } = setup();
    const result = await grants.ask(BOT, ID, ASK);
    expect(result).toEqual({ approveUrl: "https://openkey.so/a/req1#k", expiresAt: new Date(T0 + LINK_MS).toISOString() });
    const request = ok.requests[0]!;
    expect(request.issuer).toBe(request.targetDid);
    expect(request.targetDid).toMatch(/^did:key:z6Mk/);
    expect(request.grantLifetimeSeconds).toBe(MAX_GRANT_SECONDS);
    expect(MAX_GRANT_SECONDS).toBe(3600);
    expect(request.suggestedLifetimeSeconds).toBe(SUGGESTED_GRANT_SECONDS);
    expect(SUGGESTED_GRANT_SECONDS).toBe(3600);
    expect(request.permissions).toEqual([
      { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/OPENAI_API_KEY", actions: ["tinycloud.kv/get"] },
      { service: "tinycloud.encryption", space: "encryption", path: `urn:tinycloud:encryption:did:pkh:eip155:1:${OWNER_KEY.address}:default`, actions: ["tinycloud.encryption/decrypt"] },
    ]);
    expect(request.reason).toBe(`Use OPENAI_API_KEY with OpenAI (api.openai.com). To transcribe a call. ${MAIN_BOT_NAME} can also send data to OpenAI with it, which may cost money or change things there.`);
  });

  test("names no writes to the owner for a read-only secret", async () => {
    const { grants, ok } = setup();
    await grants.ask(BOT, ID, { ...ASK, name: "GITHUB_TOKEN", sites: ["api.github.com"] });
    expect(ok.requests[0]!.reason).toBe("Use GITHUB_TOKEN with GitHub PAT (api.github.com). To transcribe a call.");
  });

  test("gives the same link for the same open request, and a fresh key for each request", async () => {
    const { grants, ok } = setup();
    const first = await grants.ask(BOT, ID, ASK);
    expect(await grants.ask(BOT, ID, ASK)).toEqual(first);
    await grants.ask(BOT, ID2, ASK);
    expect(ok.requests.length).toBe(2);
    expect(ok.requests[0]!.targetDid).not.toBe(ok.requests[1]!.targetDid);
  });

  test("refuses an id taken by another bot or another secret", async () => {
    const { grants } = setup();
    await grants.ask(BOT, ID, ASK);
    expect(await grants.ask("c".repeat(64), ID, ASK)).toEqual({ refused: "conflict" });
    expect(await grants.ask(BOT, ID, { ...ASK, name: "GITHUB_TOKEN", sites: ["api.github.com"] })).toEqual({ refused: "conflict" });
  });
});

describe("collecting the owner's answer", () => {
  test("keeps an approved grant, tells the supervisor once, and acknowledges it after it is saved", async () => {
    const { grants, ok, store } = await approved();
    expect(grants.drain(BOT)).toEqual([{ id: ID, outcome: "approved", until: T0 + HOUR }]);
    expect(grants.drain(BOT)).toEqual([]);
    expect(ok.acks).toEqual(["ref-req1"]);
    expect(store.files.has(ID)).toBe(true);
  });

  test.each([
    ["a denial before the link's end is a decline", { error: "request_expired" as const }, T0 + HOUR, "declined"],
    ["a denial at the link's end is an expiry", { error: "request_expired" as const }, T0 + LINK_MS, "expired"],
    ["an unknown request is an expiry", { error: "not_found" as const }, T0 + HOUR, "expired"],
    ["a result that doesn't answer this request fails", { error: "result_invalid" as const }, T0 + HOUR, "failed"],
  ])("%s, and the request's key goes", async (_, answer, at, outcome) => {
    const { grants, ok, store, read } = setup();
    await grants.ask(BOT, ID, ASK);
    ok.answers.set("req1", answer);
    clock = at;
    await grants.poll();
    expect(grants.drain(BOT)).toEqual([{ id: ID, outcome } as never]);
    expect(saved(store, ID).keys).toBeUndefined();
    expect(read.forgotten).toEqual([ID]);
  });

  test("asks again after a network failure", async () => {
    const { grants, ok } = setup();
    await grants.ask(BOT, ID, ASK);
    ok.answers.set("req1", { error: "network" });
    await grants.poll();
    expect(grants.drain(BOT)).toEqual([]);
  });

  test("refuses a grant that fails a check, keeps nothing and drops the key", async () => {
    const env = setup();
    await approved(env, { resourceOwner: OTHER_KEY.address });
    expect(env.grants.drain(BOT)).toEqual([{ id: ID, outcome: "failed" }]);
    expect(env.ok.acks).toEqual([]);
    expect(saved(env.store, ID).keys).toBeUndefined();
    expect(logs.join("\n")).toContain('"outcome":"result_refused"');
  });
});

describe("verifiedGrant", () => {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as Ed25519PrivateJwk;
  const target = realLinks.signerFromJwk(jwk).did;
  const request = { targetDid: target } as OpenKeyApprovalRequestV1;
  const expected = { ownerDid: OWNER, targetDid: target, jwk, maxSeconds: MAX_GRANT_SECONDS, now: T0 };

  test("accepts the owner's grant for this key", async () => {
    const session = await verifiedGrant(await grantFor(request), expected);
    expect(session).toMatchObject({ address: OWNER_KEY.address, chainId: 1, expiresAt: new Date(T0 + HOUR).toISOString(), jwk });
  });

  // OpenKey signs the issue time when the request is prepared and the expiry when the page renders: a live 1 h grant was 6.9 s over.
  test("accepts a one-hour grant whose length runs a few seconds over, up to 120 seconds", async () => {
    await expect(verifiedGrant(await grantFor(request, { lifetimeMs: HOUR + 7_000 }), expected)).resolves.toMatchObject({ address: OWNER_KEY.address });
    await expect(verifiedGrant(await grantFor(request, { lifetimeMs: HOUR + 120_000 }), expected)).resolves.toMatchObject({ address: OWNER_KEY.address });
  });

  test("refuses a grant that is already over", async () => {
    await expect(verifiedGrant(await grantFor(request), { ...expected, now: T0 + 2 * HOUR })).rejects.toThrow("already over");
  });

  // Root issuer, space owner and every resource owner must be the owner (Bobbie's review); the audience this key.
  test.each([
    ["signed by another wallet", { signer: OTHER_KEY }, "not the owner's signature"],
    ["for another account", { address: OTHER_KEY.address, signer: OTHER_KEY }, "names another owner"],
    ["naming another owner", { ownerDid: `did:pkh:eip155:1:${OTHER_KEY.address.toLowerCase()}` }, "names another owner"],
    ["for another key", { audience: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" }, "for another key"],
    ["longer than an hour", { lifetimeMs: (MAX_GRANT_SECONDS + 3600) * 1000 }, "longer than asked"],
    ["121 seconds over an hour", { lifetimeMs: 3_721_000 }, "longer than asked"],
    ["opening another owner's space", { spaceOwner: OTHER_KEY.address }, "another owner's space"],
    ["naming another owner's resource", { resourceOwner: OTHER_KEY.address }, "another owner's resource"],
  ])("refuses a grant %s", async (_, grant, message) => {
    await expect(verifiedGrant(await grantFor(request, grant), expected)).rejects.toThrow(message);
  });
});

describe("calls with an approved secret", () => {
  test("reads the value with the kept grant and makes the call", async () => {
    const env = await approved();
    const { net, sent } = site(`{"echo":"${VALUE}"}`);
    const outcome = await env.grants.call(BOT, CALL, net);
    expect(outcome.outcome).toBe("ok");
    expect(textOf(outcome)).not.toContain(VALUE);
    expect(JSON.parse(JSON.parse(textOf(outcome)).body)).toEqual({ echo: "[hidden]" });
    expect(sent[0]).toContain(`Authorization: Bearer ${VALUE}`);
    expect(env.read.sessions[0]!.delegationCid).toBe("bafy-delegation");
  });

  test("refuses a secret never asked for, one still waiting, and one only the supervisor knows of", async () => {
    const env = setup();
    const { net } = site();
    expect(textOf(await env.grants.call(BOT, CALL, net))).toBe("You can’t use OPENAI_API_KEY. Ask for it with request_secret.");
    await env.grants.ask(BOT, ID, ASK);
    expect(textOf(await env.grants.call(BOT, CALL, net))).toBe("The owner hasn’t approved OPENAI_API_KEY yet.");
    const pushed: SecretPush[] = [{ id: ID2, name: "GITHUB_TOKEN", state: "pending", sites: ["api.github.com"] }];
    expect(textOf(await env.grants.call(BOT, { ...CALL, name: "GITHUB_TOKEN" }, net, pushed))).toBe("The owner hasn’t approved GITHUB_TOKEN yet.");
  });

  test("answers that access ended once the grant runs out, and drops the key", async () => {
    const env = await approved();
    clock = T0 + HOUR;
    await env.grants.poll();
    const outcome = await env.grants.call(BOT, CALL, site().net);
    expect(outcome.outcome).toBe("ended");
    expect(textOf(outcome)).toBe("Your access to OPENAI_API_KEY ended on 2026-11-22 13:00 UTC. If you still need it, ask again with request_secret.");
    expect(env.read.forgotten).toEqual([ID]);
  });

  test("Stop now: the supervisor's word holds at once, then DELETE removes the sealed file and the reader's copy", async () => {
    const env = await approved();
    const { net, sent } = site();
    const stopped: SecretPush[] = [{ id: ID, name: "OPENAI_API_KEY", state: "stopped", sites: ["api.openai.com"], until: T0 + HOUR }];
    expect((await env.grants.call(BOT, CALL, net, stopped)).outcome).toBe("not_asked");
    expect(env.grants.remove(BOT, ID)).toBe(true);
    expect(env.store.files.has(ID)).toBe(false);
    expect(env.read.forgotten).toEqual([ID]);
    expect((await env.grants.call(BOT, CALL, net)).outcome).toBe("not_asked");
    expect(sent).toEqual([]);
  });

  test("another bot can't remove or use a bot's grant", async () => {
    const env = await approved();
    expect(env.grants.remove("c".repeat(64), ID)).toBe(false);
    expect((await env.grants.call("c".repeat(64), CALL, site().net)).outcome).toBe("not_asked");
  });

  test.each([
    ["the secret isn't in Secrets", "missing" as const, "OPENAI_API_KEY isn’t in the owner’s TinyCloud Secrets. The request card shows them how to add it."],
    ["TinyCloud can't be reached", "unavailable" as const, "OPENAI_API_KEY can’t be used right now. Try again later."],
  ])("says so when %s, and makes no call", async (_, answer, text) => {
    const env = await approved(setup(memoryStore(), reader(() => answer)));
    const { net, sent } = site();
    const outcome = await env.grants.call(BOT, CALL, net);
    expect(textOf(outcome)).toBe(text);
    expect(outcome.result.isError).toBe(true);
    expect(sent).toEqual([]);
  });

  test("refuses a wrong site without reading the value", async () => {
    const env = await approved();
    const outcome = await env.grants.call(BOT, { ...CALL, url: "https://example.com/" }, site().net);
    expect(textOf(outcome)).toBe("OPENAI_API_KEY is approved only for api.openai.com.");
    expect(env.read.sessions).toEqual([]);
  });

  test("refuses a write on a read-only secret without reading the value", async () => {
    const env = await approved(setup(), {}, { ...ASK, name: "GITHUB_TOKEN", sites: ["api.github.com"] });
    const { net, sent } = site();
    const write = { ...CALL, name: "GITHUB_TOKEN", method: "DELETE", url: "https://api.github.com/repos/owner/repo" };
    const outcome = await env.grants.call(BOT, write, net);
    expect(textOf(outcome)).toBe("GITHUB_TOKEN is approved only for GET and HEAD calls.");
    expect(outcome.outcome).toBe("refused_method");
    expect(env.read.sessions).toEqual([]);
    expect(sent).toEqual([]);
    expect((await env.grants.call(BOT, { ...write, method: "GET" }, net)).outcome).toBe("ok");
  });

  test("sends a write the secret's entry lists, and refuses one it doesn't", async () => {
    const env = await approved();
    const { net, sent } = site();
    const post = { ...CALL, method: "POST", url: "https://api.openai.com/v1/chat/completions", body: "{}" };
    expect((await env.grants.call(BOT, post, net)).outcome).toBe("ok");
    expect(sent[0]!.startsWith("POST /v1/chat/completions HTTP/1.1\r\n")).toBe(true);
    const outcome = await env.grants.call(BOT, { ...post, method: "DELETE" }, net);
    expect(textOf(outcome)).toBe("OPENAI_API_KEY is approved only for GET, HEAD and POST calls.");
    expect(sent.length).toBe(1);
  });

  /** Runs `body` with one catalog entry's writes changed, as a later deploy would; restores the entry after. */
  async function withWrites(name: string, writes: KnownSecret["writes"], body: () => Promise<void>) {
    const entry = KNOWN_SECRETS[name] as { writes?: KnownSecret["writes"] };
    const before = entry.writes;
    entry.writes = writes;
    try {
      await body();
    } finally {
      entry.writes = before;
    }
  }

  test("a catalog that later lists a write never widens a grant already asked for", async () => {
    const env = await approved(setup(), {}, { ...ASK, name: "GITHUB_TOKEN", sites: ["api.github.com"] });
    const { net, sent } = site();
    const post = { ...CALL, name: "GITHUB_TOKEN", method: "POST", url: "https://api.github.com/repos/owner/repo/issues", body: "{}" };
    await withWrites("GITHUB_TOKEN", ["POST"], async () => {
      const outcome = await env.grants.call(BOT, post, net);
      expect(textOf(outcome)).toBe("GITHUB_TOKEN is approved only for GET and HEAD calls.");
      expect(sent).toEqual([]);
      // The same grant, reloaded from its sealed record, still holds only what the owner was asked.
      expect((await setup(env.store).grants.call(BOT, post, net)).outcome).toBe("refused_method");
    });
  });

  test("a catalog that later drops a write takes it from a grant at once", async () => {
    const env = await approved();
    const { net, sent } = site();
    const post = { ...CALL, method: "POST", url: "https://api.openai.com/v1/chat/completions", body: "{}" };
    await withWrites("OPENAI_API_KEY", undefined, async () => {
      expect(textOf(await env.grants.call(BOT, post, net))).toBe("OPENAI_API_KEY is approved only for GET and HEAD calls.");
      expect(sent).toEqual([]);
    });
    expect((await env.grants.call(BOT, post, net)).outcome).toBe("ok");
  });

  test("a record saved without methods is for reading only, even for a secret the catalog lets write", async () => {
    const store = memoryStore();
    await approved(setup(store));
    delete saved(store, ID).methods;
    const { net, sent } = site();
    const post = { ...CALL, method: "POST", url: "https://api.openai.com/v1/chat/completions", body: "{}" };
    expect(textOf(await setup(store).grants.call(BOT, post, net))).toBe("OPENAI_API_KEY is approved only for GET and HEAD calls.");
    expect(sent).toEqual([]);
  });

  test("stops at the day's call cap, which survives a restart", async () => {
    const store = memoryStore();
    await approved(setup(store));
    saved(store, ID).calls = { day: "2026-11-22", count: DAILY_CALLS_PER_SECRET, bytes: 0 };
    const restarted = setup(store);
    const { net, sent } = site();
    expect(textOf(await restarted.grants.call(BOT, CALL, net))).toBe("Today’s limit for calls with OPENAI_API_KEY is used up.");
    expect(sent).toEqual([]);
  });

  test("makes one call at a time per bot", async () => {
    const env = await approved();
    const gate = Promise.withResolvers<void>();
    const first = env.grants.call(BOT, CALL, site("{}", gate.promise).net);
    expect(textOf(await env.grants.call(BOT, CALL, site().net))).toBe("Another call with a secret is still running. Try again when it ends.");
    gate.resolve();
    expect((await first).outcome).toBe("ok");
  });

  test("logs outcomes only: never the value, the address or the reason Main gave", async () => {
    const env = await approved();
    await env.grants.call(BOT, CALL, site(VALUE).net);
    const all = logs.join("\n");
    expect(all).not.toContain(VALUE);
    expect(all).not.toContain("api.openai.com");
    expect(all).not.toContain("transcribe");
  });
});

describe("the sealed store", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "secret-store-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const KEY = new Uint8Array(32).fill(7);

  test("keeps records only sealed: the file holds no plain field", () => {
    const store = sealedGrantStore(dir, KEY);
    store.save(ID, BOT, { name: "OPENAI_API_KEY", jwk: { d: "fake-private-part" } });
    const raw = readFileSync(join(dir, `${ID}.json`), "utf8");
    expect(raw).not.toContain("OPENAI_API_KEY");
    expect(raw).not.toContain("fake-private-part");
    expect(store.load()).toEqual([{ id: ID, botId: BOT, record: { name: "OPENAI_API_KEY", jwk: { d: "fake-private-part" } } }]);
    store.remove(ID);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a file moved onto another request, or opened with another key, does not open", () => {
    sealedGrantStore(dir, KEY).save(ID, BOT, { a: 1 });
    writeFileSync(join(dir, `${ID2}.json`), readFileSync(join(dir, `${ID}.json`)));
    const loaded = sealedGrantStore(dir, KEY).load().sort((a, b) => a.id.localeCompare(b.id));
    expect(loaded).toEqual([{ id: ID2, botId: BOT }, { id: ID, botId: BOT, record: { a: 1 } }]);
    expect(sealedGrantStore(dir, new Uint8Array(32).fill(8)).load().every(entry => entry.record === undefined)).toBe(true);
  });

  test("a record that no longer opens ends as failed and is told to the supervisor", () => {
    sealedGrantStore(dir, KEY).save(ID, BOT, { a: 1 });
    const grants = new SecretGrants({
      store: sealedGrantStore(dir, new Uint8Array(32).fill(8)), reader: reader().secretReader,
      origins: { node: "https://n", linksApi: "https://l", openkey: "https://o", openkeyApi: "https://a" },
    });
    expect(grants.drain(BOT)).toEqual([{ id: ID, outcome: "failed" }]);
    expect(existsSync(join(dir, `${ID}.json`))).toBe(true);
  });
});

describe("the supervisor's routes", () => {
  const put = (body: unknown) => new Request(`http://gateway/bots/${BOT}/secrets/${ID}`, { method: "PUT", body: JSON.stringify(body) });

  test("answer 503 without the sealing key", async () => {
    expect((await secretRoute(put(ASK), BOT, ID, undefined, () => MAIN)).status).toBe(503);
  });

  test("refuse an owner who isn't the bot's owner", async () => {
    const { grants, ok } = setup();
    const other = `did:pkh:eip155:1:${OTHER_KEY.address.toLowerCase()}`;
    expect((await secretRoute(put({ ...ASK, ownerDid: other }), BOT, ID, grants, () => MAIN)).status).toBe(409);
    expect(ok.requests).toEqual([]);
    expect((await secretRoute(put(ASK), BOT, ID, grants, () => MAIN)).status).toBe(200);
  });

  test.each([
    ["a known service with another header", { ...ASK, header: "x-api-key" }],
    ["a known service with another site", { ...ASK, sites: ["api.openai.com.evil.example"] }],
    ["four sites", { ...ASK, name: "STRIPE_KEY", sites: ["a.example.com", "b.example.com", "c.example.com", "d.example.com"] }],
    ["a private site", { ...ASK, name: "STRIPE_KEY", sites: ["db.internal"] }],
    ["a lower-case name", { ...ASK, name: "openai" }],
  ])("refuse %s", async (_, body) => {
    const { grants, ok } = setup();
    expect((await secretRoute(put(body), BOT, ID, grants, () => MAIN)).status).toBe(400);
    expect(ok.requests).toEqual([]);
  });

  test("DELETE answers 204 and drain gives outcomes once", async () => {
    const env = await approved();
    const drain = await secretRoute(new Request(`http://gateway/bots/${BOT}/secrets/drain`, { method: "POST" }), BOT, "drain", env.grants, () => MAIN);
    expect(await drain.json()).toEqual({ outcomes: [{ id: ID, outcome: "approved", until: T0 + HOUR }] });
    const gone = await secretRoute(new Request(`http://gateway/bots/${BOT}/secrets/${ID}`, { method: "DELETE" }), BOT, ID, env.grants, () => MAIN);
    expect(gone.status).toBe(204);
    expect(env.store.files.size).toBe(0);
  });
});
