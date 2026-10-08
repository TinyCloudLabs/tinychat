import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { describe, expect, it } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { StoredDelegation } from "@tinyboilerplate/core";
import type { DelegationMetadata } from "@tinyboilerplate/server";
import { APP_ID } from "@tinyboilerplate/core";
import { backendDelegationPolicyHash } from "../manifest.js";
import { createDelegationRouter } from "../routes/delegations.js";
import { makeSignedTranscriptGrant, type SignedTranscriptGrant, type TranscriptAtt } from "./helpers/transcript-grant.js";

type DelegationDto = Parameters<TinyCloudNode["useDelegation"]>[0];
type GrantBody = Pick<SignedTranscriptGrant, "serialized" | "siwe" | "signature">;
const HOUR = 3_600_000;
const fingerprint = (value: string | undefined) => value === undefined ? null : createHash("sha256").update(value).digest("hex");

async function withServer<T>(app: express.Express, run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0);
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    const closing = once(server, "close");
    server.close();
    await closing;
  }
}

function post(base: string, body: Partial<GrantBody>) {
  const { serialized, siwe, signature } = body;
  return fetch(`${base}/api/delegations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ serialized, siwe, signature }),
  });
}

function appFor(grant: SignedTranscriptGrant, options: {
  address?: string;
  eligible?: boolean;
  eligibility?: (address: string) => boolean;
  schemaMissing?: boolean;
  onActivation?: (dto: DelegationDto) => Promise<void>;
  onCid?: (count: number) => void;
  onStore?: () => Promise<void>;
  onLoad?: () => Promise<void>;
  onRemove?: () => Promise<void>;
  onGrantChanged?: (address: string, previousEnvelope?: string) => void;
} = {}) {
  const calls = { cid: 0, activate: [] as DelegationDto[], store: 0 };
  const access = { sql: { db: () => ({}) }, kv: { get: async () => ({ ok: true }) } };
  const records = new Map<string, StoredDelegation>();
  const node = {
    computeDelegationCid: (authorization: string) => {
      calls.cid++;
      options.onCid?.(calls.cid);
      return grant.computeDelegationCid(authorization);
    },
    useDelegation: async (dto: DelegationDto) => {
      calls.activate.push(dto);
      await options.onActivation?.(dto);
      return { ...access, kv: { ...access.kv } };
    },
  } as unknown as TinyCloudNode;
  const store = {
    store: async (address: string, serialized: string, metadata: DelegationMetadata) => {
      calls.store++;
      await options.onStore?.();
      records.set(address.toLowerCase(), { serialized, grantedAt: new Date().toISOString(), ...metadata });
    },
    load: async (address: string) => { await options.onLoad?.(); return records.get(address.toLowerCase()) ?? null; },
    remove: async (address: string) => { await options.onRemove?.(); records.delete(address.toLowerCase()); },
  };
  const app = express();
  app.use("/api/delegations", createDelegationRouter({
    backendDid: grant.backendDid, configuredHost: grant.configuredHost,
    eligibility: (address) => options.eligibility?.(address) ?? options.eligible ?? true,
    schemaMissing: () => options.schemaMissing ?? false,
    node, store,
    authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
      req.user = { address: options.address ?? grant.address };
      next();
    },
    onGrantChanged: options.onGrantChanged,
  }));
  return { app, store, calls, records };
}

function att(spaceId: string): TranscriptAtt {
  return {
    [`${spaceId}/sql/${APP_ID}/connectors`]: { "tinycloud.sql/read": [{}], "tinycloud.sql/write": [{}] },
    [`${spaceId}/kv/${APP_ID}/connectors/tinycloud-transcriber/`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] },
  };
}

// Edits to the known locally generated portable form deliberately leave SIWE unchanged.
function editBundle(grant: SignedTranscriptGrant, change: (bundle: Record<string, unknown>) => void): GrantBody {
  const bundle = JSON.parse(grant.serialized) as Record<string, unknown>;
  change(bundle);
  return { serialized: JSON.stringify(bundle), siwe: grant.siwe, signature: grant.signature };
}

function withAuthorization(grant: SignedTranscriptGrant, authorization: string): GrantBody {
  return editBundle(grant, (bundle) => {
    bundle.delegationHeader = { Authorization: authorization };
    bundle.cid = grant.computeDelegationCid(authorization);
  });
}

describe("signed transcript-writer delegation acceptance", () => {
  it("accepts a real signed grant, stores the bound envelope and activates only derived space/resources on the configured host", async () => {
    const grant = await makeSignedTranscriptGrant({ unsigned: {
      ownerAddress: "0x0000000000000000000000000000000000000001",
      spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications",
      host: "http://127.0.0.1:9",
      path: "secrets/", actions: ["tinycloud.kv/del"],
    }, host: null });
    const fixture = appFor(grant);
    await withServer(fixture.app, async (base) => {
      const response = await post(base, grant);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "active", verified: true, delivery: "enabled", expiresAt: grant.expiresAt.toISOString(),
      });
    });
    expect(fixture.calls.activate).toHaveLength(2);
    expect(fixture.calls.store).toBe(1);
    const stored = await fixture.store.load(grant.address);
    expect(stored?.policyHash).toBe(backendDelegationPolicyHash(grant.backendDid));
    expect(stored?.delegateDid).toBe(grant.backendDid);
    expect(stored?.resources).toEqual([
      { service: "sql", space: grant.spaceId, path: `${APP_ID}/connectors`, actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
      { service: "kv", space: grant.spaceId, path: `${APP_ID}/connectors/tinycloud-transcriber/`, actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
    ]);
    expect(fingerprint(stored?.serialized)).toBe(fingerprint(grant.envelope));
    for (const dto of fixture.calls.activate) {
      expect(dto.spaceId).toBe(grant.spaceId);
      expect(dto.ownerAddress).toBe(grant.address.toLowerCase());
      expect(dto.host).toBe(grant.configuredHost);
      expect(dto.resources?.[0]?.space).toBe(grant.spaceId);
      expect(dto.path).toBe(dto.resources?.[0]?.path);
    }
  });

  it("maps every verifier failure to 400 without activating, caching or storing", async () => {
    const now = Date.now();
    const base = await makeSignedTranscriptGrant({ now });
    const alternative = await makeSignedTranscriptGrant({ wallet: "B", now });
    const sql = `${base.spaceId}/sql/${APP_ID}/connectors`;
    const kv = `${base.spaceId}/kv/${APP_ID}/connectors/tinycloud-transcriber/`;
    const bundle: unknown = JSON.parse(base.serialized);
    if (!bundle || typeof bundle !== "object" || !("delegationHeader" in bundle)) throw new Error("fixture lacks delegation header");
    const header = bundle.delegationHeader;
    if (!header || typeof header !== "object" || !("Authorization" in header) || typeof header.Authorization !== "string") throw new Error("fixture lacks authorization");
    const token = header.Authorization;
    const cases: Array<{ code: string; grant?: SignedTranscriptGrant; body?: GrantBody; address?: string }> = [
      { code: "unsupported_bundle_shape", body: { ...base, serialized: JSON.stringify({ format: "tinycloud.delegation-bundle", version: 1, delegations: [base.serialized] }) } },
      { code: "untrusted_host", grant: await makeSignedTranscriptGrant({ now, host: "http://169.254.169.254/" }) },
      { code: "unsupported_delegation_format", body: editBundle(base, (bundle) => { bundle.delegationHeader = { Authorization: "Bearer cacao" }; }) },
      { code: "cid_mismatch", body: editBundle(base, (bundle) => { bundle.cid = alternative.cid; }) },
      { code: "bad_signature", body: withAuthorization(base, `${token.slice(0, token.lastIndexOf(".") + 1)}AA`) },
      { code: "wrong_delegatee", grant: await makeSignedTranscriptGrant({ now, audience: "did:key:z6MkOther" }) },
      { code: "bad_session_signature", body: { ...base, signature: alternative.signature } },
      { code: "wrong_delegator", grant: alternative, address: base.address },
      { code: "session_expired", grant: await makeSignedTranscriptGrant({ now, expirationTime: new Date(now - 30_000).toISOString() }) },
      { code: "session_mismatch", grant: await makeSignedTranscriptGrant({ now, sessionUri: "did:key:z6MkDifferent#session" }) },
      { code: "proof_mismatch", grant: await makeSignedTranscriptGrant({ now, proof: [] }) },
      { code: "foreign_space_delegation", grant: await makeSignedTranscriptGrant({ now, att: att(alternative.spaceId) }) },
      { code: "overbroad_delegation", grant: await makeSignedTranscriptGrant({ now, att: { ...att(base.spaceId), [kv]: { ...att(base.spaceId)[kv], "tinycloud.kv/list": [] } } }) },
      { code: "overbroad_delegation", grant: await makeSignedTranscriptGrant({ now, att: { ...att(base.spaceId), [sql]: { ...att(base.spaceId)[sql], "tinycloud.sql/write": [{ database: "other" }] } } }) },
      { code: "insufficient_delegation", grant: await makeSignedTranscriptGrant({ now, att: { ...att(base.spaceId), [sql]: { "tinycloud.sql/read": [] } } }) },
      { code: "expired", grant: await makeSignedTranscriptGrant({ now, expiresAt: Math.floor((now + 30_000) / 1000) }) },
      { code: "expiry_too_long", grant: await makeSignedTranscriptGrant({ now, expiresAt: Math.floor((now + 31 * 86_400_000) / 1000) }) },
      { code: "not_yet_valid", grant: await makeSignedTranscriptGrant({ now, nbf: Math.floor((now + HOUR) / 1000) }) },
    ];
    for (const testCase of cases) {
      const fixture = appFor(base, { address: testCase.address });
      await withServer(fixture.app, async (url) => {
        const response = await post(url, testCase.body ?? testCase.grant ?? base);
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe(testCase.code);
      });
      expect(fixture.calls.activate).toEqual([]);
      expect(fixture.calls.store).toBe(0);
      expect(fixture.records.size).toBe(0);
    }
  });

  it("rejects missing inputs and all three byte caps before CID computation or storage", async () => {
    const grant = await makeSignedTranscriptGrant();
    for (const { body, error } of [
      { body: {}, error: "invalid_body" },
      { body: { ...grant, serialized: "x".repeat(64 * 1024 + 1) }, error: "bundle_too_large" },
      { body: { ...grant, siwe: "x".repeat(16 * 1024 + 1) }, error: "bundle_too_large" },
      { body: { ...grant, signature: "x".repeat(1025) }, error: "bundle_too_large" },
    ]) {
      const fixture = appFor(grant);
      await withServer(fixture.app, async (base) => {
        const response = await post(base, body);
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe(error);
      });
      expect(fixture.calls).toEqual({ cid: 0, activate: [], store: 0 });
    }
  });

  for (const { scenario, eligibility } of [
    { scenario: "flag off", eligibility: (_address: string) => false },
    { scenario: "outside cohort", eligibility: (address: string) => address === "0x0000000000000000000000000000000000000001" },
  ]) {
    it(`${scenario} returns 403 before verification, activation or storage`, async () => {
      const grant = await makeSignedTranscriptGrant();
      const fixture = appFor(grant, { eligibility });
      await withServer(fixture.app, async (base) => {
        const response = await post(base, grant);
        expect(response.status).toBe(403);
        expect((await response.json()).error).toBe("delivery_disabled");
      });
      expect(fixture.calls).toEqual({ cid: 0, activate: [], store: 0 });
    });
  }

  it("reports disabled, enabled and schema_missing delivery independently of grant status", async () => {
    const grant = await makeSignedTranscriptGrant();
    for (const [eligible, schemaMissing, delivery] of [
      [false, false, "disabled"], [true, false, "enabled"], [true, true, "schema_missing"],
    ] as const) {
      const fixture = appFor(grant, { eligible, schemaMissing });
      await withServer(fixture.app, async (base) => {
        const initial = await fetch(`${base}/api/delegations/status`);
        expect(await initial.json()).toEqual({ status: "none", expiresAt: null, verified: false, delivery });
        if (!eligible) return;
        expect((await post(base, grant)).status).toBe(200);
        const active = await fetch(`${base}/api/delegations/status`);
        expect(await active.json()).toEqual({ status: "active", expiresAt: grant.expiresAt.toISOString(), verified: true, delivery });
      });
    }
  });

  it("removes a stored grant once delivery is disabled for the address, reporting it until removal succeeds", async () => {
    const grant = await makeSignedTranscriptGrant();
    let eligible = true;
    let failRemoval = 0;
    const changed: string[] = [];
    const fixture = appFor(grant, {
      eligibility: () => eligible,
      onRemove: async () => { if (failRemoval-- > 0) throw new Error("store unavailable"); },
      onGrantChanged: (address) => changed.push(address),
    });
    const address = grant.address.toLowerCase();
    const active = { status: "active", expiresAt: grant.expiresAt.toISOString(), verified: true };
    await withServer(fixture.app, async (base) => {
      const status = async () => (await fetch(`${base}/api/delegations/status`)).json();
      expect((await post(base, grant)).status).toBe(200);
      expect(await status()).toEqual({ ...active, delivery: "enabled" });

      // Narrowed out of the cohort while the store is failing: the grant is still there, so say so.
      eligible = false;
      failRemoval = 1;
      expect(await status()).toEqual({ ...active, delivery: "disabled" });
      expect(fixture.records.has(address)).toBe(true);
      // The next read removes it (compare-and-delete) and signals the change.
      const before = changed.length;
      expect(await status()).toEqual({ status: "none", expiresAt: null, verified: false, delivery: "disabled" });
      expect(fixture.records.has(address)).toBe(false);
      expect(changed.length).toBe(before + 1);
      expect((await post(base, grant)).status).toBe(403);

      // Re-widened: no grant comes back by itself, and a fresh one is accepted again.
      eligible = true;
      expect(await status()).toEqual({ status: "none", expiresAt: null, verified: false, delivery: "enabled" });
      expect((await post(base, grant)).status).toBe(200);
      expect(await status()).toEqual({ ...active, delivery: "enabled" });
    });
  });

  it("evicts a stored grant whose signed envelope no longer verifies", async () => {
    const grant = await makeSignedTranscriptGrant();
    const mismatchedSignature = (await makeSignedTranscriptGrant({ wallet: "B" })).signature;
    const fixture = appFor(grant);
    const parsed: unknown = JSON.parse(grant.envelope);
    if (!parsed || typeof parsed !== "object" || !("signature" in parsed)) throw new Error("fixture lacks signature");
    fixture.records.set(grant.address.toLowerCase(), {
      serialized: JSON.stringify({ ...parsed, signature: mismatchedSignature }),
      grantedAt: new Date().toISOString(), expiresAt: grant.expiresAt.toISOString(),
      policyHash: backendDelegationPolicyHash(grant.backendDid), delegateDid: grant.backendDid,
      path: "", actions: [],
    });
    await withServer(fixture.app, async (base) => {
      const status = await fetch(`${base}/api/delegations/status`);
      expect(await status.json()).toEqual({ status: "stale", expiresAt: null, verified: false, delivery: "enabled" });
    });
    expect(fixture.records.has(grant.address.toLowerCase())).toBe(false);
    expect(fixture.calls.activate).toEqual([]);
  });

  it("does not delete a newer grant while reporting a stale status observation", async () => {
    const grant = await makeSignedTranscriptGrant();
    const newer = await makeSignedTranscriptGrant({ expiresAt: Math.floor((grant.expiresAt.getTime() + 2 * HOUR) / 1000) });
    const invalid = JSON.stringify({ ...JSON.parse(grant.envelope), signature: (await makeSignedTranscriptGrant({ wallet: "B" })).signature });
    const fixture = appFor(grant, { onCid: (count) => {
      if (count === 1) {
        fixture.records.set(grant.address.toLowerCase(), {
          serialized: newer.envelope, grantedAt: new Date().toISOString(),
          expiresAt: newer.expiresAt.toISOString(), policyHash: backendDelegationPolicyHash(grant.backendDid),
          delegateDid: grant.backendDid, path: "", actions: [],
        });
      }
    } });
    fixture.records.set(grant.address.toLowerCase(), {
      serialized: invalid, grantedAt: new Date().toISOString(), expiresAt: grant.expiresAt.toISOString(),
      policyHash: backendDelegationPolicyHash(grant.backendDid), delegateDid: grant.backendDid,
      path: "", actions: [],
    });
    await withServer(fixture.app, async (base) => {
      const first = await fetch(`${base}/api/delegations/status`);
      expect(await first.json()).toEqual({ status: "stale", expiresAt: null, verified: false, delivery: "enabled" });
      expect(fixture.records.get(grant.address.toLowerCase())?.serialized).toBe(newer.envelope);
      const next = await fetch(`${base}/api/delegations/status`);
      expect(await next.json()).toEqual({ status: "active", expiresAt: newer.expiresAt.toISOString(), verified: true, delivery: "enabled" });
    });
  });

  it("does not activate, store or replace a valid grant unless the new expiry gains at least one hour", async () => {
    const grant = await makeSignedTranscriptGrant();
    const almost = await makeSignedTranscriptGrant({ expiresAt: Math.floor((grant.expiresAt.getTime() + HOUR - 60_000) / 1000) });
    const fixture = appFor(grant);
    await withServer(fixture.app, async (base) => {
      expect((await post(base, grant)).status).toBe(200);
      const response = await post(base, almost);
      expect(response.status).toBe(200);
      expect((await response.json()).expiresAt).toBe(grant.expiresAt.toISOString());
    });
    expect(fixture.calls.activate).toHaveLength(2);
    expect(fixture.calls.store).toBe(1);
    expect(fingerprint((await fixture.store.load(grant.address))?.serialized)).toBe(fingerprint(grant.envelope));
  });

  for (const mode of ["identical", "extension", "older last"] as const) {
    it(`serializes concurrent same-address POSTs: ${mode}`, async () => {
      const grant = await makeSignedTranscriptGrant({ expiresAt: Math.floor((Date.now() + 27 * 86_400_000) / 1000) });
      const extended = await makeSignedTranscriptGrant({ expiresAt: Math.floor((grant.expiresAt.getTime() + 2 * HOUR) / 1000) });
      const first = mode === "older last" ? extended : grant;
      const second = mode === "identical" ? first : mode === "older last" ? grant : extended;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const secondVerified = Promise.withResolvers<void>();
      let active = 0;
      let maxActive = 0;
      const fixture = appFor(grant, { onCid: (count) => { if (count === 4) secondVerified.resolve(); }, onActivation: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        if (active === 1 && fixture.calls.activate.length === 1) {
          started.resolve();
          await release.promise;
        }
        active--;
      } });
      await withServer(fixture.app, async (base) => {
        const firstResponse = post(base, first);
        await started.promise;
        const secondResponse = post(base, second);
        await secondVerified.promise;
        // Let the second handler reach the coordinator while the first activation remains held.
        await Promise.resolve();
        release.resolve();
        const [a, b] = await Promise.all([firstResponse, secondResponse]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
      });
      expect(maxActive).toBe(1);
      const expected = mode === "identical" ? first : extended;
      expect(fixture.calls.store).toBe(mode === "extension" ? 2 : 1);
      expect(fixture.calls.activate).toHaveLength(mode === "extension" ? 4 : 2);
      expect(fingerprint((await fixture.store.load(grant.address))?.serialized)).toBe(fingerprint(expected.envelope));
      expect((await fixture.store.load(grant.address))?.expiresAt).toBe(expected.expiresAt.toISOString());
    });
  }

  it("does not report a grant change if durable acceptance fails", async () => {
    const grant = await makeSignedTranscriptGrant();
    const changed: string[] = [];
    const fixture = appFor(grant, {
      onStore: async () => { throw new Error("storage unavailable"); },
      onGrantChanged: (address) => { changed.push(address); },
    });
    await withServer(fixture.app, async (base) => {
      const response = await post(base, grant);
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe("unavailable");
    });
    expect(fixture.calls.activate).toHaveLength(2);
    expect(fixture.calls.store).toBe(1);
    expect(fixture.records.size).toBe(0);
    expect(changed).toEqual([]);
  });

  it("returns a redacted 503 on status load failure without changing the grant", async () => {
    const grant = await makeSignedTranscriptGrant();
    const fixture = appFor(grant, { onLoad: async () => { throw new Error(grant.envelope); } });
    await withServer(fixture.app, async (base) => {
      const response = await fetch(`${base}/api/delegations/status`);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ error: "unavailable" });
      expect(body).not.toContain(grant.envelope);
    });
    expect(fixture.records.size).toBe(0);
  });

  it("returns a redacted 503 when expired-grant cleanup fails and does not signal revocation", async () => {
    const grant = await makeSignedTranscriptGrant();
    const changed: string[] = [];
    const fixture = appFor(grant, {
      onRemove: async () => { throw new Error(grant.envelope); },
      onGrantChanged: (address) => { changed.push(address); },
    });
    fixture.records.set(grant.address.toLowerCase(), {
      serialized: grant.envelope, grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(), actions: [], path: "",
    });
    await withServer(fixture.app, async (base) => {
      const response = await fetch(`${base}/api/delegations/status`);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ error: "unavailable" });
      expect(body).not.toContain(grant.envelope);
    });
    expect(fixture.records.get(grant.address.toLowerCase())?.serialized).toBe(grant.envelope);
    expect(changed).toEqual([]);
  });

  it("returns a redacted 503 on DELETE failure and retains the grant for the worker", async () => {
    const grant = await makeSignedTranscriptGrant();
    const changed: string[] = [];
    const fixture = appFor(grant, {
      onRemove: async () => { throw new Error(grant.envelope); },
      onGrantChanged: (address) => { changed.push(address); },
    });
    fixture.records.set(grant.address.toLowerCase(), {
      serialized: grant.envelope, grantedAt: new Date().toISOString(),
      expiresAt: grant.expiresAt.toISOString(), actions: [], path: "",
    });
    const logs: string[] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...values: unknown[]) => { logs.push(values.map(String).join(" ")); };
    console.error = (...values: unknown[]) => { logs.push(values.map(String).join(" ")); };
    try {
      await withServer(fixture.app, async (base) => {
        const response = await fetch(`${base}/api/delegations`, { method: "DELETE" });
        expect(response.status).toBe(503);
        const body = await response.text();
        expect(JSON.parse(body)).toEqual({ error: "unavailable" });
        expect(body).not.toContain(grant.envelope);
      });
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
    expect(logs.join(" ")).not.toContain(grant.envelope);
    expect(fixture.records.get(grant.address.toLowerCase())?.serialized).toBe(grant.envelope);
    expect(changed).toEqual([]);
  });

  it("limits each wallet address to six attempts per hour before verifying the seventh", async () => {
    const grant = await makeSignedTranscriptGrant();
    const fixture = appFor(grant);
    await withServer(fixture.app, async (base) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        expect((await post(base, grant)).status).toBe(200);
      }
      const seventh = await post(base, grant);
      expect(seventh.status).toBe(429);
      expect((await seventh.json()).error).toBe("delegation_rate_limited");
    });
    expect(fixture.calls.store).toBe(1);
    expect(fixture.calls.activate).toHaveLength(2);
  });
});
