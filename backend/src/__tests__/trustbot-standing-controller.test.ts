import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseCompactUcanAuthorization, verifyDidKeyEd25519Signature } from "@tinycloud/sdk-core";
import { signerFromSeed } from "@tinycloud/share-envelope/links";
import { READ_AREAS } from "../trustbot-reads/areas.js";
import { standingDelegatedAccess } from "../trustbot-reads/standing-access.js";
import { StandingApprovalClient, type StandingApprovalLink } from "../trustbot-reads/standing-approval.js";
import { StandingReadsController, type StandingMetadataStore, type StandingReadMetadata } from "../trustbot-reads/standing-controller.js";
import { DstackStandingHolderDeriver } from "../trustbot-reads/standing-holder.js";

const address = `0x${"a".repeat(40)}`;
const owner = `did:pkh:eip155:1:${address}`;
const scope = { owner, approvalId: "standing-approval-test-one", generation: 1 };
const signerKeys = () => new DstackStandingHolderDeriver({ getKey: async () => Buffer.alloc(32, 92) });
const renewalNode = signerFromSeed(Buffer.alloc(32, 97));
const renewer = signerFromSeed(Buffer.alloc(32, 99));
const config = { nodeOrigin: "https://node.example.test", backendOrigin: "https://backend.example.test", nodeDid: renewalNode.did, renewerDid: renewer.did };
const now = 1_800_000_000_000;
const originalCid = "bafkr4iagntqinkchbdimac2dd5q7c7djbiwibxcciphkd33wo25sp2cdjm";
const leaseEnd = now / 1000 + 86_400;
const spaceId = `tinycloud:pkh:eip155:1:${address}:applications`;
const link: StandingApprovalLink = {
  requestId: "abcdefghijklmnopqrstuvwxyz", bodyCid: "body-cid-for-test", expiresAt: new Date(now + 60_000).toISOString(),
  record: { header: {} as StandingApprovalLink["record"]["header"], signature: {} as StandingApprovalLink["record"]["signature"] },
};

describe("standing read integration", () => {
  test("binds OpenKey lease status proof to the authenticated original CID", async () => {
    const keys = signerKeys();
    const holder = await keys.derive(owner, scope.approvalId, scope.generation);
    const origins = { links: "https://links.example.test", api: "https://api.example.test", web: "https://openkey.example.test" };
    let grant = originalCid;
    const client = new StandingApprovalClient({ keys, origins, now: () => now, fetch: (async (url: string, input: RequestInit) => {
      const expected = `${origins.api}/api/approval-requests/${link.requestId}/lease-status`;
      expect(url).toBe(expected);
      expect(JSON.parse(input.body as string)).toEqual({ bodyCid: link.bodyCid, originalCid });
      const proof = new Headers(input.headers).get("OpenKey-Session-Proof")!;
      const [encodedHeader, encodedPayload, signature] = proof.split(".");
      const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString());
      expect(payload).toMatchObject({ client_id: "openkey-approval-result-v1", htm: "POST", htu: expected, iat: now / 1000 });
      expect(payload.cred_hash).toEqual(createHash("sha256")
        .update(JSON.stringify(["lease-status", link.requestId, link.bodyCid, originalCid, ""])).digest("base64url"));
      expect(verifyDidKeyEd25519Signature(holder.did, Buffer.from(`${encodedHeader}.${encodedPayload}`), Buffer.from(signature!, "base64url"))).toBe(true);
      return Response.json({ leaseState: "active", originalCid: grant, leaseExpiresAt: new Date(leaseEnd * 1000).toISOString() });
    }) as typeof fetch });
    expect(await client.leaseState(holder, link, originalCid, leaseEnd)).toBe("active");
    grant = "bafanother";
    expect(await client.leaseState(holder, link, originalCid, leaseEnd)).toBe("unavailable");
  });

  test("only signs canonical reads under the selected resources and the original proof", async () => {
    const holder = await signerKeys().derive(owner, scope.approvalId, scope.generation);
    const grant = { ownerDid: owner, holderDid: holder.did, originalCid, originalEnd: now / 1000 + 60,
      leaseCid: "test-lease-cid", leaseEnd, spaceId, areas: ["meetings"] as const };
    let current = true;
    let calls = 0;
    const access = standingDelegatedAccess({
      config, grant, holder, now: () => now, resources: READ_AREAS.meetings, validUntil: now + 2_000,
      assertCurrent: async () => { if (!current) throw new Error("standing_reads_changed"); },
      fetch: (async (url: string, init: RequestInit) => {
        calls++;
        expect(url).toBe(`${config.nodeOrigin}/invoke`);
        const headers = new Headers(init.headers);
        expect(headers.has("x-tinychat-standing-invoke")).toBe(false);
        const { payload } = parseCompactUcanAuthorization(headers.get("authorization")!);
        expect(payload.aud).toBe(config.nodeDid);
        expect(payload.prf).toEqual([originalCid]);
        expect(payload.att).toEqual({ [`${spaceId}/sql/xyz.tinycloud.tinychat/connectors`]: { "tinycloud.sql/read": [{}] } });
        expect(payload.exp).toBe(now / 1000 + 2);
        return Response.json({ rows: [["local result"]], columns: ["name"] });
      }) as typeof fetch,
    });
    const read = () => access.sql.db("xyz.tinycloud.tinychat/connectors").query("SELECT name FROM meetings");
    expect(await read()).toMatchObject({ ok: true, data: { rows: [["local result"]] } });
    expect(await access.sql.db("xyz.tinycloud.tinychat/threads").query("SELECT body FROM messages")).toMatchObject({ ok: false });
    current = false;
    expect(await read()).toMatchObject({ ok: false });
    expect(calls).toBe(1);
  });

  test("requires exact node revocation then advances generation and removes the approval", async () => {
    const keys = signerKeys();
    const holder = await keys.derive(owner, scope.approvalId, scope.generation);
    const grant = { ownerDid: owner, holderDid: holder.did, originalCid, originalEnd: now / 1000 + 60,
      leaseCid: "test-lease-cid", leaseEnd, spaceId, areas: ["meetings"] as const };
    let state: StandingReadMetadata = { generation: 1, active: { scope, link, grant } };
    let revision = 1;
    let revoked = false;
    const store: StandingMetadataStore = {
      read: async () => ({ state, version: String(revision) }),
      write: async (_owner, next, version) => {
        if (version !== String(revision)) return false;
        state = next;
        revision++;
        return true;
      },
      async *owners() { yield owner; },
    };
    const controller = new StandingReadsController({
      config, keys, store, now: () => now, enabledAreas: async () => ["meetings"],
      fetch: (async (_url: string, init: RequestInit) => {
        const { payload } = parseCompactUcanAuthorization(new Headers(init.headers).get("Authorization")!);
        expect(payload.iss.split("#")[0]).toBe(holder.did);
        expect(JSON.parse(init.body as string)).toEqual({ cid: originalCid });
        return Response.json({ cid: originalCid, exists: true, revoked });
      }) as typeof fetch,
    });
    await expect(controller.beforeAreaOff(address, "meetings")).rejects.toThrow("standing_read_revoke_required");
    await expect(controller.finishStop(address, originalCid)).rejects.toThrow("standing_read_stop_not_confirmed");
    expect(state.generation).toBe(1);
    revoked = true;
    await controller.finishStop(address, originalCid);
    expect(state).toMatchObject({ generation: 2, active: undefined });
    expect(await controller.current(address)).toBeUndefined();
    await controller.beforeAreaOff(address, "meetings");
  });
});
