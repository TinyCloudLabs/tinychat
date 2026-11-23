import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
import { parseCompactUcanAuthorization, pkhDid } from "@tinycloud/sdk-core";
import { signerFromJwk, signerFromSeed, type OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { standingReadAuthority, standingReadPermissions, verifyStandingReadApproval, type StandingReadHolder } from "../trustbot-reads/standing-grant.js";
import { StandingReadRuntime } from "../trustbot-reads/standing.js";
import type { ReadAccess } from "../trustbot-reads/grants.js";

const wasm = new NodeWasmBindings();
const sdkCorePath = createRequire(import.meta.path).resolve("@tinycloud/sdk-core");
const coreRequire = createRequire(sdkCorePath);
const { blake3 } = await import(coreRequire.resolve("@noble/hashes/blake3"));
const multiformats = join(dirname(sdkCorePath), "../../../multiformats/dist/src");
const { CID } = await import(join(multiformats, "cid.js"));
const { create: createDigest } = await import(join(multiformats, "hashes/digest.js"));

function stampCbor(value: string | number | object): Buffer {
  if (typeof value === "number") return Buffer.from([value]);
  if (typeof value === "string") {
    const body = Buffer.from(value);
    const head = body.length < 24 ? [0x60 + body.length] : [0x78, body.length];
    return Buffer.concat([Buffer.from(head), body]);
  }
  const entries = Object.entries(value).map(([key, entry]) => [stampCbor(key), stampCbor(entry)] as const)
    .sort(([a], [b]) => a.length - b.length || Buffer.compare(a, b));
  return Buffer.concat([Buffer.from([0xa0 + entries.length]), ...entries.flat()]);
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

async function setup(options: { write?: boolean; wrongLease?: boolean } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default"));
  const target = signerFromJwk(jwk);
  const renewerManager = wasm.createSessionManager();
  const renewer = signerFromJwk(JSON.parse(renewerManager.jwk("default")));
  const nodeDid = signerFromSeed(randomBytes(32)).did;
  const config = {
    backendOrigin: "https://tinychat.test",
    nodeOrigin: "http://127.0.0.1:8686",
    nodeDid,
    renewerDid: renewer.did,
  };
  const now = Math.floor(Date.now() / 1000);
  const originalEnd = now + 600;
  const leaseEnd = now + 86_400;
  const spaceId = wasm.makeSpaceId(account.address, 1, "applications");
  const ownerDid = pkhDid(account.address, 1);
  const nodeIdentity = { nodeDid, renewerDid: renewer.did, renewerPublicKey: JSON.parse(renewerManager.jwk("default")).x, renewerEpoch: 1 };
  const setupSession = async (prepared: { siwe: string }) => {
    const signature = await account.signMessage({ message: prepared.siwe });
    return { ...wasm.completeSessionSetup({ ...prepared, signature }), siwe: prepared.siwe, signature };
  };
  const original = await setupSession(wasm.prepareSession({
    abilities: {
      sql: { "xyz.tinycloud.tinychat/connectors": ["tinycloud.sql/read"] },
      kv: { "xyz.tinycloud.tinychat/connectors/": ["tinycloud.kv/get", "tinycloud.kv/list", ...(options.write ? ["tinycloud.kv/put"] : [])] },
    },
    address: account.address, chainId: 1, domain: "openkey.so", issuedAt: iso(now - 1), expirationTime: iso(originalEnd),
    spaceId, jwk,
  }));
  const lease = await setupSession(wasm.prepareSession({
    abilities: {},
    rawAbilities: { [`urn:cid:${options.wrongLease ? "wrong" : original.delegationCid}`]: ["tinycloud.delegation/renew"] },
    address: account.address, chainId: 1, domain: "openkey.so", issuedAt: iso(now), expirationTime: iso(leaseEnd),
    spaceId, delegateUri: renewer.did,
  }));
  const request: OpenKeyApprovalRequestV1 = {
    requestVersion: 1, issuer: target.did, targetDid: target.did, targetPublicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x },
    resultEncryptionPublicJwk: { kty: "OKP", crv: "X25519", x: randomBytes(32).toString("base64url") },
    nodeOrigin: config.nodeOrigin, grantLifetimeSeconds: 900, purpose: "standing", reason: "Read meetings",
    permissions: standingReadPermissions(["meetings"]), renewal: { version: 1, leaseLifetimeSeconds: 86_400 },
  };
  const requestId = "meetings-test-request";
  const bodyCid = "meetings-test-digest";
  const opened = {
    resultVersion: 1, requestId, requestDigest: bodyCid, targetDid: target.did, requesterDid: target.did,
    ownerDid,
    delegationExpiresAt: iso(originalEnd),
    delegation: { ...original, address: account.address, chainId: 1, spaceId, jwk: request.targetPublicJwk, hostActivated: true },
    renewalChoice: "leased",
    renewal: {
      version: 1, approvedAt: iso(now), approvedLeaseLifetimeSeconds: leaseEnd - now,
      receipt: {
        originalCid: original.delegationCid, leaseCid: lease.delegationCid,
        leaseAuthorization: lease.delegationHeader.Authorization.replace(/^Bearer /i, ""),
        leaseExpiresAt: iso(leaseEnd), leaseGeneration: 1, nodeIdentity,
      },
    },
  };
  const input = { opened, requestId, bodyCid, request, address: account.address, areas: ["meetings"] as const, config, now };
  return { input, target, renewer, nodeIdentity, originalEnd, leaseEnd };
}

describe("standing read approval", () => {
  test("binds the exact signed read resources, owner, holder and lease", async () => {
    const { input, target, originalEnd } = await setup();
    expect(await verifyStandingReadApproval(input)).toMatchObject({ holderDid: target.did, originalEnd, areas: ["meetings"] });
    const differentOwner = privateKeyToAccount(generatePrivateKey()).address;
    await expect(verifyStandingReadApproval({ ...input, address: differentOwner })).rejects.toThrow();
    await expect(verifyStandingReadApproval({ ...input, request: { ...input.request, targetDid: signerFromSeed(randomBytes(32)).did } })).rejects.toThrow();
    await expect(verifyStandingReadApproval({ ...input, opened: { ...input.opened, renewalChoice: "finite", renewal: undefined } })).rejects.toThrow();
    await expect(verifyStandingReadApproval({ ...input, bodyCid: "another-request" })).rejects.toThrow();
  });

  test("refuses a write or a lease for a different grant", async () => {
    const withWrite = await setup({ write: true });
    await expect(verifyStandingReadApproval(withWrite.input)).rejects.toThrow();
    const wrongLease = await setup({ wrongLease: true });
    await expect(verifyStandingReadApproval(wrongLease.input)).rejects.toThrow();
  });
});

test("uses pinned node status, drops the key on stop and refuses a different owner on every read", async () => {
  const { input, target, nodeIdentity, originalEnd } = await setup();
  const grant = await verifyStandingReadApproval(input);
  let leaseState: Awaited<ReturnType<StandingReadHolder["leaseState"]>> = "active";
  let nodeEnd = originalEnd - 30;
  const holder: StandingReadHolder = { did: target.did, signStatus: target.sign, leaseState: async () => leaseState };
  const fetchNode = (async (url: string, request?: RequestInit) => {
    if (url.endsWith("/node-keys")) return Response.json(nodeIdentity);
    const status = parseCompactUcanAuthorization(new Headers(request?.headers).get("Authorization")!);
    expect(status.payload.iss.split("#")[0]).toBe(target.did);
    expect(status.payload.aud).toBe(nodeIdentity.nodeDid);
    expect(status.payload.att).toEqual({ [`urn:cid:${grant.originalCid}`]: { "tinycloud.delegation/status": [{}] } });
    return Response.json({ cid: grant.originalCid, exists: true, active: true, effective_expiry: nodeEnd, renewal_history: [] });
  }) as typeof fetch;
  const rows: unknown[] = [];
  const dropped: string[] = [];
  const access = {} as ReadAccess;
  const runtime = new StandingReadRuntime({
    config: input.config,
    now: () => input.now,
    fetch: fetchNode,
    store: {
      current: async () => ({
        grant, holder,
        activate: async (resources, validUntil) => {
          expect(resources).toHaveLength(2);
          expect(validUntil).toBe((originalEnd - 30) * 1000);
          return access;
        },
      }),
      drop: async (_owner, cid) => { dropped.push(cid); },
      audit: async row => { rows.push(row); },
    },
  });
  expect(await runtime.access(input.address, "meetings")).toEqual({ state: "active", access });
  expect(rows).toEqual([{ owner: input.address, area: "meetings", at: input.now * 1000 }]);
  expect(await runtime.access(input.address, "feed_chats")).toEqual({ state: "absent" });

  nodeEnd = originalEnd + 3600;
  expect(await standingReadAuthority(grant, { address: input.address, config: input.config, holder, fetch: fetchNode }))
    .toEqual({ state: "unavailable" });

  nodeEnd = originalEnd;
  leaseState = "stopped";
  expect(await runtime.access(input.address, "meetings")).toEqual({ state: "ended" });
  expect(dropped).toEqual([grant.originalCid]);
  expect(rows).toHaveLength(1);

  leaseState = "active";
  const other = privateKeyToAccount(generatePrivateKey()).address;
  expect(await runtime.access(other, "meetings")).toEqual({ state: "unavailable" });
  expect(rows).toHaveLength(1);
  expect(dropped).toHaveLength(1);
});

test("accepts an extended end only with the pinned node's signed history for this exact lease", async () => {
  const { input, target, renewer, nodeIdentity, originalEnd } = await setup();
  const grant = await verifyStandingReadApproval(input);
  const extended = originalEnd + 600;
  const signed = stampCbor({
    domain: "tinycloud/node/renewal-stamp/v1",
    unsigned: {
      type: "TinyCloudRenewalStamp", version: 1, nodeDid: nodeIdentity.nodeDid, renewerEpoch: 1, leaseGeneration: 1,
      leaseCid: grant.leaseCid, previousStampCid: grant.leaseCid, originalCid: grant.originalCid,
      newEnd: iso(extended).replace(".000Z", "Z"),
    },
  });
  const signature = Buffer.from(await renewer.sign(signed)).toString("base64url");
  const stamp = {
    cid: CID.createV1(0x55, createDigest(0x1e, blake3(signed))).toString(),
    lease_cid: grant.leaseCid, generation: 1, previous_stamp_cid: grant.leaseCid, new_end: extended,
    signed_bytes: signed.toString("base64url"), signature,
  };
  const holder: StandingReadHolder = {
    did: target.did, signStatus: target.sign,
    leaseState: async (_grant, hasRenewedTime) => {
      expect(hasRenewedTime).toBe(true);
      return "active";
    },
  };
  const opts = {
    address: input.address, config: input.config, holder,
    now: () => originalEnd + 1,
    fetch: (async (url: string) => url.endsWith("/node-keys") ? Response.json(nodeIdentity) : Response.json({
      cid: grant.originalCid, exists: true, active: true, effective_expiry: extended, renewal_history: [stamp],
    })) as typeof fetch,
  };
  expect(await standingReadAuthority(grant, opts)).toEqual({ state: "active", validUntil: extended * 1000 });
  stamp.signature = randomBytes(64).toString("base64url");
  expect(await standingReadAuthority(grant, opts)).toEqual({ state: "unavailable" });
});

test("drops a stopped or replaced holder only after node confirms revocation", async () => {
  const { input, target } = await setup();
  const grant = await verifyStandingReadApproval(input);
  const { finishStandingReadStop } = await import("../trustbot-reads/standing.js");
  const dropped: string[] = [];
  let revoked = false;
  const deps = {
    config: input.config,
    now: () => input.now,
    fetch: (async () => Response.json({ cid: grant.originalCid, exists: true, revoked })) as typeof fetch,
    find: async () => ({
      grant, holder: { did: target.did, signStatus: target.sign, leaseState: async () => "active" as const },
      activate: async () => ({} as ReadAccess),
    }),
    drop: async (_owner: string, cid: string) => { dropped.push(cid); },
  };
  await expect(finishStandingReadStop(input.address, grant.originalCid, deps)).rejects.toThrow();
  expect(dropped).toHaveLength(0);
  revoked = true;
  await finishStandingReadStop(input.address, grant.originalCid, deps);
  expect(dropped).toEqual([grant.originalCid]);
});
