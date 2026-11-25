import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { CheckedApprovalResult, Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";
import * as realLinks from "@tinycloud/share-envelope/links";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { type ApprovalLinks, type ApprovalRequest, SecretGrants } from "../secret-grants";
import { jwkFromSeed } from "../secret-start";
import type { GrantStore } from "../secret-store";

// Which key signs each call to OpenKey. Until the owner opens the link OpenKey checks a poll's proof against the
// link's issuer (the stable requester); once it is loaded, against the grant's key. Fake keys and values only.
const ORIGINS = { node: "https://node.example", linksApi: "https://links.example", openkey: "https://openkey.so", openkeyApi: "https://api.openkey.example" };
const OWNER_KEY = privateKeyToAccount(`0x${"11".repeat(32)}`);
const OWNER = `did:pkh:eip155:1:${OWNER_KEY.address.toLowerCase()}`;
const ASK = { name: "OPENAI_API_KEY", sites: ["api.openai.com"], header: "authorization", why: "To transcribe a call.", ownerDid: OWNER };
const BOT = "b".repeat(64);
const ID = "9c41e0d2a7b3f6c18e5d2a90";
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 22, 12, 0);
const reader = { read: async () => ({ value: "v" }), forget: () => undefined };

const stableJwk = jwkFromSeed(new Uint8Array(32).fill(7));
const stable = realLinks.signerFromJwk(stableJwk);

function memoryStore(): GrantStore {
  const files = new Map<string, { botId: string; record: unknown }>();
  return { load: () => [...files].map(([id, file]) => ({ id, botId: file.botId, record: structuredClone(file.record) })), save: (id, botId, record) => void files.set(id, { botId, record: structuredClone(record) }), remove: id => void files.delete(id) };
}

const recap = (att: Record<string, unknown>) => `urn:recap:${Buffer.from(JSON.stringify({ att, prf: [] })).toString("base64url")}`;

/** What OpenKey hands back for `request`, signed by the owner's wallet. */
async function grantFor(request: ApprovalRequest): Promise<CheckedApprovalResult> {
  const audience = request.targetDid;
  const uri = `${audience}#${audience.slice("did:key:".length)}`;
  const siwe = createSiweMessage({
    domain: "openkey.so", address: OWNER_KEY.address, uri, version: "1", chainId: 1, nonce: "abcdefgh12345678", issuedAt: new Date(T0), expirationTime: new Date(T0 + HOUR),
    resources: [recap({
      [`tinycloud:pkh:eip155:1:${OWNER_KEY.address}:secrets/kv/vault/secrets/OPENAI_API_KEY`]: { "tinycloud.kv/get": [{}] },
      [`urn:tinycloud:encryption:did:pkh:eip155:1:${OWNER_KEY.address}:default`]: { "tinycloud.encryption/decrypt": [{}] },
    })],
  });
  return {
    ownerDid: OWNER,
    delegationExpiresAt: new Date(T0 + HOUR).toISOString(),
    delegation: {
      siwe, signature: await OWNER_KEY.signMessage({ message: siwe }), delegationCid: "bafy-delegation", spaceId: `tinycloud:pkh:eip155:1:${OWNER_KEY.address}:secrets`,
      address: OWNER_KEY.address, chainId: 1, verificationMethod: uri, delegationHeader: { Authorization: "Bearer fake-ucan" },
    },
  } as CheckedApprovalResult;
}

type Who = "stable" | "grant";
type Mode = "split" | "reject-all" | "ready";

/** OpenKey played from a script: it names the key behind every proof it is given, and refuses a wrong one with HTTP 401's code. */
function openkey() {
  let request: ApprovalRequest | undefined;
  const state = { loaded: false, mode: "split" as Mode };
  const calls: Array<{ action: "discover" | "fetch" | "ack"; who: Who; accepted: boolean }> = [];
  let granted: CheckedApprovalResult | undefined;
  const who = (key: Ed25519PrivateJwk): Who => (key.x === stableJwk.x ? "stable" : "grant");
  const check = (action: "discover" | "fetch" | "ack", key: Ed25519PrivateJwk) => {
    const accepted = state.mode !== "reject-all" && who(key) === (action === "discover" && !state.loaded ? "stable" : "grant");
    calls.push({ action, who: who(key), accepted });
    if (!accepted) throw new realLinks.ApprovalClientError("request_binding", "refused proof", 401);
  };
  const links = {
    generateRelayKey: realLinks.generateRelayKey,
    signerFromJwk: realLinks.signerFromJwk,
    isApprovalClientError: realLinks.isApprovalClientError,
    createApprovalRequest: async (input: { request: ApprovalRequest; expiresAt: Date }) => {
      request = input.request;
      return { link: "https://openkey.so/a/req1#k", id: "req1", bodyCid: "bafy-body", expiresAt: input.expiresAt.toISOString(), record: { header: "h", signature: "s" } };
    },
    discoverApprovalResult: async (s: { signingKey: Ed25519PrivateJwk }) => {
      check("discover", s.signingKey);
      return state.mode === "ready" ? { status: "ready", resultRef: "ref-1", expiresAt: new Date(T0 + HOUR).toISOString() } : { status: "pending" };
    },
    fetchApprovalResult: async (s: { signingKey: Ed25519PrivateJwk }) => (check("fetch", s.signingKey), {}),
    openRelayResult: async () => ({}),
    checkApprovalResultBinding: () => granted!,
    ackApprovalResult: async (s: { signingKey: Ed25519PrivateJwk }) => (check("ack", s.signingKey), "acknowledged"),
  };
  return { links: links as unknown as ApprovalLinks, state, calls, approve: async () => void (granted = await grantFor(request!)) };
}

let ok: ReturnType<typeof openkey>;
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  ok = openkey();
  spy = spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => spy.mockRestore());
const summary = () => ok.calls.map(call => `${call.action}:${call.who}${call.accepted ? "" : "!"}`);

describe("the stable requester and the polls", () => {
  const stableGrants = () => new SecretGrants({ store: memoryStore(), reader, links: ok.links, origins: ORIGINS, now: () => T0, requester: () => stable, requesterJwk: stableJwk });

  test("a poll up to the link being opened is signed by the stable key; after, one refusal moves it to the grant key for good", async () => {
    const grants = stableGrants();
    await grants.ask(BOT, ID, ASK);
    await grants.poll();
    expect(summary()).toEqual(["discover:stable"]);
    // The owner opens the link: OpenKey wants the grant key from here. The stable proof is refused once, the retry works,
    // and the request is not failed.
    ok.state.loaded = true;
    await grants.poll();
    expect(summary()).toEqual(["discover:stable", "discover:stable!", "discover:grant"]);
    expect(grants.drain(BOT)).toEqual([]);
    // The next polls go straight to the grant key, and the approval completes with fetch and acknowledge on it too.
    await grants.poll();
    expect(summary().slice(3)).toEqual(["discover:grant"]);
    ok.state.mode = "ready";
    await ok.approve();
    await grants.poll();
    expect(summary().slice(4)).toEqual(["discover:grant", "fetch:grant", "ack:grant"]);
    expect(grants.drain(BOT)).toEqual([{ id: ID, outcome: "approved", until: T0 + HOUR }]);
  });

  test("approval collected while the stable key was the one OpenKey accepted: fetch and acknowledge never use it", async () => {
    const grants = stableGrants();
    await grants.ask(BOT, ID, ASK);
    ok.state.mode = "ready";
    await ok.approve();
    await grants.poll();
    expect(summary()).toEqual(["discover:stable", "fetch:grant", "ack:grant"]);
    expect(grants.drain(BOT)).toEqual([{ id: ID, outcome: "approved", until: T0 + HOUR }]);
  });

  test("the grant key's switch survives a restart: the new gateway does not go back to the stable key", async () => {
    const store = memoryStore();
    const first = new SecretGrants({ store, reader, links: ok.links, origins: ORIGINS, now: () => T0, requester: () => stable, requesterJwk: stableJwk });
    await first.ask(BOT, ID, ASK);
    ok.state.loaded = true;
    await first.poll();
    const restarted = new SecretGrants({ store, reader, links: ok.links, origins: ORIGINS, now: () => T0, requester: () => stable, requesterJwk: stableJwk });
    await restarted.poll();
    expect(summary()).toEqual(["discover:stable!", "discover:grant", "discover:grant"]);
  });

  test("when OpenKey refuses both keys the request fails, as a refused poll always has", async () => {
    const grants = stableGrants();
    await grants.ask(BOT, ID, ASK);
    ok.state.mode = "reject-all";
    await grants.poll();
    expect(summary()).toEqual(["discover:stable!", "discover:grant!"]);
    expect(grants.drain(BOT)).toEqual([{ id: ID, outcome: "failed" }]);
  });

  test("a request made with the grant's own key (the default) sends one proof per poll, by the grant key, with no retry", async () => {
    const grants = new SecretGrants({ store: memoryStore(), reader, links: ok.links, origins: ORIGINS, now: () => T0 });
    await grants.ask(BOT, ID, ASK);
    ok.state.loaded = true;
    await grants.poll();
    await grants.poll();
    expect(summary()).toEqual(["discover:grant", "discover:grant"]);
  });

  test("a stable key that is not this request's requester is not used: a request from a rotated key polls with the grant key", async () => {
    const old = realLinks.signerFromSeed(new Uint8Array(32).fill(5));
    const store = memoryStore();
    await new SecretGrants({ store, reader, links: ok.links, origins: ORIGINS, now: () => T0, requester: () => old }).ask(BOT, ID, ASK);
    ok.state.loaded = true;
    await new SecretGrants({ store, reader, links: ok.links, origins: ORIGINS, now: () => T0, requester: () => stable, requesterJwk: stableJwk }).poll();
    expect(summary()).toEqual(["discover:grant"]);
  });

  test("the JWK of a seed is the key that signs as the same DID", () => {
    expect(realLinks.signerFromJwk(stableJwk).did).toBe(realLinks.signerFromSeed(new Uint8Array(32).fill(7)).did);
  });
});
