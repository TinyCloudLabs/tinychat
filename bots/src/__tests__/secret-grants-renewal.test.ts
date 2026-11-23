// TC-4000: a renewing (leased) secret approval. The owner picks renewal on OpenKey's screen; the gateway offers it only
// for a secret's own exact key and only when the node and renewer are pinned, checks the node at every use, and never
// uses a stale end.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckedApprovalResult, Ed25519PrivateJwk, OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import * as realLinks from "@tinycloud/share-envelope/links";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { AskStore, MAX_GRANT_MS, requestsFile, MAX_LEASED_GRANT_MS, type NewSecret } from "../asks";
import { gatewayConfig } from "../config";
import type { GuardDeps } from "../fetch-guard";
import { botLayout } from "../layout";
import { type ApprovalLinks, type GrantSession, LEASE_SECONDS, type LeaseCheck, type ReadValue, renewable, SecretGrants, secretPermissions } from "../secret-grants";
import { type GrantNode, type LeaseNode, nodeSecretReader } from "../secret-node";
import type { GrantStore } from "../secret-store";

const OWNER_KEY = privateKeyToAccount(`0x${"11".repeat(32)}`);
const OWNER = `did:pkh:eip155:1:${OWNER_KEY.address.toLowerCase()}`;
const CHECKSUMMED = OWNER_KEY.address;
const T0 = Date.UTC(2026, 11, 8, 12, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BOT = "b".repeat(64);
const ID = "9c41e0d2a7b3f6c18e5d2a90";
const NAME = "OPENAI_API_KEY";
const PIN = { nodeDid: "did:key:z6MkNODE", renewerDid: "did:key:z6MkRENEWER" };
const CID = "bafy-delegation";
const OTHER = "a".repeat(24);

const kv = `tinycloud:pkh:eip155:1:${CHECKSUMMED}:secrets/kv/vault/secrets/${NAME}`;
const key = `urn:tinycloud:encryption:did:pkh:eip155:1:${CHECKSUMMED}:default/secrets/openai_api_key`;
const recap = (att: Record<string, unknown>) => `urn:recap:${Buffer.from(JSON.stringify({ att, prf: [] })).toString("base64url")}`;
const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as Ed25519PrivateJwk;

type Receipt = { originalCid: string; leaseCid: string; leaseAuthorization: string; leaseExpiresAt: string; leaseGeneration: number; nodeIdentity: { nodeDid: string; renewerDid: string; renewerPublicKey: string; renewerEpoch: number } };
const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  originalCid: CID, leaseCid: "bafy-lease", leaseAuthorization: "lease-auth", leaseExpiresAt: new Date(T0 + 30 * DAY).toISOString(), leaseGeneration: 1,
  nodeIdentity: { ...PIN, renewerPublicKey: "k", renewerEpoch: 0 }, ...over,
});

/** An approval for `audience`: a one-hour window, finite or leased with `receipt`. */
async function result(audience: string, leased?: Receipt, lifetimeMs = HOUR, approved = LEASE_SECONDS): Promise<CheckedApprovalResult> {
  const siwe = createSiweMessage({
    domain: "openkey.so", address: CHECKSUMMED, uri: `${audience}#${audience.slice("did:key:".length)}`, version: "1", chainId: 1,
    nonce: "abcdefgh12345678", issuedAt: new Date(T0), expirationTime: new Date(T0 + lifetimeMs),
    resources: [recap({ [kv]: { "tinycloud.kv/get": [{}] }, [key]: { "tinycloud.encryption/decrypt": [{}] } })],
  });
  return {
    ownerDid: OWNER, delegationExpiresAt: new Date(T0 + lifetimeMs).toISOString(),
    delegation: {
      siwe, signature: await OWNER_KEY.signMessage({ message: siwe }), delegationCid: CID, spaceId: `tinycloud:pkh:eip155:1:${CHECKSUMMED}:secrets`,
      address: CHECKSUMMED, chainId: 1, verificationMethod: `${audience}#${audience.slice("did:key:".length)}`, delegationHeader: { Authorization: "Bearer fake" },
    },
    ...(leased ? { renewalChoice: "leased" as const, renewal: { version: 1 as const, approvedLeaseLifetimeSeconds: approved, approvedAt: new Date(T0).toISOString(), receipt: leased } } : { renewalChoice: "finite" as const }),
  } as CheckedApprovalResult;
}

function storeOf() {
  const saved = new Map<string, unknown>();
  const store: GrantStore = {
    load: () => [...saved].map(([id, r]) => ({ id, botId: BOT, record: structuredClone(r) })),
    save: (id, _botId, r) => void saved.set(id, structuredClone(r)),
    remove: id => void saved.delete(id),
  };
  return { store, saved };
}

function harness(opts: { renewal?: boolean; read?: () => ReadValue; leaseEnd?: () => LeaseCheck } = {}) {
  const { store, saved } = storeOf();
  const requests: OpenKeyApprovalRequestV1[] = [];
  const leaseChecks: GrantSession[] = [];
  const state = { now: T0, signed: undefined as CheckedApprovalResult | undefined, read: opts.read ?? (() => ({ value: "sk-test-FAKE" } as ReadValue)), leaseEnd: opts.leaseEnd ?? (() => ({ end: T0 + 3 * DAY })) };
  const links = {
    generateRelayKey: realLinks.generateRelayKey, signerFromJwk: realLinks.signerFromJwk, isApprovalClientError: realLinks.isApprovalClientError,
    createApprovalRequest: async (input: { request: OpenKeyApprovalRequestV1; expiresAt: Date }) => {
      requests.push(input.request);
      return { link: "https://openkey.so/a/req1#k", id: "req1", bodyCid: "bafy-body", expiresAt: input.expiresAt.toISOString(), record: { header: "h", signature: "s" } };
    },
    discoverApprovalResult: async () => (state.signed ? { status: "ready", resultRef: "ref", expiresAt: new Date(T0 + HOUR).toISOString() } : { status: "pending" }),
    fetchApprovalResult: async () => ({}), openRelayResult: async () => ({}), checkApprovalResultBinding: () => state.signed!, ackApprovalResult: async () => "acknowledged",
  };
  const grants = new SecretGrants({
    store, links: links as unknown as ApprovalLinks, now: () => state.now, ...(opts.renewal === false ? {} : { renewal: PIN }),
    reader: { read: async () => state.read(), forget: () => undefined, leaseEnd: async (_id, session) => (leaseChecks.push(session), state.leaseEnd()) },
    origins: { node: "https://node.example", linksApi: "https://links.example", openkey: "https://openkey.so", openkeyApi: "https://api.openkey.example" },
  });
  const ask = (name = NAME) => grants.ask(BOT, ID, { name, sites: ["api.openai.com"], header: "authorization", why: "To transcribe a call.", ownerDid: OWNER });
  return { grants, requests, leaseChecks, saved, state, ask };
}

const net: GuardDeps = { lookup: async () => ["93.184.216.34"], connect: async () => { throw new Error("no call expected"); } };
const CALL = { name: NAME, method: "GET", url: "https://api.openai.com/v1/models", headers: { Authorization: "Bearer {{secret}}" } };

/** The request answered by a leased approval, polled once. */
async function approvedLeased(h: ReturnType<typeof harness>) {
  await h.ask();
  h.state.signed = await result(h.requests[0]!.targetDid, receipt());
  await h.grants.poll();
}

describe("the request offers renewal only when it may", () => {
  test("with the pin, a normal secret's request carries a 30-day renewal request and keeps the 1-hour suggestion", async () => {
    const h = harness();
    await h.ask();
    expect(h.requests[0]!.renewal).toEqual({ version: 1, leaseLifetimeSeconds: 30 * 86_400 });
    expect(h.requests[0]!.suggestedLifetimeSeconds).toBe(3600);
  });

  test("without the pin (dark), no request carries renewal", async () => {
    const h = harness({ renewal: false });
    await h.ask();
    expect(h.requests[0]).not.toHaveProperty("renewal");
  });

  test("never for SCOPED, whose keys sit under secrets/scoped/", async () => {
    const h = harness();
    await h.ask("SCOPED");
    expect(h.requests[0]).not.toHaveProperty("renewal");
    expect(renewable("SCOPED", secretPermissions("MY_TOKEN", OWNER))).toBe(false);
    expect(renewable("MY_TOKEN", secretPermissions("MY_TOKEN", OWNER))).toBe(true);
    // Judged on what is asked for: a decrypt under another key, or under scoped/, is not renewable.
    const [read, decrypt] = secretPermissions("MY_TOKEN", OWNER);
    expect(renewable("MY_TOKEN", [read!, { ...decrypt!, path: decrypt!.path.replace("/secrets/my_token", "/secrets/scoped/my_token") }])).toBe(false);
    expect(renewable("MY_TOKEN", [read!, { ...decrypt!, path: decrypt!.path.replace("/secrets/my_token", "/secrets/other") }])).toBe(false);
    expect(renewable("MY_TOKEN", [read!])).toBe(false);
  });

  test("the pin comes from BOTS_RENEWAL_NODE_DID and BOTS_RENEWAL_RENEWER_DID, both or none", () => {
    const base = { REDPILL_API_KEY: "test-only" } as Record<string, string>;
    expect(gatewayConfig({ ...base }).renewal).toBeUndefined();
    expect(gatewayConfig({ ...base, BOTS_RENEWAL_NODE_DID: PIN.nodeDid, BOTS_RENEWAL_RENEWER_DID: PIN.renewerDid }).renewal).toEqual(PIN);
    expect(gatewayConfig({ ...base, BOTS_RENEWAL_NODE_DID: PIN.nodeDid }).renewal).toBeUndefined();
    expect(gatewayConfig({ ...base, BOTS_RENEWAL_NODE_DID: "not a did", BOTS_RENEWAL_RENEWER_DID: PIN.renewerDid }).renewal).toBeUndefined();
  });
});

describe("a result that carries a lease", () => {
  test("is kept: access runs to the lease's end, and the supervisor is told it is leased", async () => {
    const h = harness();
    await approvedLeased(h);
    expect(h.grants.drain(BOT)).toEqual([{ id: ID, outcome: "approved", until: T0 + 30 * DAY, leased: true }]);
  });

  test("a finite answer to the same request is kept as an ordinary approval, ending with its window", async () => {
    const h = harness();
    await h.ask();
    h.state.signed = await result(h.requests[0]!.targetDid);
    await h.grants.poll();
    expect(h.grants.drain(BOT)).toEqual([{ id: ID, outcome: "approved", until: T0 + HOUR }]);
  });

  test.each([
    ["for another grant", receipt({ originalCid: "bafy-other" })],
    ["for another node", receipt({ nodeIdentity: { ...PIN, nodeDid: "did:key:z6MkOTHER", renewerPublicKey: "k", renewerEpoch: 0 } })],
    ["for another renewer", receipt({ nodeIdentity: { ...PIN, renewerDid: "did:key:z6MkOTHER", renewerPublicKey: "k", renewerEpoch: 0 } })],
    ["longer than 30 days", receipt({ leaseExpiresAt: new Date(T0 + 31 * DAY).toISOString() })],
    ["already over", receipt({ leaseExpiresAt: new Date(T0 - HOUR).toISOString() })],
  ])("is refused when the lease is %s", async (_, bad) => {
    const h = harness();
    await h.ask();
    h.state.signed = await result(h.requests[0]!.targetDid, bad);
    await h.grants.poll();
    expect(h.grants.drain(BOT)).toEqual([{ id: ID, outcome: "failed" }]);
  });

  test("is refused when the lease was approved for longer than 30 days", async () => {
    const h = harness();
    await h.ask();
    h.state.signed = await result(h.requests[0]!.targetDid, receipt(), 7 * DAY, LEASE_SECONDS + 1);
    await h.grants.poll();
    expect(h.grants.drain(BOT)).toEqual([{ id: ID, outcome: "failed" }]);
  });

  test("is refused when no renewal was asked for", async () => {
    const h = harness({ renewal: false });
    await h.ask();
    h.state.signed = await result(h.requests[0]!.targetDid, receipt());
    await h.grants.poll();
    expect(h.grants.drain(BOT)).toEqual([{ id: ID, outcome: "failed" }]);
  });
});

describe("a leased approval is checked with the node, never by its stored end", () => {
  test("a use that finds the lease over is refused, ends it, and the supervisor is told once", async () => {
    const h = harness({ read: () => "ended" });
    await approvedLeased(h);
    h.grants.drain(BOT);
    h.state.now += 5 * DAY;
    const refused = await h.grants.call(BOT, CALL, net);
    expect(refused.outcome).toBe("ended");
    // The refusal's date is the day of the check, not the lease's last day (T0 + 30 days).
    expect(JSON.stringify(refused.result)).toContain("2026-12-13");
    expect(JSON.stringify(refused.result)).not.toContain("2027-01-07");
    expect(h.saved.get(ID)).toMatchObject({ state: "ended", keys: undefined });
    expect(h.grants.drain(BOT)).toEqual([{ id: ID, outcome: "ended" }]);
    expect((h.saved.get(ID) as { until: number }).until).toBeLessThanOrEqual(h.state.now);
    expect(h.grants.drain(BOT)).toEqual([]);
    // A fresh ask, not a use, is what the next call needs.
    expect((await h.grants.call(BOT, CALL, net)).outcome).toBe("ended");
  });

  test("a node that cannot be reached refuses the use and keeps the approval", async () => {
    const h = harness({ read: () => "unavailable" });
    await approvedLeased(h);
    expect((await h.grants.call(BOT, CALL, net)).outcome).toBe("unavailable");
    expect(h.saved.get(ID)).toMatchObject({ state: "approved" });
  });

  test("the poll asks the node once a minute, ends a lease it finds over and leaves one it cannot reach", async () => {
    const h = harness({ leaseEnd: () => "unavailable" });
    await approvedLeased(h);
    await h.grants.poll();
    expect(h.leaseChecks).toHaveLength(1); // the first pass after approval; not again within the minute
    await h.grants.poll();
    expect(h.leaseChecks).toHaveLength(1);
    h.state.now += 61_000;
    await h.grants.poll();
    expect(h.leaseChecks).toHaveLength(2);
    expect(h.saved.get(ID)).toMatchObject({ state: "approved" });
    h.state.leaseEnd = () => "ended";
    h.state.now += 61_000;
    await h.grants.poll();
    expect(h.saved.get(ID)).toMatchObject({ state: "ended" });
    h.grants.drain(BOT);
    expect(h.grants.drain(BOT)).toEqual([]);
  });

  test("a leased session kept on disk is used with the lease, an ordinary one is not", async () => {
    const h = harness();
    await approvedLeased(h);
    expect((h.saved.get(ID) as { keys: { session: GrantSession } }).keys.session.lease).toEqual({ authorization: "lease-auth", expiresAt: new Date(T0 + 30 * DAY).toISOString() });
  });
});

function leaseNode(over: Partial<LeaseNode> = {}, log: string[] = []): LeaseNode {
  return {
    renewalNodeIdentity: (async () => (log.push("renewalNodeIdentity"), { ...PIN, renewerPublicKey: "k", renewerEpoch: 0 })) as LeaseNode["renewalNodeIdentity"],
    restoreSessionWithRenewal: (async () => void log.push("restoreSessionWithRenewal")) as LeaseNode["restoreSessionWithRenewal"],
    restoreSession: (async () => void log.push("restoreSession")) as LeaseNode["restoreSession"],
    readSecret: (async () => (log.push("readSecret"), { status: "ok", value: "sk-test-FAKE" })) as unknown as LeaseNode["readSecret"],
    get sessionEnd() { return new Date(T0 + 3 * DAY); },
    ...over,
  } as LeaseNode;
}
const session = (lease = true) => ({ address: CHECKSUMMED, chainId: 1, delegationCid: CID, ...(lease ? { lease: { authorization: "lease-auth", expiresAt: new Date(T0 + 30 * DAY).toISOString() } } : {}) }) as GrantSession;
const CLOCK = T0;
const readerFor = (node: LeaseNode) => nodeSecretReader("https://node.example", () => ({}) as GrantNode, { pin: PIN, newNode: () => node, now: () => CLOCK });

describe("the node reader for a leased grant", () => {
  test("restores only after the node reports a live renewal, reads, and touches nothing else on the client", async () => {
    const log: string[] = [];
    expect(await readerFor(leaseNode({}, log)).read(ID, session(), NAME)).toEqual({ value: "sk-test-FAKE" });
    expect(log).toEqual(["renewalNodeIdentity", "restoreSessionWithRenewal", "readSecret"]);
  });

  test("leaseEnd gives the node-verified end", async () => {
    const end = await readerFor(leaseNode()).leaseEnd!(ID, session());
    expect(end).toMatchObject({ end: expect.any(Number) });
  });

  test.each([
    ["a lease that is over", "RENEWAL_LEASE_EXPIRED"],
    ["authority that is no longer active (revoked)", "RENEWAL_AUTHORITY_INACTIVE"],
    ["a renewer that has changed", "RENEWAL_RENEWER_CHANGED"],
  ])("%s is ended, and nothing is read", async (_, code) => {
    const log: string[] = [];
    const node = leaseNode({ restoreSessionWithRenewal: (async () => { throw Object.assign(new Error("x"), { code }); }) as LeaseNode["restoreSessionWithRenewal"] }, log);
    expect(await readerFor(node).read(ID, session(), NAME)).toBe("ended");
    expect(await readerFor(node).leaseEnd!(ID, session())).toBe("ended");
    expect(log).not.toContain("readSecret");
  });

  test("a node that cannot be reached is unavailable, never ended and never read", async () => {
    const log: string[] = [];
    const node = leaseNode({ restoreSessionWithRenewal: (async () => { throw new Error("ECONNREFUSED"); }) as LeaseNode["restoreSessionWithRenewal"] }, log);
    expect(await readerFor(node).read(ID, session(), NAME)).toBe("unavailable");
    expect(log).not.toContain("readSecret");
  });

  test.each([
    ["node", { nodeDid: "did:key:z6MkOTHER" }],
    ["renewer", { renewerDid: "did:key:z6MkOTHER" }],
  ])("a %s that is not the pinned one is unavailable, and the session is not restored", async (_, other) => {
    const log: string[] = [];
    const node = leaseNode({ renewalNodeIdentity: (async () => ({ ...PIN, ...other, renewerPublicKey: "k", renewerEpoch: 0 })) as LeaseNode["renewalNodeIdentity"] }, log);
    expect(await readerFor(node).read(ID, session(), NAME)).toBe("unavailable");
    expect(log).toEqual([]);
  });

  test("a node reporting a window past 7 days is refused: the approval ends, nothing is read", async () => {
    const log: string[] = [];
    const far = leaseNode({ get sessionEnd() { return new Date(CLOCK + 8 * DAY); } } as Partial<LeaseNode>, log);
    expect(await readerFor(far).read(ID, session(), NAME)).toBe("ended");
    expect(await readerFor(far).leaseEnd!(ID, session())).toBe("ended");
    expect(log).not.toContain("readSecret");
    const edge = leaseNode({ get sessionEnd() { return new Date(CLOCK + 7 * DAY + 60_000); } } as Partial<LeaseNode>);
    expect(await readerFor(edge).leaseEnd!(ID, session())).toEqual({ end: CLOCK + 7 * DAY + 60_000 });
  });

  test("the end given is never past the lease's own end", async () => {
    const node = leaseNode({ get sessionEnd() { return new Date(CLOCK + 3 * DAY); } } as Partial<LeaseNode>);
    const short = { ...session(), lease: { authorization: "a", expiresAt: new Date(CLOCK + 2 * DAY).toISOString() } } as GrantSession;
    expect(await readerFor(node).leaseEnd!(ID, short)).toEqual({ end: CLOCK + 2 * DAY });
  });

  test("a lease whose end has already passed on the node is ended", async () => {
    const node = leaseNode({ get sessionEnd() { return new Date(T0 - 1000); } } as Partial<LeaseNode>);
    expect(await readerFor(node).read(ID, session(), NAME)).toBe("ended");
  });

  test("without a pin a leased session is unavailable, and an ordinary one still reads", async () => {
    const reader = nodeSecretReader("https://node.example", () => ({ restoreSession: async () => undefined, readSecret: (async () => ({ status: "ok", value: "v" })) as unknown as GrantNode["readSecret"] }));
    expect(await reader.read(ID, session(), NAME)).toBe("unavailable");
    expect(await reader.read(ID, session(false), NAME)).toEqual({ value: "v" });
  });
});

describe("the supervisor keeps a leased approval past 7 days, and only that", () => {
  let root: string;
  let clock: number;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "secret-renewal-")); clock = Date.parse("2026-11-22T12:00:00Z"); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const asks = () => {
    const store = new AskStore(botLayout(BOT, { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") }), () => clock);
    const added = (id: string): NewSecret => ({ kind: "secret", id, name: NAME, why: "To transcribe a call.", sites: ["api.openai.com"], askedAt: clock, outside: false });
    store.ingest([added(ID), added(OTHER)]);
    return store;
  };

  test("a finite approval over an hour is refused", () => {
    expect(asks().approved(ID, clock + MAX_GRANT_MS + 1)).toBe(false);
  });

  test("a leased one is kept up to 30 days, and not beyond", () => {
    const store = asks();
    expect(store.approved(ID, clock + MAX_LEASED_GRANT_MS, true)).toBe(true);
    expect(store.approved(OTHER, clock + MAX_LEASED_GRANT_MS + 61_000, true)).toBe(false);
  });

  test("a leased approval the gateway found over ends like one that ran out, and no longer shows the lease's end", () => {
    const store = asks();
    expect(store.approved(ID, clock + 20 * DAY, true)).toBe(true);
    clock += 2 * DAY;
    expect(store.endedInGateway(ID)).toBe(true);
    const kept = JSON.parse(readFileSync(requestsFile(botLayout(BOT, { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") })), "utf8")) as { id: string; state: string; until: number }[] | { asks: { id: string; state: string; until: number }[] };
    const ask = (Array.isArray(kept) ? kept : kept.asks).find(held => held.id === ID);
    expect(ask).toMatchObject({ state: "ended" });
    expect(ask!.until).toBe(clock);
    expect(store.endedInGateway(ID)).toBe(false);
  });
});
