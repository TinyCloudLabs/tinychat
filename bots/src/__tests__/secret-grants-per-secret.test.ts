// TC-3284: the gateway's secret grant opens one secret's own key and nothing else, it never reads with a grant that
// could open the old network-wrapped copy, and it never delegates or attenuates a grant.
import { describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { CheckedApprovalResult, Ed25519PrivateJwk, OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import * as realLinks from "@tinycloud/share-envelope/links";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type { GuardDeps } from "../fetch-guard";
import { KNOWN_SECRETS } from "../secret-catalog";
import { type ApprovalLinks, type GrantSession, MAX_GRANT_SECONDS, type ReadValue, SecretGrants, secretPermissions, verifiedGrant } from "../secret-grants";
import { type GrantNode, nodeSecretReader } from "../secret-node";
import type { GrantStore } from "../secret-store";

// Fake keys and values only.
const OWNER_KEY = privateKeyToAccount(`0x${"11".repeat(32)}`);
const OWNER = `did:pkh:eip155:1:${OWNER_KEY.address.toLowerCase()}`;
const CHECKSUMMED = OWNER_KEY.address;
const LOWER = OWNER_KEY.address.toLowerCase();
const T0 = Date.UTC(2026, 11, 8, 12, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BOT = "b".repeat(64);
const ID = "9c41e0d2a7b3f6c18e5d2a90";
const NAME = "OPENAI_API_KEY";

const kv = (name: string, address: string = CHECKSUMMED) => `tinycloud:pkh:eip155:1:${address}:secrets/kv/vault/secrets/${name}`;
const network = (address: string = CHECKSUMMED) => `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`;
const GET = { "tinycloud.kv/get": [{}] };
const DECRYPT = { "tinycloud.encryption/decrypt": [{}] };
const ASKED = { [kv(NAME)]: GET, [`${network()}/secrets/openai_api_key`]: DECRYPT };

const recap = (att: Record<string, unknown>) => `urn:recap:${Buffer.from(JSON.stringify({ att, prf: [] })).toString("base64url")}`;

const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as Ed25519PrivateJwk;
const target = realLinks.signerFromJwk(jwk).did;

/** A grant the owner's wallet signed for `audience` (this file's key unless named), granting `recaps` (one ReCap each). */
async function grant(recaps: Record<string, unknown>[], lifetimeMs = HOUR, audience = target): Promise<CheckedApprovalResult> {
  const siwe = createSiweMessage({
    domain: "openkey.so", address: CHECKSUMMED, uri: `${audience}#${audience.slice("did:key:".length)}`, version: "1", chainId: 1,
    nonce: "abcdefgh12345678", issuedAt: new Date(T0), expirationTime: new Date(T0 + lifetimeMs), resources: recaps.map(recap),
  });
  return {
    ownerDid: OWNER,
    delegationExpiresAt: new Date(T0 + lifetimeMs).toISOString(),
    delegation: {
      siwe, signature: await OWNER_KEY.signMessage({ message: siwe }), delegationCid: "bafy-delegation", spaceId: `tinycloud:pkh:eip155:1:${CHECKSUMMED}:secrets`,
      address: CHECKSUMMED, chainId: 1, verificationMethod: `${audience}#${audience.slice("did:key:".length)}`, delegationHeader: { Authorization: "Bearer fake" },
    },
  };
}

const expected = { ownerDid: OWNER, name: NAME, targetDid: target, jwk, maxSeconds: MAX_GRANT_SECONDS, now: T0 };

describe("secretPermissions", () => {
  test("asks for the secret's own key for every catalog secret and any other name, never the network or a prefix", () => {
    for (const name of [...Object.keys(KNOWN_SECRETS), "MY_TOKEN", "A"]) {
      const [read, decrypt] = secretPermissions(name, OWNER);
      expect(read).toEqual({ service: "tinycloud.kv", space: "secrets", path: `vault/secrets/${name}`, actions: ["tinycloud.kv/get"] });
      expect(decrypt).toEqual({ service: "tinycloud.encryption", space: "encryption", path: `${network(getAddress(LOWER))}/secrets/${name.toLowerCase()}`, actions: ["tinycloud.encryption/decrypt"] });
    }
  });
});

describe("verifiedGrant takes exactly the two entries asked for", () => {
  test("accepts them, whichever case the owner's address is spelled in", async () => {
    await expect(verifiedGrant(await grant([ASKED]), expected)).resolves.toMatchObject({ delegationCid: "bafy-delegation" });
    const lower = { [kv(NAME, LOWER)]: GET, [`${network(LOWER)}/secrets/openai_api_key`]: DECRYPT };
    await expect(verifiedGrant(await grant([lower]), expected)).resolves.toMatchObject({ delegationCid: "bafy-delegation" });
  });

  test.each([
    ["the whole network instead of the key", { [kv(NAME)]: GET, [network()]: DECRYPT }],
    ["every secret's key (the secrets/ prefix)", { [kv(NAME)]: GET, [`${network()}/secrets/`]: DECRYPT }],
    ["another secret's key", { [kv(NAME)]: GET, [`${network()}/secrets/anthropic_api_key`]: DECRYPT }],
    ["the key spelled in capitals", { [kv(NAME)]: GET, [`${network()}/secrets/OPENAI_API_KEY`]: DECRYPT }],
    ["another secret entirely", { [kv("ANTHROPIC_API_KEY")]: GET, [`${network()}/secrets/anthropic_api_key`]: DECRYPT }],
    ["a third entry", { ...ASKED, [kv("ANTHROPIC_API_KEY")]: GET }],
    ["the network as well as the key", { ...ASKED, [network()]: DECRYPT }],
    ["an extra ability on the key", { [kv(NAME)]: GET, [`${network()}/secrets/openai_api_key`]: { ...DECRYPT, "tinycloud.encryption/key.create": [{}] } }],
    ["writing the secret too", { [kv(NAME)]: { ...GET, "tinycloud.kv/put": [{}] }, [`${network()}/secrets/openai_api_key`]: DECRYPT }],
    ["the read without the decrypt", { [kv(NAME)]: GET }],
    ["the decrypt without the read", { [`${network()}/secrets/openai_api_key`]: DECRYPT }],
    ["the same entry twice in two spellings", { [kv(NAME)]: GET, [kv(NAME, LOWER)]: GET }],
  ])("refuses %s", async (_, att) => {
    await expect(verifiedGrant(await grant([att]), expected)).rejects.toThrow("not exactly what was asked for");
  });

  test("refuses the two entries split across two ReCaps", async () => {
    const [read, decrypt] = Object.entries(ASKED);
    await expect(verifiedGrant(await grant([Object.fromEntries([read!]), Object.fromEntries([decrypt!])]), expected)).rejects.toThrow("not exactly what was asked for");
  });

  test("refuses the right grant when another secret was asked for", async () => {
    await expect(verifiedGrant(await grant([ASKED]), { ...expected, name: "ANTHROPIC_API_KEY" })).rejects.toThrow("not exactly what was asked for");
  });

  test("never keeps a grant over 7 days (plus the 60 s clock skew), even if a longer one was asked for", async () => {
    const asked = { ...expected, maxSeconds: 30 * 24 * 3600 };
    await expect(verifiedGrant(await grant([ASKED], 7 * DAY + 60_000), asked)).resolves.toBeDefined();
    await expect(verifiedGrant(await grant([ASKED], 7 * DAY + 61_000), asked)).rejects.toThrow("longer than asked");
    await expect(verifiedGrant(await grant([ASKED], 7 * DAY + HOUR), asked)).rejects.toThrow("longer than asked");
  });
});

/** A kept record as #913 saved it: asked when the decrypt covered the owner's whole network. */
function networkWideRecord(state: "pending" | "approved") {
  const request = {
    targetDid: target, grantLifetimeSeconds: 7 * 24 * 3600,
    permissions: [
      { service: "tinycloud.kv", space: "secrets", path: `vault/secrets/${NAME}`, actions: ["tinycloud.kv/get"] },
      { service: "tinycloud.encryption", space: "encryption", path: network(), actions: ["tinycloud.encryption/decrypt"] },
    ],
  };
  return {
    botId: BOT, state, reported: state === "approved", approveUrl: "https://openkey.so/a/x", linkExpiresAt: T0 + DAY,
    ...(state === "approved" ? { until: T0 + DAY } : {}),
    ask: { name: NAME, sites: ["api.openai.com"], header: "authorization", why: "To transcribe a call.", ownerDid: OWNER },
    methods: ["GET", "HEAD"], calls: { day: "", count: 0, bytes: 0 },
    keys: { jwk, relayPrivateKey: "r", request, requestId: "req0", bodyCid: "bafy-body", record: { header: "h", signature: "s" }, ackId: "ack", ...(state === "approved" ? { session: { delegationCid: "bafy" } } : {}) },
  };
}

/** A store holding `record` as request ID, or nothing. */
function storeOf(record?: unknown) {
  const saved = new Map<string, unknown>(record === undefined ? [] : [[ID, record]]);
  const store: GrantStore = {
    load: () => [...saved].map(([id, r]) => ({ id, botId: BOT, record: structuredClone(r) })),
    save: (id, _botId, r) => void saved.set(id, structuredClone(r)),
    remove: id => void saved.delete(id),
  };
  return { store, saved };
}

function harness(store: GrantStore, read: () => ReadValue = () => ({ value: "sk-test-FAKE" })) {
  const reads: GrantSession[] = [];
  const requests: OpenKeyApprovalRequestV1[] = [];
  let signed: CheckedApprovalResult | undefined;
  const links = {
    generateRelayKey: realLinks.generateRelayKey, signerFromJwk: realLinks.signerFromJwk, isApprovalClientError: realLinks.isApprovalClientError,
    createApprovalRequest: async (input: { request: OpenKeyApprovalRequestV1; expiresAt: Date }) => {
      requests.push(input.request);
      return { link: `https://openkey.so/a/req${requests.length}#k`, id: `req${requests.length}`, bodyCid: `bafy-body-${requests.length}`, expiresAt: input.expiresAt.toISOString(), record: { header: "h", signature: "s" } };
    },
    discoverApprovalResult: async () => (signed ? { status: "ready", resultRef: "ref", expiresAt: new Date(T0 + HOUR).toISOString() } : { status: "pending" }),
    fetchApprovalResult: async () => ({}),
    openRelayResult: async () => ({}),
    checkApprovalResultBinding: () => signed!,
    ackApprovalResult: async () => "acknowledged",
  };
  const grants = new SecretGrants({
    store, links: links as unknown as ApprovalLinks, now: () => T0,
    reader: { read: async (_id, session) => (reads.push(session), read()), forget: () => undefined },
    origins: { node: "https://node.example", linksApi: "https://links.example", openkey: "https://openkey.so", openkeyApi: "https://api.openkey.example" },
  });
  return { grants, reads, requests, sign: (g: CheckedApprovalResult) => void (signed = g) };
}

const net: GuardDeps = { lookup: async () => ["93.184.216.34"], connect: async () => { throw new Error("no call expected"); } };
const CALL = { name: NAME, method: "GET", url: "https://api.openai.com/v1/models", headers: { Authorization: "Bearer {{secret}}" } };

describe("no read with a grant that could open the network-wrapped copy", () => {
  test("an approved grant asked before per-secret keys ends at start: no read, no new request", async () => {
    const { store, saved } = storeOf(networkWideRecord("approved"));
    const h = harness(store);
    const outcome = await h.grants.call(BOT, CALL, net);
    expect(outcome.outcome).toBe("ended");
    expect(h.reads).toEqual([]);
    expect(h.requests).toEqual([]);
    expect(saved.get(ID)).toMatchObject({ state: "ended", keys: undefined });
  });

  test("a waiting request asked before per-secret keys fails at start and is never collected", async () => {
    const { store } = storeOf(networkWideRecord("pending"));
    const h = harness(store);
    expect(h.grants.drain(BOT)).toEqual([{ id: ID, outcome: "failed" }]);
    await h.grants.poll();
    expect(h.reads).toEqual([]);
  });

  test("a secret the node won't open with its own key (still network-wrapped) is unavailable, and nothing is asked again", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const h = harness(storeOf().store, () => "unavailable");
      await h.grants.ask(BOT, ID, { name: NAME, sites: ["api.openai.com"], header: "authorization", why: "To transcribe a call.", ownerDid: OWNER });
      h.sign(await grant([ASKED], HOUR, h.requests[0]!.targetDid));
      await h.grants.poll();
      const outcome = await h.grants.call(BOT, CALL, net);
      expect(outcome.outcome).toBe("unavailable");
      expect(h.reads).toHaveLength(1);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]!.permissions).toEqual(secretPermissions(NAME, OWNER));
      // No renewal is asked for, so share-envelope refuses a result that carries one.
      expect(h.requests[0]).not.toHaveProperty("renewal");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the gateway never delegates or attenuates a grant", () => {
  test("a read touches only restoreSession and readSecret on the node client", async () => {
    const touched = new Set<string>();
    const client: GrantNode = {
      restoreSession: async () => undefined,
      readSecret: (async () => ({ status: "ok", value: "sk-test-FAKE" })) as unknown as GrantNode["readSecret"],
    };
    const recorded = new Proxy(client, {
      get(object, property, receiver) {
        // Awaiting the client looks for `then`; that is the promise machinery, not a call on the grant.
        if (property !== "then") touched.add(String(property));
        return Reflect.get(object, property, receiver);
      },
    });
    const reader = nodeSecretReader("https://node.example", () => recorded);
    const session = { address: CHECKSUMMED, chainId: 1 } as GrantSession;
    expect(await reader.read(ID, session, NAME)).toEqual({ value: "sk-test-FAKE" });
    expect(await reader.read(ID, session, NAME)).toEqual({ value: "sk-test-FAKE" });
    expect([...touched].sort()).toEqual(["readSecret", "restoreSession"]);
  });
});
