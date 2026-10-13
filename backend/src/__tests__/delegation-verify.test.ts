import { describe, expect, it, mock } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { DelegationStore, verifySIWE } from "@tinyboilerplate/server";
import { APP_ID } from "@tinyboilerplate/core";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { activateVerifiedDelegation } from "../portable-delegation.js";
import { parseStoredGrant, verifyTranscriptWriterGrant, verificationCacheKey, type GrantResult } from "../delegation-verify.js";
import { makeSignedTranscriptGrant, type SignedTranscriptGrant, type TranscriptAtt } from "./helpers/transcript-grant.js";

function verify(grant: SignedTranscriptGrant, address = grant.address, now?: number) {
  return verifyTranscriptWriterGrant({
    serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature,
    address, backendDid: grant.backendDid, configuredHost: grant.configuredHost, now,
  }, { computeDelegationCid: grant.computeDelegationCid });
}

function assertSuccess(result: GrantResult) {
  if (!result.ok) throw new Error(`Expected a verified grant; got ${result.code}`);
  return result.verified;
}

function bundle(grant: SignedTranscriptGrant): Record<string, unknown> {
  const parsed: unknown = JSON.parse(grant.serialized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Fixture was not one delegation");
  return parsed as Record<string, unknown>;
}

function withBundle(grant: SignedTranscriptGrant, change: (value: Record<string, unknown>) => void): SignedTranscriptGrant {
  const parsed = bundle(grant);
  change(parsed);
  const serialized = JSON.stringify(parsed);
  return { ...grant, serialized, envelope: JSON.stringify({ format: "tinychat.transcript-writer-grant", v: 1, delegation: serialized, siwe: grant.siwe, signature: grant.signature }) };
}

function attFor(spaceId: string): TranscriptAtt {
  return {
    [`${spaceId}/sql/${APP_ID}/connectors`]: { "tinycloud.sql/read": [], "tinycloud.sql/write": [] },
    [`${spaceId}/kv/${APP_ID}/connectors/tinycloud-transcriber/`]: { "tinycloud.kv/get": [], "tinycloud.kv/put": [] },
  };
}

function withAtt(grant: SignedTranscriptGrant, mutate: (att: TranscriptAtt) => void): TranscriptAtt {
  const att = attFor(grant.spaceId);
  mutate(att);
  return att;
}

function assertFailure(result: GrantResult, code: string): void {
  expect(result.ok ? "verified" : result.code).toBe(code);
}

async function expectCode(grant: SignedTranscriptGrant, code: string, address = grant.address, now?: number) {
  assertFailure(await verify(grant, address, now), code);
}

const SQL = `${APP_ID}/connectors`;
const KV = `${APP_ID}/connectors/tinycloud-transcriber/`;

describe("signed transcript grant verifier", () => {
  it("verifies a real session UCAN and projects only signed capabilities, never unsigned bundle fields", async () => {
    const original = await makeSignedTranscriptGrant();
    const grant = withBundle(original, (value) => {
      Object.assign(value, {
        ownerAddress: "0x0000000000000000000000000000000000000000", spaceId: "victim-space",
        resources: [{ service: "kv", path: "everywhere", actions: ["del", "list"] }],
        actions: ["admin"], path: "other/path", chainId: 99, expiry: "2099-01-01",
        delegateDID: "did:pkh:eip155:1:0x0000000000000000000000000000000000000000",
      });
    });
    const verified = assertSuccess(await verify(grant));
    const { authorization, ...safeProjection } = verified;
    expect(authorization === original.authorization).toBe(true);
    expect(safeProjection).toEqual({
      cid: original.cid,
      ownerAddress: original.address.toLowerCase(), chainId: 1,
      spaceId: makePkhSpaceId(original.address, 1, "applications"), sessionDid: original.sessionDid,
      backendDid: original.backendDid, expiresAt: original.expiresAt,
      resources: [
        { service: "sql", space: original.spaceId, path: SQL, actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
        { service: "kv", space: original.spaceId, path: KV, actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
      ],
    });
  });

  it("distinguishes foreign spaces and wrong signed-in users", async () => {
    const a = await makeSignedTranscriptGrant();
    await expectCode(await makeSignedTranscriptGrant({ wallet: "B", att: attFor(a.spaceId) }), "foreign_space_delegation");
    await expectCode(await makeSignedTranscriptGrant({ wallet: "B" }), "wrong_delegator", a.address);
  });

  it("rejects each excess ability, widened path, third resource and nonempty caveat", async () => {
    const base = await makeSignedTranscriptGrant();
    for (const [uri, action] of [
      [`${base.spaceId}/kv/${KV}`, "tinycloud.kv/del"],
      [`${base.spaceId}/kv/${KV}`, "tinycloud.kv/list"],
      [`${base.spaceId}/sql/${SQL}`, "tinycloud.sql/schema"],
      [`${base.spaceId}/sql/${SQL}`, "tinycloud.sql/admin"],
    ]) {
      const grant = await makeSignedTranscriptGrant({ att: withAtt(base, (att) => { att[uri][action] = []; }) });
      await expectCode(grant, "overbroad_delegation");
    }
    const widened = await makeSignedTranscriptGrant({ att: withAtt(base, (att) => {
      att[`${base.spaceId}/kv/${APP_ID}/connectors/`] = att[`${base.spaceId}/kv/${KV}`];
      delete att[`${base.spaceId}/kv/${KV}`];
    }) });
    await expectCode(widened, "overbroad_delegation");
    const third = await makeSignedTranscriptGrant({ att: withAtt(base, (att) => {
      att[`${base.spaceId}/sql/${APP_ID}/threads`] = { "tinycloud.sql/read": [] };
    }) });
    await expectCode(third, "overbroad_delegation");
    const caveated = await makeSignedTranscriptGrant({ att: withAtt(base, (att) => {
      att[`${base.spaceId}/sql/${SQL}`]["tinycloud.sql/write"] = [{ limit: 1 }];
    }) });
    await expectCode(caveated, "overbroad_delegation");
  });

  it("rejects missing SQL write and KV put", async () => {
    const base = await makeSignedTranscriptGrant();
    for (const [uri, action] of [
      [`${base.spaceId}/sql/${SQL}`, "tinycloud.sql/write"],
      [`${base.spaceId}/kv/${KV}`, "tinycloud.kv/put"],
    ]) {
      await expectCode(await makeSignedTranscriptGrant({ att: withAtt(base, (att) => { delete att[uri][action]; }) }), "insufficient_delegation");
    }
    await expectCode(await makeSignedTranscriptGrant({ att: withAtt(base, (att) => {
      delete att[`${base.spaceId}/kv/${KV}`];
    }) }), "insufficient_delegation");
  });

  it("enforces expiry, SIWE lifetime, 30-day ceiling and nbf", async () => {
    const now = Date.now();
    await expectCode(await makeSignedTranscriptGrant({ now, expiresAt: Math.floor((now - 1000) / 1000) }), "expired");
    await expectCode(await makeSignedTranscriptGrant({ now, expiresAt: Math.floor((now + 30 * 86_400_000 + 360_000) / 1000) }), "expiry_too_long");
    await expectCode(await makeSignedTranscriptGrant({ now, expirationTime: new Date(now + 2 * 86_400_000).toISOString() }), "expiry_too_long");
    await expectCode(await makeSignedTranscriptGrant({ now, expirationTime: null }), "session_expired");
    await expectCode(await makeSignedTranscriptGrant({ now, nbf: Math.floor((now + 120_000) / 1000) }), "not_yet_valid");
    const session = await makeSignedTranscriptGrant({ now, expirationTime: new Date(now + 86_400_000).toISOString(), expiresAt: Math.floor((now + 3600_000) / 1000) });
    await expectCode(session, "session_expired", session.address, now + 86_400_001);
    const past = await makeSignedTranscriptGrant({
      now: now - 3 * 86_400_000,
      expirationTime: new Date(now - 86_400_000).toISOString(),
      expiresAt: Math.floor((now + 86_400_000) / 1000),
    });
    await expectCode(past, "session_expired");
    await expect(verifySIWE(past.siwe, past.signature)).rejects.toThrow();
  });

  it("rejects wrong audience, bad UCAN signature, mismatched CID and proof", async () => {
    const original = await makeSignedTranscriptGrant();
    for (const audience of ["did:pkh:eip155:1:0x0000000000000000000000000000000000000001", original.sessionDid]) {
      await expectCode(await makeSignedTranscriptGrant({ audience }), "wrong_delegatee");
    }
    const tampered = withBundle(original, (value) => {
      const header = value.delegationHeader;
      if (!header || typeof header !== "object" || !("Authorization" in header) || typeof header.Authorization !== "string") throw new Error("Fixture has no authorization");
      const parts = header.Authorization.replace(/^Bearer /, "").split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      payload.att[`${original.spaceId}/sql/${SQL}`]["tinycloud.sql/admin"] = [];
      header.Authorization = `Bearer ${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[2]}`;
      value.cid = original.computeDelegationCid(header.Authorization);
    });
    await expectCode(tampered, "bad_signature");
    const another = await makeSignedTranscriptGrant();
    await expectCode(withBundle(original, (value) => { value.cid = another.cid; }), "cid_mismatch");
    await expectCode(await makeSignedTranscriptGrant({ proof: [another.cid] }), "proof_mismatch");
    await expectCode(await makeSignedTranscriptGrant({ sessionUri: "did:key:z6Mkincompatible#other" }), "session_mismatch");
    await expectCode({ ...original, signature: another.signature }, "bad_session_signature");
  });

  it("rejects a CACAO authorization and multi-delegation bundle", async () => {
    const original = await makeSignedTranscriptGrant();
    await expectCode(withBundle(original, (value) => { value.delegationHeader = { Authorization: "Bearer cacao:not-a-jwt" }; }), "unsupported_delegation_format");
    await expectCode(withBundle(original, (value) => { value.format = "tinycloud.delegation-bundle"; value.delegations = [bundle(original)]; }), "unsupported_bundle_shape");
  });

  it("rejects hostile hosts without any outbound call; missing host activates only on configured origin", async () => {
    const original = await makeSignedTranscriptGrant();
    const outbound = mock(() => Promise.reject(new Error("network must not be called")));
    const activated: Record<string, unknown>[] = [];
    const node = {
      activateSessionWithHost: outbound,
      useDelegation: mock(async (dto: Record<string, unknown>) => {
        activated.push(dto);
        return { kv: {}, sql: {} };
      }),
    } as unknown as TinyCloudNode;
    const originalFetch = globalThis.fetch;
    const fetchSpy = mock(async () => new Response(null, { status: 500 }));
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      for (const host of ["http://169.254.169.254/", "http://127.0.0.1:9", "https://evil.example"]) {
        await expectCode(await makeSignedTranscriptGrant({ host }), "untrusted_host");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(outbound).not.toHaveBeenCalled();
      expect(node.useDelegation).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
    const noHost = await makeSignedTranscriptGrant({ host: null, unsigned: { ownerAddress: "victim", spaceId: "victim", actions: ["admin"], path: "victim" } });
    const verified = assertSuccess(await verify(noHost));
    await activateVerifiedDelegation(node, verified, { host: noHost.configuredHost });
    expect(activated).toHaveLength(2);
    for (const [index, dto] of activated.entries()) {
      const resource = verified.resources[index];
      expect(Object.keys(dto).sort()).toEqual(["cid", "delegationHeader", "spaceId", "path", "actions", "resources", "expiry", "delegateDID", "ownerAddress", "chainId", "host"].sort());
      const { delegationHeader, ...safeDto } = dto;
      expect(JSON.stringify(delegationHeader) === JSON.stringify({ Authorization: verified.authorization })).toBe(true);
      expect(safeDto).toEqual({ cid: verified.cid,
        spaceId: verified.spaceId, path: resource.path, actions: resource.actions,
        resources: [resource], expiry: verified.expiresAt, delegateDID: verified.backendDid,
        ownerAddress: verified.ownerAddress, chainId: verified.chainId, host: original.configuredHost });
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it("persists signed envelope through a fresh store and rejects tampered persisted material", async () => {
    const grant = await makeSignedTranscriptGrant();
    const accepted = assertSuccess(await verify(grant));
    const records = new Map<string, unknown>();
    const fakeNode = { kv: {
      put: async (key: string, value: unknown) => { records.set(key, value); return { ok: true }; },
      get: async (key: string) => records.has(key) ? { ok: true, data: { data: records.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } },
      delete: async (key: string) => { records.delete(key); return { ok: true }; },
    } } as unknown as TinyCloudNode;
    const first = new DelegationStore(fakeNode);
    await first.store(grant.address, grant.envelope, { expiresAt: grant.expiresAt.toISOString(), actions: ["read", "write"], path: SQL });
    const restarted = new DelegationStore(fakeNode);
    const stored = await restarted.load(grant.address);
    if (!stored) throw new Error("Expected persisted record");
    const options = { backendDid: grant.backendDid, configuredHost: grant.configuredHost };
    const projection = assertSuccess(await parseStoredGrant(grant.address, stored.serialized, options, { computeDelegationCid: grant.computeDelegationCid }));
    const { authorization: storedAuthorization, ...storedProjection } = projection;
    const { authorization: freshAuthorization, ...freshProjection } = accepted;
    expect(storedAuthorization === freshAuthorization).toBe(true);
    expect(storedProjection).toEqual(freshProjection);
    const b = await makeSignedTranscriptGrant({ wallet: "B" });
    const broken = [
      { envelope: b.envelope, code: "wrong_delegator" },
      { envelope: withBundle(grant, (value) => { value.cid = b.cid; }).envelope, code: "cid_mismatch" },
      { envelope: JSON.stringify({ format: "tinychat.transcript-writer-grant", v: 1, delegation: grant.serialized, siwe: grant.siwe }), code: "unsupported_bundle_shape" },
    ];
    for (const { envelope, code } of broken) {
      await restarted.store(grant.address, envelope, { expiresAt: grant.expiresAt.toISOString(), actions: ["read", "write"], path: SQL });
      const invalid = await restarted.load(grant.address);
      if (!invalid) throw new Error("Expected persisted record");
      assertFailure(await parseStoredGrant(grant.address, invalid.serialized, options, { computeDelegationCid: grant.computeDelegationCid }), code);
      await restarted.remove(grant.address);
      expect(await restarted.load(grant.address)).toBeNull();
    }
  });

  it("binds the entire persisted envelope to the owner with warm and cold cache keys", async () => {
    const a = await makeSignedTranscriptGrant();
    const b = await makeSignedTranscriptGrant({ wallet: "B" });
    const options = { backendDid: a.backendDid, configuredHost: a.configuredHost };
    const deps = { computeDelegationCid: a.computeDelegationCid };
    expect(verificationCacheKey(a.address, a.envelope, a.backendDid, a.configuredHost)).not.toBe(verificationCacheKey(b.address, a.envelope, a.backendDid, a.configuredHost));
    expect(assertSuccess(await parseStoredGrant(a.address, a.envelope, options, deps)).ownerAddress).toBe(a.address.toLowerCase());
    assertFailure(await parseStoredGrant(b.address, a.envelope, options, deps), "wrong_delegator");
    const cold = await makeSignedTranscriptGrant();
    assertFailure(await parseStoredGrant(b.address, cold.envelope, options, deps), "wrong_delegator");
  });

  it("evicts a cached projection whose owner or derived space has been rebound", async () => {
    const a = await makeSignedTranscriptGrant();
    const b = await makeSignedTranscriptGrant({ wallet: "B" });
    const options = { backendDid: a.backendDid, configuredHost: a.configuredHost };
    const deps = { computeDelegationCid: a.computeDelegationCid };
    const first = assertSuccess(await parseStoredGrant(a.address, a.envelope, options, deps));
    first.ownerAddress = b.address.toLowerCase();
    assertFailure(await parseStoredGrant(a.address, a.envelope, options, deps), "wrong_delegator");
    const reverified = assertSuccess(await parseStoredGrant(a.address, a.envelope, options, deps));
    reverified.spaceId = b.spaceId;
    assertFailure(await parseStoredGrant(a.address, a.envelope, options, deps), "wrong_delegator");
    expect(assertSuccess(await parseStoredGrant(a.address, a.envelope, options, deps)).spaceId).toBe(a.spaceId);
  });
});
