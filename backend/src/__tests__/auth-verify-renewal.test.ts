/**
 * D2 (TC-2872) `POST /api/auth/verify-renewal`. Real owner signatures (viem), real session keys and
 * SIWE CACAOs (node-sdk WASM), real leases, and a loopback stand-in node: an HTTP server on 127.0.0.1
 * that verifies the relayed compact status invocation and answers with renewal stamps signed by a
 * generated Ed25519 renewer key, in the exact `tinycloud/node/renewal-stamp/v1` format sdk-core's
 * `verifyRenewalHistory` accepts. The client half is the real `renewalVerifyProof`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createPrivateKey, randomBytes, sign as signEd25519 } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import express from "express";
import { createNonceStore, verifySessionToken, type NonceStore } from "@tinyboilerplate/server";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
import { parseCompactUcanAuthorization, signCompactUcanAuthorization, signCompactUcanRootAuthorization } from "@tinycloud/sdk-core";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApiBodyParser } from "../body-parsing.js";
import { VERIFY_RENEWAL_ADDRESS_LIMIT } from "../rate-limits.js";
import { renewalVerifyConfigFromEnv, type RenewalVerifyConfig } from "../renewal-verify.js";
import { createAuthRouter } from "../routes/auth.js";
import { renewalVerifyProof } from "../../../packages/client/src/auth.ts";

const SESSION_KEY = "synthetic-session-signing-key";
const BACKEND_ORIGIN = "https://api.renewal.test";
const HOUR = 3600;

// The stamp crypto is sdk-core's own (noble, multiformats): not backend dependencies, so it resolves
// from sdk-core's install at runtime, as the scripts/renewal harnesses do.
const sdkCorePath = createRequire(import.meta.path).resolve("@tinycloud/sdk-core");
const coreRequire = createRequire(sdkCorePath);
const { ed25519 } = await import(coreRequire.resolve("@noble/curves/ed25519"));
const { blake3 } = await import(coreRequire.resolve("@noble/hashes/blake3"));
const multiformats = join(dirname(sdkCorePath), "../../../multiformats/dist/src");
const { bases } = await import(join(multiformats, "basics.js"));
const { CID } = await import(join(multiformats, "cid.js"));
const { create: createDigest } = await import(join(multiformats, "hashes/digest.js"));

const wasm = new NodeWasmBindings();
const nowSeconds = () => Math.floor(Date.now() / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const didKey = (seed: Uint8Array) =>
  `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 1, ...ed25519.getPublicKey(seed)]))}`;
const rawCid = (text: string) => CID.createV1(0x55, createDigest(0x1e, blake3(Buffer.from(text)))).toString();

/** Minimal canonical DAG-CBOR for the stamp map: strings, small integers, maps (scripts/renewal harness). */
function encodeDagCbor(value: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof value === "string") {
    const b = Buffer.from(value);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (typeof value === "number") return head(0, value);
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, val]) => [encodeDagCbor(key), encodeDagCbor(val)])
    .sort((a, b) => a[0].length - b[0].length || Buffer.compare(a[0], b[0]));
  return Buffer.concat([head(5, entries.length), ...entries.flat()]);
}

// ── Owner, session key, grant and lease ─────────────────────────────

interface Grant {
  account: PrivateKeyAccount;
  address: string;
  spaceId: string;
  siwe: string;
  signature: string;
  delegationCid: string;
  sessionDid: string;
  signSessionBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
}

function sessionSigner(jwk: object) {
  const key = createPrivateKey({ key: jwk as never, format: "jwk" });
  return async (bytes: Uint8Array) => new Uint8Array(signEd25519(null, bytes, key));
}

/** An owner-signed session grant whose signed end has already passed; a web grant unless `domain` says otherwise. */
async function expiredGrant(account = privateKeyToAccount(generatePrivateKey()), domain = "localhost"): Promise<Grant> {
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default"));
  const address = account.address;
  const spaceId = wasm.makeSpaceId(address, 1, "default");
  const now = nowSeconds();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "xyz.tinycloud.tinychat/connectors/": ["tinycloud.kv/get", "tinycloud.kv/list"] } },
    address,
    chainId: 1,
    domain,
    issuedAt: iso(now - 2 * HOUR),
    expirationTime: iso(now - 60),
    spaceId,
    jwk,
  });
  const signature = await account.signMessage({ message: prepared.siwe });
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    account, address, spaceId, siwe: prepared.siwe, signature,
    delegationCid: session.delegationCid,
    sessionDid: manager.getDID("default"),
    signSessionBytes: sessionSigner(jwk),
  };
}

interface Lease { authorization: string; cid: string; expiresAt: number }

/** An owner-signed lease, as OpenKey signs one: `rawAbilities` only, audience the renewer. */
async function signLease(grant: Grant, options: {
  signer?: PrivateKeyAccount;
  audience?: string;
  rawAbilities?: Record<string, string[]>;
  expiresAt?: number;
  /** ReCap proofs (`prf`) to sign into the lease; OpenKey's leases carry none. */
  proofs?: string[];
} = {}): Promise<Lease> {
  const signer = options.signer ?? grant.account;
  const now = nowSeconds();
  const expiresAt = options.expiresAt ?? now + 30 * 24 * HOUR;
  const prepared = wasm.prepareSession({
    abilities: {},
    rawAbilities: options.rawAbilities ?? { [`urn:cid:${grant.delegationCid}`]: ["tinycloud.delegation/renew"] },
    address: wasm.ensureEip55(signer.address),
    chainId: 1,
    domain: "localhost",
    spaceId: wasm.makeSpaceId(signer.address, 1, "default"),
    delegateUri: options.audience ?? node.identity.renewerDid,
    issuedAt: iso(now - 3 * HOUR),
    expirationTime: iso(expiresAt),
  });
  const siwe = options.proofs ? withReCapProofs(prepared.siwe, options.proofs) : prepared.siwe;
  const signature = await signer.signMessage({ message: siwe });
  const session = wasm.completeSessionSetup({ ...prepared, siwe, signature });
  return { authorization: session.delegationHeader.Authorization, cid: session.delegationCid, expiresAt };
}

/** `siwe` with its ReCap resource's `prf` set to `proofs`. */
function withReCapProofs(siwe: string, proofs: string[]): string {
  return siwe.replace(/urn:recap:([A-Za-z0-9_-]+)/, (_, encoded: string) => {
    const recap = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return `urn:recap:${Buffer.from(JSON.stringify({ ...recap, prf: proofs })).toString("base64url")}`;
  });
}

// ── Loopback stand-in node ──────────────────────────────────────────

const renewerSeed = randomBytes(32);
const nodeSeed = randomBytes(32);

const node = {
  server: undefined as ReturnType<typeof Bun.serve> | undefined,
  origin: "",
  identity: {
    nodeDid: didKey(nodeSeed),
    renewerDid: didKey(renewerSeed),
    renewerPublicKey: Buffer.from(ed25519.getPublicKey(renewerSeed)).toString("base64url"),
    renewerEpoch: 1,
  },
  /** Live status the node reports for `cid`. */
  state: { cid: "", active: true, revoked: false, effectiveExpiry: 0, history: [] as unknown[], statusCode: 200 },
  keysCalls: 0,
  statusCalls: 0,
};

function stamp(input: { originalCid: string; lease: Lease; newEnd: number; renewerEpoch?: number; nodeDid?: string }) {
  const bytes = encodeDagCbor({
    domain: "tinycloud/node/renewal-stamp/v1",
    unsigned: {
      type: "TinyCloudRenewalStamp",
      newEnd: iso(input.newEnd).replace(".000Z", "Z"),
      nodeDid: input.nodeDid ?? node.identity.nodeDid,
      version: 1,
      leaseCid: input.lease.cid,
      originalCid: input.originalCid,
      renewerEpoch: input.renewerEpoch ?? 1,
      leaseGeneration: 1,
      previousStampCid: input.lease.cid,
    },
  });
  return {
    cid: CID.createV1(0x55, createDigest(0x1e, blake3(bytes))).toString(),
    lease_cid: input.lease.cid,
    generation: 1,
    previous_stamp_cid: input.lease.cid,
    new_end: input.newEnd,
    signed_bytes: Buffer.from(bytes).toString("base64url"),
    signature: Buffer.from(ed25519.sign(bytes, renewerSeed)).toString("base64url"),
  };
}

function startNode(port = 0) {
  node.server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/.well-known/tinycloud/node-keys") {
        node.keysCalls++;
        return Response.json(node.identity);
      }
      if (request.method === "POST" && url.pathname === "/delegation/status") {
        node.statusCalls++;
        const { cid }: { cid: string } = await request.json();
        // As the real node: a verifiable invocation bound to exactly this CID's status, addressed to this node.
        let payload;
        try {
          payload = parseCompactUcanAuthorization(request.headers.get("authorization") ?? "").payload;
        } catch {
          return new Response("Invalid status invocation", { status: 401 });
        }
        const abilities = payload.att[`urn:cid:${cid}`];
        if (Object.keys(payload.att).length !== 1 || !abilities?.["tinycloud.delegation/status"] || payload.aud !== node.identity.nodeDid ||
          payload.exp <= nowSeconds()) {
          return new Response("Status invocation is not bound to the requested CID", { status: 403 });
        }
        if (node.state.statusCode !== 200) return new Response("Status unavailable", { status: node.state.statusCode });
        if (cid !== node.state.cid) return Response.json({ cid, exists: false }, { status: 404 });
        return Response.json({
          cid,
          status: node.state.active ? "active" : "revoked",
          exists: true,
          active: node.state.active,
          revoked: node.state.revoked,
          expired: false,
          effective_expiry: node.state.effectiveExpiry,
          renewal_history: node.state.history,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  node.origin = `http://127.0.0.1:${node.server.port}`;
}

beforeAll(() => startNode());
afterAll(() => node.server?.stop(true));
afterEach(() => {
  node.identity.renewerEpoch = 1;
  node.state.statusCode = 200;
});

// ── Backend under test ──────────────────────────────────────────────

function renewalConfig(overrides: Partial<RenewalVerifyConfig> = {}): RenewalVerifyConfig {
  return { backendOrigin: BACKEND_ORIGIN, nodeOrigin: node.origin, nodeDid: node.identity.nodeDid, renewerDid: node.identity.renewerDid, ...overrides };
}

function backend(renewal: RenewalVerifyConfig | null = renewalConfig()) {
  const nonceStore = createNonceStore();
  const app = express();
  app.use(createApiBodyParser());
  app.use("/api/auth", createAuthRouter({
    nonceStore, privateKey: SESSION_KEY, frontendOrigins: ["http://localhost:5186"], renewal: renewal ?? undefined,
  }));
  const server = app.listen(0, "127.0.0.1");
  const listening = Promise.withResolvers<string>();
  server.once("listening", () => {
    const address = server.address();
    if (address && typeof address === "object") listening.resolve(`http://127.0.0.1:${address.port}`);
  });
  const base = listening.promise;
  return {
    nonceStore,
    async post(body: unknown) {
      const response = await fetch(`${await base}/api/auth/verify-renewal`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
        body: JSON.stringify(body),
      });
      const json: Record<string, unknown> = await response.json();
      return { status: response.status, body: json };
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** The tcw surface `renewalVerifyProof` reads, backed by the grant's real session key. */
function restoredTcw(grant: Grant) {
  return {
    session: () => ({ address: grant.address, walletAddress: grant.address, chainId: 1, sessionKey: "default", siwe: grant.siwe, signature: grant.signature }),
    accountAuthorizationCid: () => grant.delegationCid,
    sessionDid: grant.sessionDid,
    signSessionBytes: grant.signSessionBytes,
    activeNodeIdentity: async () => ({ origin: node.origin, nodeDid: node.identity.nodeDid }),
  };
}

async function requestBody(grant: Grant, lease: Lease, nonceStore: NonceStore, address = grant.address) {
  const nonce = nonceStore.generate(address);
  const proof = await renewalVerifyProof({ tcw: restoredTcw(grant), backendOrigin: BACKEND_ORIGIN, address, nonce });
  return { address, nonce, leaseAuthorization: lease.authorization, ...proof };
}

/** The node holds `grant`, renewed by `lease` until `newEnd`. */
function nodeRenews(grant: Grant, lease: Lease, newEnd: number, history = [stamp({ originalCid: grant.delegationCid, lease, newEnd })]) {
  node.state = { cid: grant.delegationCid, active: true, revoked: false, effectiveExpiry: newEnd, history, statusCode: 200 };
}

const nodeCalls = () => node.keysCalls + node.statusCalls;

let grant: Grant;
let lease: Lease;
beforeAll(async () => {
  grant = await expiredGrant();
  lease = await signLease(grant);
});

describe("POST /api/auth/verify-renewal", () => {
  test("after the original's signed end, a live renewal gets a bearer capped at the renewed end", async () => {
    const api = backend();
    try {
      const newEnd = nowSeconds() + 2 * HOUR;
      nodeRenews(grant, lease, newEnd);
      const result = await api.post(await requestBody(grant, lease, api.nonceStore));
      expect(result.status).toBe(200);
      expect(result.body.address).toBe(grant.address.toLowerCase());
      expect(result.body.renewal).toEqual({ effectiveEnd: newEnd });
      const expiresIn = result.body.expiresIn as number;
      expect(Math.abs(expiresIn - 2 * HOUR)).toBeLessThanOrEqual(2);
      expect(await verifySessionToken(result.body.token as string, SESSION_KEY)).toEqual({ address: grant.address.toLowerCase() });
    } finally {
      api.close();
    }
  });

  test("a renewal longer than a day gets a one-day bearer", async () => {
    const api = backend();
    try {
      const newEnd = nowSeconds() + 3 * 24 * HOUR;
      nodeRenews(grant, lease, newEnd);
      const result = await api.post(await requestBody(grant, lease, api.nonceStore));
      expect(result.status).toBe(200);
      expect(result.body.renewal).toEqual({ effectiveEnd: newEnd });
      expect(Math.abs((result.body.expiresIn as number) - 24 * HOUR)).toBeLessThanOrEqual(2);
    } finally {
      api.close();
    }
  });

  test("a replayed nonce is refused before anything else, and the node is not asked again", async () => {
    const api = backend();
    try {
      nodeRenews(grant, lease, nowSeconds() + HOUR);
      const body = await requestBody(grant, lease, api.nonceStore);
      expect((await api.post(body)).status).toBe(200);
      const calls = nodeCalls();
      expect(await api.post(body)).toEqual({ status: 401, body: { error: "invalid_nonce" } });
      expect(nodeCalls()).toBe(calls);
    } finally {
      api.close();
    }
  });

  /** Each refusal consumes its nonce and never reaches the node. */
  async function refusedBeforeNode(body: Record<string, unknown>, code: string, api = backend()) {
    try {
      nodeRenews(grant, lease, nowSeconds() + HOUR);
      const calls = nodeCalls();
      expect(await api.post(body)).toEqual({ status: 401, body: { error: code } });
      expect(nodeCalls()).toBe(calls);
      expect(api.nonceStore.validate(body.address as string, body.nonce as string)).toBe(false);
    } finally {
      api.close();
    }
  }

  test("a grant signed by another owner than the address is refused", async () => {
    const api = backend();
    const other = privateKeyToAccount(generatePrivateKey());
    await refusedBeforeNode(await requestBody(grant, lease, api.nonceStore, other.address), "wrong_owner", api);
  });

  test("a lease signed by another owner is refused", async () => {
    const api = backend();
    const foreign = await signLease(grant, { signer: privateKeyToAccount(generatePrivateKey()) });
    await refusedBeforeNode(await requestBody(grant, foreign, api.nonceStore), "lease_wrong_owner", api);
  });

  test("a lease to another audience than the pinned renewer is refused", async () => {
    const api = backend();
    const wrongAudience = await signLease(grant, { audience: didKey(randomBytes(32)) });
    await refusedBeforeNode(await requestBody(grant, wrongAudience, api.nonceStore), "lease_wrong_audience", api);
  });

  test("a lease with an extra capability is refused", async () => {
    const api = backend();
    const extra = await signLease(grant, {
      rawAbilities: { [`urn:cid:${grant.delegationCid}`]: ["tinycloud.delegation/renew", "tinycloud.delegation/status"] },
    });
    await refusedBeforeNode(await requestBody(grant, extra, api.nonceStore), "lease_wrong_scope", api);
  });

  test("a lease for another delegation CID is refused", async () => {
    const api = backend();
    const elsewhere = await signLease(grant, { rawAbilities: { [`urn:cid:${rawCid("another-grant")}`]: ["tinycloud.delegation/renew"] } });
    await refusedBeforeNode(await requestBody(grant, elsewhere, api.nonceStore), "lease_wrong_scope", api);
  });

  test("a lease that carries a proof is refused", async () => {
    const api = backend();
    const proved = await signLease(grant, { proofs: [rawCid("a-parent-grant")] });
    await refusedBeforeNode(await requestBody(grant, proved, api.nonceStore), "lease_wrong_scope", api);
  });

  test("a lapsed lease is refused", async () => {
    const api = backend();
    const lapsed = await signLease(grant, { expiresAt: nowSeconds() - 60 });
    await refusedBeforeNode(await requestBody(grant, lapsed, api.nonceStore), "lease_expired", api);
  });

  test("a holder proof from another key is refused", async () => {
    const api = backend();
    const body = await requestBody(grant, lease, api.nonceStore);
    const otherKey = randomBytes(32);
    const message = `tinychat-renewal-verify|${BACKEND_ORIGIN}|${grant.address.toLowerCase()}|${grant.delegationCid}|${body.nonce}`;
    body.holderProof = Buffer.from(ed25519.sign(Buffer.from(message), otherKey)).toString("base64url");
    await refusedBeforeNode(body, "invalid_holder_proof", api);
  });

  test("a holder proof for another backend origin is refused", async () => {
    const api = backend();
    const nonce = api.nonceStore.generate(grant.address);
    const proof = await renewalVerifyProof({ tcw: restoredTcw(grant), backendOrigin: "https://elsewhere.test", address: grant.address, nonce });
    await refusedBeforeNode({ address: grant.address, nonce, leaseAuthorization: lease.authorization, ...proof }, "invalid_holder_proof", api);
  });

  test("a delegation CID that is not the presented grant's is refused", async () => {
    const api = backend();
    const other = await expiredGrant(grant.account);
    const body = await requestBody(grant, lease, api.nonceStore);
    body.delegation = { ...body.delegation, delegationCid: other.delegationCid };
    await refusedBeforeNode(body, "grant_cid_mismatch", api);
  });

  test("a status invocation replayed after its expiry is refused without calling the node", async () => {
    const api = backend();
    const body = await requestBody(grant, lease, api.nonceStore);
    const past = nowSeconds() - 120;
    body.statusInvocation = (await signCompactUcanAuthorization({
      issuerDid: grant.sessionDid,
      audienceDid: node.identity.nodeDid,
      attenuation: { [`urn:cid:${grant.delegationCid}`]: { "tinycloud.delegation/status": [{}] } },
      facts: [{}],
      proofs: [],
      notBefore: past,
      expiresAt: past + 60,
      nonce: body.nonce,
      sign: grant.signSessionBytes,
    })).authorization;
    await refusedBeforeNode(body, "invalid_status_invocation", api);
  });

  /**
   * The request's status invocation, re-signed by the grant's session key with one field changed. Signed
   * with sdk-core's root signer: the same compact shape (no proofs), but it does not refuse a lifetime over 60 s.
   */
  async function reissuedInvocation(body: { nonce: string }, change: { nonce?: string; audienceDid?: string; notBefore?: number; expiresAt?: number }) {
    const now = nowSeconds();
    return (await signCompactUcanRootAuthorization({
      issuerDid: grant.sessionDid,
      audienceDid: change.audienceDid ?? node.identity.nodeDid,
      attenuation: { [`urn:cid:${grant.delegationCid}`]: { "tinycloud.delegation/status": [{}] } },
      facts: [{}],
      proofs: [],
      notBefore: change.notBefore ?? now,
      expiresAt: change.expiresAt ?? now + 60,
      nonce: change.nonce ?? body.nonce,
      sign: grant.signSessionBytes,
    })).authorization;
  }

  test("a status invocation carrying another nonce than the request's is refused without calling the node", async () => {
    const api = backend();
    const body = await requestBody(grant, lease, api.nonceStore);
    body.statusInvocation = await reissuedInvocation(body, { nonce: api.nonceStore.generate(grant.address) });
    await refusedBeforeNode(body, "invalid_status_invocation", api);
  });

  test("a status invocation addressed to another node is refused without calling the node", async () => {
    const api = backend();
    const body = await requestBody(grant, lease, api.nonceStore);
    body.statusInvocation = await reissuedInvocation(body, { audienceDid: didKey(randomBytes(32)) });
    await refusedBeforeNode(body, "invalid_status_invocation", api);
  });

  test("a status invocation valid for longer than 60 s is refused without calling the node", async () => {
    const api = backend();
    const body = await requestBody(grant, lease, api.nonceStore);
    const now = nowSeconds();
    body.statusInvocation = await reissuedInvocation(body, { notBefore: now - 30, expiresAt: now + 60 });
    await refusedBeforeNode(body, "invalid_status_invocation", api);
  });

  test("a native OpenKey grant is refused: only web grants renew here", async () => {
    const api = backend();
    const native = await expiredGrant(grant.account, "openkey.so");
    await refusedBeforeNode(await requestBody(native, await signLease(native), api.nonceStore), "invalid_origin", api);
  });

  /** Refusals the live node check produces: the node was asked once each. */
  async function refusedByNode(code: string, arrange: () => void, expected: 401 | 503 = 401) {
    const api = backend();
    try {
      nodeRenews(grant, lease, nowSeconds() + HOUR);
      arrange();
      const body = await requestBody(grant, lease, api.nonceStore);
      expect(await api.post(body)).toEqual({ status: expected, body: { error: code } });
    } finally {
      api.close();
    }
  }

  test("a validly signed history for a different delegation is refused", async () => {
    await refusedByNode("renewal_history_invalid", () => {
      node.state.history = [stamp({ originalCid: rawCid("another-original"), lease, newEnd: nowSeconds() + HOUR })];
    });
  });

  test("a revoked delegation is refused", async () => {
    await refusedByNode("renewal_inactive", () => {
      node.state.active = false;
      node.state.revoked = true;
    });
  });

  test("a delegation the node does not hold is refused", async () => {
    await refusedByNode("renewal_inactive", () => {
      node.state.cid = rawCid("not-this-one");
    });
  });

  test("a lapsed renewal stamp is refused", async () => {
    await refusedByNode("renewal_history_invalid", () => {
      const lapsed = nowSeconds() - 30;
      node.state.effectiveExpiry = lapsed;
      node.state.history = [stamp({ originalCid: grant.delegationCid, lease, newEnd: lapsed })];
    });
  });

  test("a renewer epoch change is refused", async () => {
    await refusedByNode("renewal_history_invalid", () => {
      node.identity.renewerEpoch = 2;
    });
  });

  test("a node error answers 503", async () => {
    await refusedByNode("node_unavailable", () => {
      node.state.statusCode = 500;
    }, 503);
  });

  test("an unreachable node answers 503", async () => {
    const api = backend(renewalConfig({ nodeOrigin: "http://127.0.0.1:9" }));
    try {
      nodeRenews(grant, lease, nowSeconds() + HOUR);
      expect(await api.post(await requestBody(grant, lease, api.nonceStore))).toEqual({ status: 503, body: { error: "node_unavailable" } });
    } finally {
      api.close();
    }
  });

  test("without renewal config the route answers 503 and leaves the nonce unused", async () => {
    const api = backend(null);
    try {
      const body = await requestBody(grant, lease, api.nonceStore);
      const calls = nodeCalls();
      expect(await api.post(body)).toEqual({ status: 503, body: { error: "renewal_unavailable" } });
      expect(nodeCalls()).toBe(calls);
      expect(api.nonceStore.validate(body.address, body.nonce)).toBe(true);
    } finally {
      api.close();
    }
  });

  test(`each address may renew ${VERIFY_RENEWAL_ADDRESS_LIMIT} times a minute; the next is refused 429 without asking the node`, async () => {
    const api = backend();
    try {
      nodeRenews(grant, lease, nowSeconds() + HOUR);
      for (let i = 0; i < VERIFY_RENEWAL_ADDRESS_LIMIT; i++) {
        expect((await api.post(await requestBody(grant, lease, api.nonceStore))).status).toBe(200);
      }
      const calls = nodeCalls();
      expect(await api.post(await requestBody(grant, lease, api.nonceStore))).toEqual({ status: 429, body: { error: "rate_limited" } });
      expect(nodeCalls()).toBe(calls);
    } finally {
      api.close();
    }
  });

  test("requests without the grant's session key spend no one's budget: not the victim's, not the service's", async () => {
    const api = backend();
    try {
      nodeRenews(grant, lease, nowSeconds() + HOUR);
      const otherKey = randomBytes(32);
      for (let i = 0; i < 4 * VERIFY_RENEWAL_ADDRESS_LIMIT; i++) {
        // Junk from many claimed addresses, and forged holder proofs for the victim's own address.
        expect((await api.post({ address: privateKeyToAccount(generatePrivateKey()).address })).status).toBe(400);
        const forged = await requestBody(grant, lease, api.nonceStore);
        forged.holderProof = Buffer.from(ed25519.sign(Buffer.from("forged"), otherKey)).toString("base64url");
        expect(await api.post(forged)).toEqual({ status: 401, body: { error: "invalid_holder_proof" } });
      }
      expect((await api.post(await requestBody(grant, lease, api.nonceStore))).status).toBe(200);
    } finally {
      api.close();
    }
  });
});

describe("renewalVerifyConfigFromEnv", () => {
  const dids = { RENEWAL_NODE_DID: node.identity.nodeDid, RENEWAL_RENEWER_DID: node.identity.renewerDid };

  test("is off without settings and refuses a partial set", () => {
    expect(renewalVerifyConfigFromEnv({}, "https://node.tinycloud.xyz")).toBeUndefined();
    expect(() => renewalVerifyConfigFromEnv({ RENEWAL_NODE_DID: dids.RENEWAL_NODE_DID }, "https://node.tinycloud.xyz")).toThrow("set together");
  });

  test("pins the node to TINYCLOUD_HOST and allows loopback http only outside production", () => {
    const env = { ...dids, RENEWAL_BACKEND_ORIGIN: "https://api.tinycloud.chat" };
    expect(renewalVerifyConfigFromEnv({ ...env, NODE_ENV: "production" }, "https://tee.node.tinycloud.xyz")).toEqual({
      backendOrigin: "https://api.tinycloud.chat",
      nodeOrigin: "https://tee.node.tinycloud.xyz",
      nodeDid: dids.RENEWAL_NODE_DID,
      renewerDid: dids.RENEWAL_RENEWER_DID,
    });
    expect(renewalVerifyConfigFromEnv({ ...env, NODE_ENV: "development" }, "http://127.0.0.1:8000")?.nodeOrigin).toBe("http://127.0.0.1:8000");
    expect(() => renewalVerifyConfigFromEnv({ ...env, NODE_ENV: "production" }, "http://127.0.0.1:8000")).toThrow("https origin");
    expect(() => renewalVerifyConfigFromEnv({ ...env, NODE_ENV: "development" }, "http://node.example")).toThrow("https origin");
    expect(() => renewalVerifyConfigFromEnv({ ...env, RENEWAL_BACKEND_ORIGIN: "https://api.tinycloud.chat/api" }, "https://node.tinycloud.xyz")).toThrow("https origin");
  });
});
