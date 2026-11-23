import { expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
import { pkhDid } from "@tinycloud/sdk-core";
import type { RenewalStampHistoryEntry } from "@tinycloud/sdk-core/delegations/renewal";
import { signerFromJwk, signerFromSeed, type OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ReadResource } from "../trustbot-reads/areas.js";
import type { ReadAccess } from "../trustbot-reads/grants.js";
import { standingReadPermissions, verifyStandingReadApproval, type VerifyRenewalChain } from "../trustbot-reads/standing-grant.js";
import { StandingReadRuntime, type StandingReadPolicyRefusal } from "../trustbot-reads/standing.js";

const DAY = 86_400;
const WINDOW = 7 * DAY;
const LEASE = 90 * DAY;
const wasm = new NodeWasmBindings();
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

async function signedApproval(leaseLifetime = LEASE, originalLifetime = 600, leaseBackdate = 0) {
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address;
  const ownerDid = pkhDid(address, 1).toLowerCase();
  const spaceId = wasm.makeSpaceId(address, 1, "applications");
  const holderJwk = JSON.parse(wasm.createSessionManager().jwk("default"));
  const holder = signerFromJwk(holderJwk);
  const renewerJwk = JSON.parse(wasm.createSessionManager().jwk("default"));
  const nodeIdentity = {
    nodeDid: signerFromSeed(randomBytes(32)).did,
    renewerDid: signerFromJwk(renewerJwk).did,
    renewerPublicKey: renewerJwk.x,
    renewerEpoch: 1,
  };
  const config = {
    backendOrigin: "https://tinychat.test",
    nodeOrigin: "http://127.0.0.1:8686",
    nodeDid: nodeIdentity.nodeDid,
    renewerDid: nodeIdentity.renewerDid,
  };
  const now = Math.floor(Date.now() / 1000);
  const originalEnd = now + originalLifetime;
  const leaseEnd = now + leaseLifetime;
  const sign = async (prepared: ReturnType<typeof wasm.prepareSession>) => {
    const signature = await account.signMessage({ message: prepared.siwe });
    return { ...wasm.completeSessionSetup({ ...prepared, signature }), siwe: prepared.siwe, signature };
  };
  const original = await sign(wasm.prepareSession({
    abilities: {
      sql: { "xyz.tinycloud.tinychat/connectors": ["tinycloud.sql/read"] },
      kv: { "xyz.tinycloud.tinychat/connectors/": ["tinycloud.kv/get", "tinycloud.kv/list"] },
    },
    address, chainId: 1, domain: "openkey.so", issuedAt: iso(now), expirationTime: iso(originalEnd), spaceId, jwk: holderJwk,
  }));
  const lease = await sign(wasm.prepareSession({
    abilities: {},
    rawAbilities: { [`urn:cid:${original.delegationCid}`]: ["tinycloud.delegation/renew"] },
    address, chainId: 1, domain: "openkey.so", issuedAt: iso(now - leaseBackdate), expirationTime: iso(leaseEnd),
    spaceId, delegateUri: config.renewerDid,
  }));
  const request: OpenKeyApprovalRequestV1 = {
    requestVersion: 1, issuer: holder.did, targetDid: holder.did,
    targetPublicJwk: { kty: "OKP", crv: "Ed25519", x: holderJwk.x },
    resultEncryptionPublicJwk: { kty: "OKP", crv: "X25519", x: randomBytes(32).toString("base64url") },
    nodeOrigin: config.nodeOrigin, grantLifetimeSeconds: WINDOW, purpose: "standing", reason: "Read meetings",
    permissions: standingReadPermissions(["meetings"]), renewal: { version: 1, leaseLifetimeSeconds: leaseLifetime },
  };
  const requestId = "standing-policy-test";
  const bodyCid = "standing-policy-digest";
  const opened = {
    resultVersion: 1, requestId, requestDigest: bodyCid, requesterDid: holder.did, targetDid: holder.did, ownerDid,
    delegationExpiresAt: iso(originalEnd),
    delegation: { ...original, address, chainId: 1, spaceId, jwk: request.targetPublicJwk, hostActivated: true },
    renewalChoice: "leased",
    renewal: {
      version: 1, approvedAt: iso(now), approvedLeaseLifetimeSeconds: leaseLifetime,
      receipt: {
        originalCid: original.delegationCid, leaseCid: lease.delegationCid, nodeIdentity,
        leaseAuthorization: lease.delegationHeader.Authorization.replace(/^Bearer /i, ""),
        leaseExpiresAt: iso(leaseEnd), leaseGeneration: 1,
      },
    },
  };
  const input = { opened, requestId, bodyCid, request, address, areas: ["meetings"] as const, config, now };
  return { input, holder, nodeIdentity, ownerDid, leaseEnd, originalEnd };
}

// Models the node's lease generation and chain order. The pinned SDK handles signature checks in runtime.
const verifyChain: VerifyRenewalChain = ({ leaseCid, history, leaseExpiresAt }) => {
  let previousStampCid = leaseCid;
  let generation = 1;
  let end = 0;
  for (const stamp of history.filter(stamp => stamp.lease_cid === leaseCid)) {
    if (stamp.generation < generation || stamp.previous_stamp_cid !== previousStampCid ||
      stamp.new_end <= end || stamp.new_end > leaseExpiresAt) throw new Error("invalid chain");
    previousStampCid = stamp.cid;
    generation = stamp.generation;
    end = stamp.new_end;
  }
  if (!end) throw new Error("missing chain for approved lease");
  return { effectiveExpiry: end, latestStampCid: previousStampCid };
};

async function readFixture() {
  const { input, holder, nodeIdentity } = await signedApproval();
  const grant = await verifyStandingReadApproval(input);
  const clock = { now: input.now };
  const status = {
    cid: grant.originalCid, exists: true, active: true, effective_expiry: grant.originalEnd,
    renewal_history: [] as RenewalStampHistoryEntry[],
  };
  const fetchNode = mock(async (url: string, request?: RequestInit) => {
    if (url.endsWith("/node-keys")) return Response.json(nodeIdentity);
    expect(JSON.parse(String(request?.body))).toEqual({ cid: grant.originalCid });
    return Response.json(status);
  });
  const access = {} as ReadAccess;
  const activate = mock(async (_resources: readonly ReadResource[], _end: number) => access);
  const drop = mock(async (_owner: string, _cid: string) => {});
  const outcome = mock((_outcome: StandingReadPolicyRefusal) => {});
  const verifyRenewalChain = mock(verifyChain);
  const runtime = new StandingReadRuntime({
    config: input.config, now: () => clock.now, fetch: fetchNode as unknown as typeof fetch, verifyRenewalChain,
    store: {
      current: async () => ({ grant, holder: { did: holder.did, signStatus: holder.sign, leaseState: async () => "active" }, activate }),
      drop,
      audit: async () => {},
    },
  });
  const stamp = (cid: string, previous: string, end: number, generation = 2) => ({
    cid, previous_stamp_cid: previous, lease_cid: grant.leaseCid, new_end: end, generation, signed_bytes: "", signature: "",
  });
  const read = (owner = input.address, area: "meetings" | "feed_chats" = "meetings") => runtime.access(owner, area, undefined, outcome);
  return { grant, status, clock, read, activate, fetchNode, drop, outcome, stamp, access, verifyRenewalChain };
}

test("accepts an original grant of seven days with an owner lease of 90 days", async () => {
  const { input, ownerDid, leaseEnd, originalEnd } = await signedApproval(LEASE, WINDOW);
  const grant = await verifyStandingReadApproval(input);
  expect(grant).toMatchObject({ ownerDid, leaseEnd, originalEnd });
  expect(grant).not.toHaveProperty("authorization");
  expect(grant).not.toHaveProperty("leaseAuthorization");
});

test.each([
  ["an original grant over seven days", LEASE, WINDOW + 1, 0],
  ["an approved lease over 90 days", LEASE + 1, 600, 0],
  ["a signed lease covering more than the approved 90 days", LEASE, 600, 1],
] as const)("refuses %s", async (_label, lease, original, backdate) => {
  const { input } = await signedApproval(lease, original, backdate);
  await expect(verifyStandingReadApproval(input)).rejects.toThrow("standing_read_approval_invalid");
});

test("refuses reads after the original expires without a signed extension", async () => {
  const f = await readFixture();
  expect(await f.read()).toEqual({ state: "active", access: f.access });
  f.clock.now = f.grant.originalEnd + 1;
  expect(await f.read()).toEqual({ state: "ended" });
  expect(f.outcome).toHaveBeenCalledWith("expired");
  expect(f.activate).toHaveBeenCalledTimes(1);
});

test("refuses reads after the 90 day lease expires before contacting the node", async () => {
  const f = await readFixture();
  f.clock.now = f.grant.leaseEnd + 1;
  expect(await f.read()).toEqual({ state: "ended" });
  expect(f.outcome).toHaveBeenCalledWith("expired");
  expect(f.fetchNode).not.toHaveBeenCalled();
  expect(f.activate).not.toHaveBeenCalled();
});

test("refuses another owner and an unapproved area before contacting the node", async () => {
  const f = await readFixture();
  const anotherOwner = privateKeyToAccount(generatePrivateKey()).address;
  expect(await f.read(anotherOwner)).toEqual({ state: "unavailable" });
  expect(await f.read(undefined, "feed_chats")).toEqual({ state: "absent" });
  expect(f.outcome.mock.calls).toEqual([["not_owner"], ["no_grant"]]);
  expect(f.fetchNode).not.toHaveBeenCalled();
  expect(f.activate).not.toHaveBeenCalled();
});

test("caps read authority at seven days and refuses a raw node end beyond the slack", async () => {
  const f = await readFixture();
  f.status.effective_expiry = f.clock.now + WINDOW + 60;
  f.status.renewal_history = [f.stamp("first", f.grant.leaseCid, f.status.effective_expiry)];
  expect(await f.read()).toEqual({ state: "active", access: f.access });
  expect(f.activate.mock.calls[0]?.[1]).toBe((f.clock.now + WINDOW) * 1000);

  f.status.effective_expiry++;
  expect(await f.read()).toEqual({ state: "ended" });
  expect(f.drop).toHaveBeenCalled();
  expect(f.verifyRenewalChain).toHaveBeenCalledTimes(1);
  expect(f.activate).toHaveBeenCalledTimes(1);
});

test("accepts two stamps with the same generation after the original end and uses a shorter node end", async () => {
  const f = await readFixture();
  f.clock.now = f.grant.originalEnd + 1;
  const firstEnd = f.grant.originalEnd + 120;
  f.status.effective_expiry = firstEnd + 30;
  f.status.renewal_history = [f.stamp("first", f.grant.leaseCid, firstEnd), f.stamp("second", "first", firstEnd + 60)];
  expect(await f.read()).toEqual({ state: "active", access: f.access });
  expect(f.verifyRenewalChain).toHaveBeenCalledWith(expect.objectContaining({
    originalCid: f.grant.originalCid, leaseCid: f.grant.leaseCid, leaseExpiresAt: f.grant.leaseEnd,
  }));
  expect(f.activate.mock.calls[0]?.[1]).toBe(f.status.effective_expiry * 1000);
});

test.each([
  ["decreasing generation", { generation: 1 }],
  ["wrong predecessor", { previous_stamp_cid: "other" }],
  ["repeated end", { new_end: 0 }],
] as const)("refuses a second stamp with %s", async (_label, override) => {
  const f = await readFixture();
  f.clock.now = f.grant.originalEnd + 1;
  const firstEnd = f.grant.originalEnd + 120;
  const laterEnd = firstEnd + 60;
  f.status.effective_expiry = laterEnd;
  const second = { ...f.stamp("second", "first", laterEnd), ...override };
  if ("new_end" in override) second.new_end = firstEnd;
  f.status.renewal_history = [f.stamp("first", f.grant.leaseCid, firstEnd), second];
  expect(await f.read()).toEqual({ state: "unavailable" });
  expect(f.activate).not.toHaveBeenCalled();
});

test("refuses extension history for a different lease", async () => {
  const f = await readFixture();
  f.clock.now = f.grant.originalEnd + 1;
  f.status.effective_expiry = f.grant.originalEnd + 120;
  f.status.renewal_history = [{ ...f.stamp("other-stamp", "other-lease", f.status.effective_expiry), lease_cid: "other-lease" }];
  expect(await f.read()).toEqual({ state: "unavailable" });
  expect(f.activate).not.toHaveBeenCalled();
});
