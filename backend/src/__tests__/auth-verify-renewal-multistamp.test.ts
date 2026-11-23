/**
 * `POST /api/auth/verify-renewal` and sdk-core's `verifyRenewalHistory` on multi-stamp histories as
 * the node returns them: every stamp of a lease carries the lease's own generation, so a lease renewed
 * 90 or 180 times has 90 or 180 stamps with the SAME `generation`. Nothing here is mocked: the verifier
 * is the installed sdk-core, the stamps are real Ed25519-signed canonical DAG-CBOR in the
 * `tinycloud/node/renewal-stamp/v1` format, the owner signatures and leases are real, and the node is a
 * loopback HTTP server. These tests pass only with an sdk-core that pins the generation to the lease.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createPrivateKey, randomBytes, sign as signEd25519 } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import express from "express";
import { createNonceStore, verifySessionToken, type NonceStore } from "@tinyboilerplate/server";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
import { parseCompactUcanAuthorization } from "@tinycloud/sdk-core";
import { verifyRenewalHistory } from "@tinycloud/sdk-core/delegations/renewal";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApiBodyParser } from "../body-parsing.js";
import type { RenewalVerifyConfig } from "../renewal-verify.js";
import { createAuthRouter } from "../routes/auth.js";
import { renewalVerifyProof } from "../../../packages/client/src/auth.ts";

const SESSION_KEY = "synthetic-session-signing-key";
const BACKEND_ORIGIN = "https://api.renewal.test";
const HOUR = 3600;
const DAY = 24 * HOUR;
const MAX_STATUS_BYTES = 1024 * 1024;

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

/** An owner-signed web session grant whose signed end has already passed. */
async function expiredGrant(): Promise<Grant> {
  const account = privateKeyToAccount(generatePrivateKey());
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default"));
  const address = account.address;
  const now = nowSeconds();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "xyz.tinycloud.tinychat/connectors/": ["tinycloud.kv/get", "tinycloud.kv/list"] } },
    address,
    chainId: 1,
    domain: "localhost",
    issuedAt: iso(now - 2 * HOUR),
    expirationTime: iso(now - 60),
    spaceId: wasm.makeSpaceId(address, 1, "default"),
    jwk,
  });
  const signature = await account.signMessage({ message: prepared.siwe });
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    account, address, siwe: prepared.siwe, signature,
    delegationCid: session.delegationCid,
    sessionDid: manager.getDID("default"),
    signSessionBytes: sessionSigner(jwk),
  };
}

interface Lease { authorization: string; cid: string; expiresAt: number }

/** An owner-signed lease as OpenKey signs one: renew-only on the grant, audience the renewer. */
async function signLease(grant: Grant, expiresAt = nowSeconds() + 90 * DAY): Promise<Lease> {
  const now = nowSeconds();
  const prepared = wasm.prepareSession({
    abilities: {},
    rawAbilities: { [`urn:cid:${grant.delegationCid}`]: ["tinycloud.delegation/renew"] },
    address: wasm.ensureEip55(grant.account.address),
    chainId: 1,
    domain: "localhost",
    spaceId: wasm.makeSpaceId(grant.account.address, 1, "default"),
    delegateUri: node.identity.renewerDid,
    issuedAt: iso(now - 3 * HOUR),
    expirationTime: iso(expiresAt),
  });
  const signature = await grant.account.signMessage({ message: prepared.siwe });
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { authorization: session.delegationHeader.Authorization, cid: session.delegationCid, expiresAt };
}

// ── Node identity and real renewal stamps ───────────────────────────

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
  state: { cid: "", effectiveExpiry: 0, history: [] as StampEntry[] },
};

interface StampEntry {
  cid: string;
  lease_cid: string;
  generation: number;
  previous_stamp_cid: string;
  new_end: number;
  signed_bytes: string;
  signature: string;
}

interface StampInput {
  originalCid: string;
  /** Lease CID the entry (and the signed bytes) name. */
  leaseCid: string;
  newEnd: number;
  /** Signed `leaseGeneration`, and the entry's `generation` unless `entryGeneration` says otherwise. */
  generation: number;
  previousStampCid: string;
}

function stamp(input: StampInput): StampEntry {
  const bytes = encodeDagCbor({
    domain: "tinycloud/node/renewal-stamp/v1",
    unsigned: {
      type: "TinyCloudRenewalStamp",
      newEnd: iso(input.newEnd).replace(".000Z", "Z"),
      nodeDid: node.identity.nodeDid,
      version: 1,
      leaseCid: input.leaseCid,
      originalCid: input.originalCid,
      renewerEpoch: node.identity.renewerEpoch,
      leaseGeneration: input.generation,
      previousStampCid: input.previousStampCid,
    },
  });
  return {
    cid: CID.createV1(0x55, createDigest(0x1e, blake3(bytes))).toString(),
    lease_cid: input.leaseCid,
    generation: input.generation,
    previous_stamp_cid: input.previousStampCid,
    new_end: input.newEnd,
    signed_bytes: Buffer.from(bytes).toString("base64url"),
    signature: Buffer.from(ed25519.sign(bytes, renewerSeed)).toString("base64url"),
  };
}

/** What a stamp at `index` is built from; a case returns a changed copy to make that stamp wrong. */
type Fields = Pick<StampInput, "leaseCid" | "newEnd" | "generation" | "previousStampCid">;

/**
 * `count` stamps chained from the lease, `step` seconds apart and ending at `lastEnd`. The node gives
 * every stamp the lease's generation (1); `change(index, fields)` edits one stamp's signed fields and
 * the chain carries on from the edited stamp's CID, so only that stamp is wrong.
 */
function chain(grant: Grant, lease: Lease, count: number, lastEnd: number, step: number,
  change?: (index: number, fields: Fields) => Fields): StampEntry[] {
  const entries: StampEntry[] = [];
  let previousStampCid = lease.cid;
  for (let index = 0; index < count; index++) {
    const fields: Fields = { leaseCid: lease.cid, newEnd: lastEnd - (count - 1 - index) * step, generation: 1, previousStampCid };
    const entry = stamp({ originalCid: grant.delegationCid, ...(change?.(index, fields) ?? fields) });
    entries.push(entry);
    previousStampCid = entry.cid;
  }
  return entries;
}

function startNode() {
  node.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/.well-known/tinycloud/node-keys") return Response.json(node.identity);
      if (request.method === "POST" && url.pathname === "/delegation/status") {
        const { cid }: { cid: string } = await request.json();
        // The relayed status invocation must be a well-formed compact UCAN for exactly this CID's status.
        let payload;
        try {
          payload = parseCompactUcanAuthorization(request.headers.get("authorization") ?? "").payload;
        } catch {
          return new Response("Invalid status invocation", { status: 401 });
        }
        if (Object.keys(payload.att).length !== 1 || !payload.att[`urn:cid:${cid}`]?.["tinycloud.delegation/status"] ||
          payload.aud !== node.identity.nodeDid || payload.exp <= nowSeconds()) {
          return new Response("Status invocation is not bound to the requested CID", { status: 403 });
        }
        if (cid !== node.state.cid) return Response.json({ cid, exists: false }, { status: 404 });
        return Response.json({
          cid, status: "active", exists: true, active: true, revoked: false, expired: false,
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
});

// ── Backend under test ──────────────────────────────────────────────

function renewalConfig(): RenewalVerifyConfig {
  return { backendOrigin: BACKEND_ORIGIN, nodeOrigin: node.origin, nodeDid: node.identity.nodeDid, renewerDid: node.identity.renewerDid };
}

function backend() {
  const nonceStore = createNonceStore();
  const app = express();
  app.use(createApiBodyParser());
  app.use("/api/auth", createAuthRouter({
    nonceStore, privateKey: SESSION_KEY, frontendOrigins: ["http://localhost:5186"], renewal: renewalConfig(),
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

async function requestBody(grant: Grant, lease: Lease, nonceStore: NonceStore) {
  const nonce = nonceStore.generate(grant.address);
  const proof = await renewalVerifyProof({ tcw: restoredTcw(grant), backendOrigin: BACKEND_ORIGIN, address: grant.address, nonce });
  return { address: grant.address, nonce, leaseAuthorization: lease.authorization, ...proof };
}

/** Post a verify request while the node reports `history` for the grant, renewed until `effectiveExpiry`. */
async function postHistory(grant: Grant, lease: Lease, history: StampEntry[], effectiveExpiry: number) {
  node.state = { cid: grant.delegationCid, effectiveExpiry, history };
  const api = backend();
  try {
    return await api.post(await requestBody(grant, lease, api.nonceStore));
  } finally {
    api.close();
  }
}

/** The node's status body size for `history`, as the backend reads it. */
const statusBytes = (grant: Grant, history: StampEntry[], effectiveExpiry: number) =>
  Buffer.byteLength(JSON.stringify({
    cid: grant.delegationCid, status: "active", exists: true, active: true, revoked: false, expired: false,
    effective_expiry: effectiveExpiry, renewal_history: history,
  }));

let grant: Grant;
let lease: Lease;
beforeAll(async () => {
  grant = await expiredGrant();
  lease = await signLease(grant);
});

/** The SDK call the backend makes, with the node's status the same way. */
function verify(history: StampEntry[], lastEnd: number, leaseCid = lease.cid) {
  return verifyRenewalHistory({
    originalCid: grant.delegationCid,
    leaseCid,
    leaseExpiresAt: lease.expiresAt,
    ancestorEffectiveExpiry: lastEnd,
    nodeIdentity: node.identity,
    history,
    now: nowSeconds(),
  });
}

describe("verifyRenewalHistory on histories as the node returns them", () => {
  test.each([1, 2, 90, 180])("accepts %i stamps that all carry the lease's generation", count => {
    const lastEnd = nowSeconds() + 2 * HOUR;
    const history = chain(grant, lease, count, lastEnd, HOUR);
    expect(new Set(history.map(entry => entry.generation))).toEqual(new Set([1]));
    const verified = verify(history, lastEnd);
    expect(verified.effectiveExpiry).toBe(lastEnd);
    expect(verified.latestStampCid).toBe(history[count - 1]!.cid);
  });

  test("accepts a generation above 1 when every stamp carries it", () => {
    const lastEnd = nowSeconds() + 2 * HOUR;
    expect(verify(chain(grant, lease, 3, lastEnd, HOUR, (_, fields) => ({ ...fields, generation: 7 })), lastEnd).effectiveExpiry).toBe(lastEnd);
  });

  test("accepts a history listed out of order", () => {
    const lastEnd = nowSeconds() + 2 * HOUR;
    expect(verify(chain(grant, lease, 5, lastEnd, HOUR).reverse(), lastEnd).effectiveExpiry).toBe(lastEnd);
  });

  const lastEnd = nowSeconds() + 2 * HOUR;
  // Built when the case runs: the grant and lease exist only after `beforeAll`.
  const mutated = (count: number, change: (index: number, fields: Fields) => Fields) => () => chain(grant, lease, count, lastEnd, HOUR, change);
  test.each([
    ["generation 0", mutated(3, (_, fields) => ({ ...fields, generation: 0 }))],
    ["a generation that falls mid-chain", mutated(4, (index, fields) => ({ ...fields, generation: index < 2 ? 2 : 1 }))],
    ["a stamp for another lease in the middle", mutated(4, (index, fields) => (index === 2 ? { ...fields, leaseCid: rawCid("another-lease") } : fields))],
    ["a broken previous_stamp_cid", mutated(4, (index, fields) => (index === 2 ? { ...fields, previousStampCid: rawCid("not-the-previous-stamp") } : fields))],
    ["an end that does not increase", mutated(4, (index, fields) => (index === 2 ? { ...fields, newEnd: fields.newEnd - HOUR } : fields))],
    ["an end that goes backwards", mutated(4, (index, fields) => (index === 2 ? { ...fields, newEnd: fields.newEnd - 2 * HOUR } : fields))],
  ])("refuses %s", (_label, build) => {
    expect(() => verify(build(), lastEnd)).toThrow(/^Renewal/);
  });

  // TC-4091: pending the SDK rule that pins one generation across the chain; see the endpoint case below.
  test.failing("refuses a generation that rises mid-chain", () => {
    expect(() => verify(mutated(4, (index, fields) => ({ ...fields, generation: index < 2 ? 1 : 2 }))(), lastEnd)).toThrow(/^Renewal/);
  });

  test("refuses an entry whose generation differs from the signed one", () => {
    const history = chain(grant, lease, 3, lastEnd, HOUR);
    history[1] = { ...history[1]!, generation: 2 };
    expect(() => verify(history, lastEnd)).toThrow();
  });

  test("refuses a stamp whose signed lease is not the entry's lease_cid", () => {
    const history = chain(grant, lease, 3, lastEnd, HOUR);
    const foreign = stamp({ originalCid: grant.delegationCid, leaseCid: rawCid("another-lease"), newEnd: history[1]!.new_end, generation: 1, previousStampCid: history[0]!.cid });
    history[1] = { ...foreign, lease_cid: lease.cid };
    expect(() => verify(history, lastEnd)).toThrow("Renewal stamp binding is invalid");
  });

  test("refuses an entry whose signed previous stamp is not the entry's previous_stamp_cid", () => {
    const history = chain(grant, lease, 3, lastEnd, HOUR);
    const wrong = stamp({ originalCid: grant.delegationCid, leaseCid: lease.cid, newEnd: history[1]!.new_end, generation: 1, previousStampCid: rawCid("not-the-previous-stamp") });
    history[1] = { ...wrong, previous_stamp_cid: history[0]!.cid };
    expect(() => verify(history, lastEnd)).toThrow("Renewal stamp binding is invalid");
  });
});

describe("POST /api/auth/verify-renewal with a multi-stamp history from the node", () => {
  test.each([
    [2, HOUR],
    [90, DAY],
    [180, 12 * HOUR],
  ])("a lease renewed %i times gets a bearer capped at the renewed end", async (count, step) => {
    const newEnd = nowSeconds() + 2 * HOUR;
    const history = chain(grant, lease, count, newEnd, step);
    const result = await postHistory(grant, lease, history, newEnd);
    expect(result.status).toBe(200);
    expect(result.body.address).toBe(grant.address.toLowerCase());
    expect(result.body.renewal).toEqual({ effectiveEnd: newEnd });
    expect(Math.abs((result.body.expiresIn as number) - 2 * HOUR)).toBeLessThanOrEqual(2);
    expect(await verifySessionToken(result.body.token as string, SESSION_KEY)).toEqual({ address: grant.address.toLowerCase() });
  });

  test("the history of a lease renewed 90 and 180 times is the size the node really sends", () => {
    const newEnd = nowSeconds() + 2 * HOUR;
    expect(statusBytes(grant, chain(grant, lease, 90, newEnd, DAY), newEnd)).toBeGreaterThan(80_000);
    expect(statusBytes(grant, chain(grant, lease, 180, newEnd, 12 * HOUR), newEnd)).toBeGreaterThan(160_000);
  });

  const refusedHistory = { status: 401, body: { error: "renewal_history_invalid" } };

  test("generation 0 is refused", async () => {
    const newEnd = nowSeconds() + 2 * HOUR;
    expect(await postHistory(grant, lease, chain(grant, lease, 90, newEnd, DAY, (_, fields) => ({ ...fields, generation: 0 })), newEnd)).toEqual(refusedHistory);
  });

  // TC-4091: the intended rule is one equal generation for the whole chain. The pinned sdk-core does not
  // enforce that yet, so this case is expected to fail. When the SDK pins the generation across the chain
  // `test.failing` starts failing: change it to a plain `test` then.
  test.failing("a generation that rises mid-chain is refused", async () => {
    const newEnd = nowSeconds() + 2 * HOUR;
    const history = chain(grant, lease, 90, newEnd, DAY, (index, fields) => ({ ...fields, generation: index < 45 ? 1 : 2 }));
    expect(await postHistory(grant, lease, history, newEnd)).toEqual(refusedHistory);
  });

  test("a generation that falls mid-chain is refused", async () => {
    const newEnd = nowSeconds() + 2 * HOUR;
    const history = chain(grant, lease, 90, newEnd, DAY, (index, fields) => ({ ...fields, generation: index < 45 ? 2 : 1 }));
    expect(await postHistory(grant, lease, history, newEnd)).toEqual(refusedHistory);
  });

  test("a stamp for another lease mid-chain is refused", async () => {
    const newEnd = nowSeconds() + 2 * HOUR;
    const history = chain(grant, lease, 90, newEnd, DAY, (index, fields) => (index === 45 ? { ...fields, leaseCid: rawCid("another-lease") } : fields));
    expect(await postHistory(grant, lease, history, newEnd)).toEqual(refusedHistory);
  });

  test("a broken previous_stamp_cid is refused", async () => {
    const newEnd = nowSeconds() + 2 * HOUR;
    const history = chain(grant, lease, 90, newEnd, DAY, (index, fields) => (index === 45 ? { ...fields, previousStampCid: rawCid("not-the-previous-stamp") } : fields));
    expect(await postHistory(grant, lease, history, newEnd)).toEqual(refusedHistory);
  });

  test("an end that does not increase is refused", async () => {
    const newEnd = nowSeconds() + 2 * HOUR;
    const history = chain(grant, lease, 90, newEnd, DAY, (index, fields) => (index === 45 ? { ...fields, newEnd: fields.newEnd - DAY } : fields));
    expect(await postHistory(grant, lease, history, newEnd)).toEqual(refusedHistory);
  });

  test("a status body over 1 MiB is refused as an unavailable node, and just under it is accepted", async () => {
    const newEnd = nowSeconds() + 2 * HOUR;
    // Stamps are about 960 bytes each; grow the chain until the next stamp would pass the cap.
    let count = Math.floor(MAX_STATUS_BYTES / 960) - 20;
    while (statusBytes(grant, chain(grant, lease, count + 1, newEnd, HOUR), newEnd) <= MAX_STATUS_BYTES) count++;
    const atCap = chain(grant, lease, count, newEnd, HOUR);
    const overCap = chain(grant, lease, count + 1, newEnd, HOUR);
    expect(statusBytes(grant, atCap, newEnd)).toBeLessThanOrEqual(MAX_STATUS_BYTES);
    expect(statusBytes(grant, overCap, newEnd)).toBeGreaterThan(MAX_STATUS_BYTES);
    expect((await postHistory(grant, lease, atCap, newEnd)).status).toBe(200);
    expect(await postHistory(grant, lease, overCap, newEnd)).toEqual({ status: 503, body: { error: "node_unavailable" } });
  }, 60_000);
});
