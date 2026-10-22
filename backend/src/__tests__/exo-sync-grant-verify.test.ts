import { describe, expect, it } from "bun:test";
import { APP_ID } from "@tinyboilerplate/core";
import {
  parseStoredGrant,
  verifyTranscriptWriterGrant,
  type GrantPolicy,
  type GrantResult,
} from "../delegation-verify.js";
import { makeSignedTranscriptGrant, type SignedTranscriptGrant, type TranscriptAtt } from "./helpers/transcript-grant.js";

const REQUESTS = `${APP_ID}/exo/v1/requests/`;
const JOBS = `${APP_ID}/exo/v1/jobs/`;
const SQL = `${APP_ID}/connectors`;
const CONNECTOR_KV = `${APP_ID}/connectors/tinycloud-transcriber/`;

function exoAtt(spaceId: string): TranscriptAtt {
  return {
    [`${spaceId}/kv/${REQUESTS}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/list": [{}], "tinycloud.kv/del": [{}] },
    [`${spaceId}/kv/${JOBS}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}], "tinycloud.kv/del": [{}] },
  };
}

function connectorAtt(spaceId: string): TranscriptAtt {
  return {
    [`${spaceId}/sql/${SQL}`]: { "tinycloud.sql/read": [{}], "tinycloud.sql/write": [{}] },
    [`${spaceId}/kv/${CONNECTOR_KV}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] },
  };
}

function verifyWith(grant: SignedTranscriptGrant, policy: GrantPolicy, now?: number): Promise<GrantResult> {
  return verifyTranscriptWriterGrant({
    serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature,
    address: grant.address, backendDid: grant.backendDid, configuredHost: grant.configuredHost, now, policy,
  }, { computeDelegationCid: grant.computeDelegationCid });
}

function exoEnvelope(grant: SignedTranscriptGrant): string {
  return JSON.stringify({ format: "tinychat.exo-sync-grant", v: 1, delegation: grant.serialized, siwe: grant.siwe, signature: grant.signature });
}

function expectCode(result: GrantResult, code: string): void {
  expect(result.ok ? "verified" : result.code).toBe(code);
}

describe("exo sync grant verifier policy", () => {
  it("accepts the exact exo grant and projects exactly the two KV prefixes with their abilities", async () => {
    const base = await makeSignedTranscriptGrant();
    const grant = await makeSignedTranscriptGrant({ att: exoAtt(base.spaceId) });
    const result = await verifyWith(grant, "exo-sync");
    if (!result.ok) throw new Error(`Expected exact exo grant to verify; got ${result.code}`);
    expect(result.verified.resources).toEqual([
      { service: "kv", space: grant.spaceId, path: REQUESTS, actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/del"] },
      { service: "kv", space: grant.spaceId, path: JOBS, actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"] },
    ]);
  });

  it("rejects an exo grant whose prefix is widened to the whole app namespace", async () => {
    const base = await makeSignedTranscriptGrant();
    const att = exoAtt(base.spaceId);
    att[`${base.spaceId}/kv/${APP_ID}/`] = att[`${base.spaceId}/kv/${REQUESTS}`];
    delete att[`${base.spaceId}/kv/${REQUESTS}`];
    expectCode(await verifyWith(await makeSignedTranscriptGrant({ att }), "exo-sync"), "overbroad_delegation");
  });

  it("rejects an exo grant that adds an ability beyond the requests set", async () => {
    const base = await makeSignedTranscriptGrant();
    const att = exoAtt(base.spaceId);
    att[`${base.spaceId}/kv/${REQUESTS}`]["tinycloud.kv/put"] = [{}];
    expectCode(await verifyWith(await makeSignedTranscriptGrant({ att }), "exo-sync"), "overbroad_delegation");
  });

  it("rejects an exo grant missing a required ability", async () => {
    const base = await makeSignedTranscriptGrant();
    const att = exoAtt(base.spaceId);
    delete att[`${base.spaceId}/kv/${JOBS}`]["tinycloud.kv/del"];
    expectCode(await verifyWith(await makeSignedTranscriptGrant({ att }), "exo-sync"), "insufficient_delegation");
  });

  it("rejects an exo grant that adds an SQL resource", async () => {
    const base = await makeSignedTranscriptGrant();
    const att = exoAtt(base.spaceId);
    att[`${base.spaceId}/sql/${SQL}`] = { "tinycloud.sql/read": [{}] };
    expectCode(await verifyWith(await makeSignedTranscriptGrant({ att }), "exo-sync"), "overbroad_delegation");
  });

  it("rejects an exo grant on a path inside the space that is not one of the two prefixes", async () => {
    const base = await makeSignedTranscriptGrant();
    const att = exoAtt(base.spaceId);
    att[`${base.spaceId}/kv/${APP_ID}/exo/v1/`] = { "tinycloud.kv/get": [{}], "tinycloud.kv/list": [{}], "tinycloud.kv/del": [{}] };
    expectCode(await verifyWith(await makeSignedTranscriptGrant({ att }), "exo-sync"), "overbroad_delegation");
  });

  it("rejects an exo grant whose resource is in another user's space", async () => {
    const other = await makeSignedTranscriptGrant({ wallet: "B" });
    const grant = await makeSignedTranscriptGrant({ att: exoAtt(other.spaceId) });
    expectCode(await verifyWith(grant, "exo-sync"), "foreign_space_delegation");
  });

  it("rejects a connector grant presented to the exo policy", async () => {
    const base = await makeSignedTranscriptGrant();
    const grant = await makeSignedTranscriptGrant({ att: connectorAtt(base.spaceId) });
    expectCode(await verifyWith(grant, "exo-sync"), "overbroad_delegation");
  });

  it("rejects an exo grant presented to the connector policy", async () => {
    const base = await makeSignedTranscriptGrant();
    const grant = await makeSignedTranscriptGrant({ att: exoAtt(base.spaceId) });
    expectCode(await verifyWith(grant, "transcript-writer"), "overbroad_delegation");
  });

  it("rejects a grant that mixes connector and exo resources under either policy", async () => {
    const base = await makeSignedTranscriptGrant();
    const att = { ...connectorAtt(base.spaceId), ...exoAtt(base.spaceId) };
    const grant = await makeSignedTranscriptGrant({ att });
    expectCode(await verifyWith(grant, "exo-sync"), "overbroad_delegation");
    expectCode(await verifyWith(grant, "transcript-writer"), "overbroad_delegation");
  });
  it("rejects an expired exo grant", async () => {
    const base = await makeSignedTranscriptGrant();
    const now = Date.now();
    const grant = await makeSignedTranscriptGrant({ now, att: exoAtt(base.spaceId), expiresAt: Math.floor(now / 1000) + 3600 });
    expectCode(await verifyWith(grant, "exo-sync", now + 2 * 3600_000), "expired");
  });

  it("parses a stored exo envelope only under the exo policy", async () => {
    const base = await makeSignedTranscriptGrant();
    const grant = await makeSignedTranscriptGrant({ att: exoAtt(base.spaceId) });
    const deps = { computeDelegationCid: grant.computeDelegationCid };
    const options = { backendDid: grant.backendDid, configuredHost: grant.configuredHost };
    const accepted = await parseStoredGrant(grant.address, exoEnvelope(grant), { ...options, policy: "exo-sync" }, deps);
    expect(accepted.ok).toBe(true);
    expectCode(await parseStoredGrant(grant.address, exoEnvelope(grant), options, deps), "unsupported_bundle_shape");
  });

  it("does not parse a stored connector envelope under the exo policy", async () => {
    const grant = await makeSignedTranscriptGrant();
    const deps = { computeDelegationCid: grant.computeDelegationCid };
    const options = { backendDid: grant.backendDid, configuredHost: grant.configuredHost };
    expectCode(await parseStoredGrant(grant.address, grant.envelope, { ...options, policy: "exo-sync" }, deps), "unsupported_bundle_shape");
  });
});
