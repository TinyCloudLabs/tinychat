// Loopback-only end-to-end check of TrustBot standing reads (TC-4000) against a real TinyCloud node: the owner approves
// a standing read for meetings, then leaves. The bot's reads run under the standing grant through the real backend
// routes, each one committing its audit row first. The node renews the grant with its own stamps, the backend verifies
// that signed history on each read past the original end, Stop revokes at the node and a seven-day window ends.
//
// Needs a local TinyCloud node: STANDING_READS_TEST_NODE=http://127.0.0.1:<port>. Optional:
//   STANDING_READS_TEST_WINDOW_SECONDS  signed window of the renewing grant (default 600, so the node's five-minute
//                                       scheduler issues two stamps before and after the original end)
//   STANDING_READS_TEST_RENEWAL_MODULE  path of a module exporting verifyRenewalHistory to use instead of the pinned
//                                       @tinycloud/sdk-core; unset, every check uses the same code as production
//   STANDING_READS_TEST_EVIDENCE        file to write the observed node history and step results to
//
// Stand-ins, all on this machine: the TEE key root is a fixed test seed passed to the real deriver, OpenKey's approval
// screen is the owner signing the same grant and lease directly and OpenKey's lease-status route is a small server that
// checks the holder's proof. Every request this process makes is checked: one to anything but 127.0.0.1 fails the test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { NodeWasmBindings, TinyCloudNode } from "@tinycloud/node-sdk";
import { signCompactUcanAuthorization, verifyDidKeyEd25519Signature } from "@tinycloud/sdk-core";
import { assertRenewalNodeIdentity, verifyRenewalHistory, type RenewalStampHistoryEntry } from "@tinycloud/sdk-core/delegations/renewal";
import type { OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import { APP_ID, CONNECTOR_SCHEMA, CONNECTORS_SQL_DB_NAME } from "@tinyboilerplate/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signedCallHeader } from "../bots-signed-call.js";
import { createBotsServiceGuardRouter } from "../bots-service-routes.js";
import { fetchDelegationStatus, type RenewalVerifyConfig } from "../renewal-verify.js";
import type { BotsConfig } from "../routes/bots.js";
import { createTrustBotReadsInternalRouter, createTrustBotReadsRouter, TRUSTBOT_READS_INTERNAL_PREFIX } from "../routes/trustbot-reads.js";
import { createReadAudit, type ReadAudit, type ReadSummary } from "../trustbot-reads/audit.js";
import { TrustBotReadGrants } from "../trustbot-reads/grants.js";
import { StandingApprovalClient, type CollectedApproval, type StandingApprovalLink } from "../trustbot-reads/standing-approval.js";
import { StandingReadsController, type StandingReadMetadata } from "../trustbot-reads/standing-controller.js";
import { STANDING_READ_LEASE_SECONDS, STANDING_READ_WINDOW_SECONDS, standingReadPermissions, verifyStandingReadApproval, type StandingReadGrant, type VerifyRenewalChain } from "../trustbot-reads/standing-grant.js";
import { DstackStandingHolderDeriver, STANDING_HOLDER_ROOT } from "../trustbot-reads/standing-holder.js";
import { backendStandingMetadataStore } from "../trustbot-reads/standing-store.js";
import { StandingReadRuntime, type StandingReadView } from "../trustbot-reads/standing.js";
import { emptyLocationRegistry } from "./helpers/empty-location-registry.js";
import { loopbackOnly } from "./helpers/loopback-only.js";

const host = process.env.STANDING_READS_TEST_NODE;
const renewalModule = process.env.STANDING_READS_TEST_RENEWAL_MODULE;
const evidencePath = process.env.STANDING_READS_TEST_EVIDENCE;
const windowSeconds = Number(process.env.STANDING_READS_TEST_WINDOW_SECONDS ?? 600);
const DAY = 86_400;
const FIND = "tinycloud_find_meetings";
const STATUS = "tinycloud.delegation/status";
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const nowSeconds = () => Math.floor(Date.now() / 1000);
const evidence: Record<string, unknown> = { node: host, renewalModule: renewalModule ?? "pinned @tinycloud/sdk-core", windowSeconds };
const record = (step: string, value: unknown) => {
  evidence[step] = value;
  console.log(`[standing-proof] ${step} ${JSON.stringify(value)}`);
  if (evidencePath) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
};

const realFetch = globalThis.fetch;
const guard = loopbackOnly(realFetch);
const cleanups: Array<() => Promise<unknown>> = [];
const wasm = new NodeWasmBindings();
const ownerKey = generatePrivateKey();
const account = privateKeyToAccount(ownerKey);
const address = account.address;
const ownerDid = `did:pkh:eip155:1:${address.toLowerCase()}`;
const sentinel = `Standing proof meeting ${randomBytes(6).toString("hex")}`;
const callSecret = randomBytes(32).toString("hex");
// The deterministic stand-in for dstack GetKey. The real deriver zeroes each root it is given.
const testRoot = Buffer.alloc(32, 0x5a);
const rootPaths: string[] = [];
const keys = new DstackStandingHolderDeriver({ getKey: async path => { rootPaths.push(path); return Buffer.from(testRoot); } });

// What the backend did, in order: audit commits and node calls, so the test can show which came first.
const events: string[] = [];
const auditFault = { begin: false };
let nodeKeys: { nodeDid: string; renewerDid: string; renewerPublicKey: string; renewerEpoch: number };
let config: RenewalVerifyConfig;
let spaceId: string;
let owner: TinyCloudNode;
let controller: StandingReadsController;
let audit: ReadAudit;
let metadata: ReturnType<typeof backendStandingMetadataStore>;
let backendOrigin: string;
let openKeyOrigin: string;
let readsApp: express.Express;
let injectedVerify: VerifyRenewalChain | undefined;

interface Approval {
  request: OpenKeyApprovalRequestV1;
  link: StandingApprovalLink;
  result?: CollectedApproval;
  lease?: { originalCid: string; leaseExpiresAt: string; state: "active" | "stopped" | "expired" };
  proofs: number;
}
const approvals = new Map<string, Approval>();

const backendFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === host) events.push(`node ${url.pathname}`);
  return guard.fetch(input, init);
}) as typeof fetch;

async function json(response: Response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

type ToolReply = { ok: boolean; text?: string; error?: string; code?: string };

async function ownerCall<T = unknown>(method: string, path: string): Promise<{ status: number; body: T }> {
  const response = await guard.fetch(`${backendOrigin}/api/bots/main/reads${path}`, { method });
  return { status: response.status, body: await json(response) };
}

async function botRead(tool: string, args: Record<string, unknown>, origin = backendOrigin): Promise<ToolReply> {
  const path = `${TRUSTBOT_READS_INTERNAL_PREFIX}/${tool}`;
  const body = JSON.stringify({ args });
  const authorization = signedCallHeader(callSecret, { direction: "to-backend", environment: "private", owner: ownerDid, bot: "main", method: "POST", path, body });
  const response = await guard.fetch(origin + path, { method: "POST", headers: { authorization }, body });
  expect(response.status).toBe(200);
  return json(response);
}

async function summary(): Promise<ReadSummary> {
  const { status, body } = await ownerCall<ReadSummary>("GET", "/standing/summary");
  expect(status).toBe(200);
  return body;
}

async function state(): Promise<StandingReadMetadata> {
  return (await metadata.read(ownerDid)).state;
}

/** The owner's side of the OpenKey approval screen: sign the exact grant and lease, admit both at the node. */
async function approve(requestId: string, window: number): Promise<StandingReadGrant & { start: number }> {
  const approval = approvals.get(requestId)!;
  const { request } = approval;
  const start = nowSeconds();
  const originalEnd = start + window;
  const leaseLifetime = request.renewal!.leaseLifetimeSeconds;
  const leaseEnd = start + leaseLifetime;
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of request.permissions) {
    const service = permission.service.replace(/^tinycloud\./, "");
    (abilities[service] ??= {})[permission.path] = [...permission.actions];
  }
  const sign = async (prepared: ReturnType<typeof wasm.prepareSession>) => {
    const signature = await account.signMessage({ message: prepared.siwe });
    return { ...wasm.completeSessionSetup({ ...prepared, signature }), siwe: prepared.siwe, signature };
  };
  const original = await sign(wasm.prepareSession({
    abilities, address, chainId: 1, domain: "openkey.so", issuedAt: iso(start), expirationTime: iso(originalEnd), spaceId,
    delegateUri: request.targetDid,
  }));
  const lease = await sign(wasm.prepareSession({
    abilities: {}, rawAbilities: { [`urn:cid:${original.delegationCid}`]: ["tinycloud.delegation/renew"] },
    address, chainId: 1, domain: "openkey.so", issuedAt: iso(start), expirationTime: iso(leaseEnd), spaceId,
    delegateUri: nodeKeys.renewerDid,
  }));
  for (const signed of [original, lease]) {
    const response = await guard.fetch(`${host}/delegate`, { method: "POST", headers: { Authorization: signed.delegationHeader.Authorization } });
    const receipt = await json(response);
    expect(response.status).toBe(200);
    expect(receipt.cid).toBe(signed.delegationCid);
  }
  approval.lease = { originalCid: original.delegationCid, leaseExpiresAt: iso(leaseEnd), state: "active" };
  approval.result = {
    state: "ready", resultRef: `result-${requestId}`,
    opened: {
      resultVersion: 1, requestId, requestDigest: approval.link.bodyCid, requesterDid: request.issuer, targetDid: request.targetDid,
      ownerDid, delegationExpiresAt: iso(originalEnd),
      delegation: {
        ...original, address, chainId: 1, spaceId, jwk: request.targetPublicJwk, verificationMethod: request.targetDid, hostActivated: true,
      },
      renewalChoice: "leased",
      renewal: {
        version: 1, approvedAt: iso(start), approvedLeaseLifetimeSeconds: leaseLifetime,
        receipt: {
          originalCid: original.delegationCid, leaseCid: lease.delegationCid, nodeIdentity: nodeKeys,
          leaseAuthorization: lease.delegationHeader.Authorization.replace(/^Bearer /i, ""),
          leaseExpiresAt: iso(leaseEnd), leaseGeneration: 1,
        },
      },
    },
  };
  return {
    start, ownerDid, holderDid: request.targetDid, originalCid: original.delegationCid, originalEnd,
    leaseCid: lease.delegationCid, leaseEnd, spaceId, areas: ["meetings"],
  };
}

/** The node's `/delegation/status` fields this test reads. */
interface NodeGrantStatus {
  cid: string;
  active: boolean;
  revoked: boolean;
  effective_expiry: number;
  renewal_history: RenewalStampHistoryEntry[];
}

/** The node's status for the active original, asked as the holder with a real-time invocation. */
async function holderStatus(cid: string): Promise<{ at: number; status: NodeGrantStatus }> {
  const current = await controller.current(address);
  expect(current).toBeDefined();
  const at = nowSeconds();
  const invocation = await signCompactUcanAuthorization({
    issuerDid: current!.holder.did, audienceDid: config.nodeDid,
    attenuation: { [`urn:cid:${cid}`]: { [STATUS]: [{}] } }, facts: [{}], proofs: [],
    notBefore: at, expiresAt: at + 60, nonce: randomBytes(16).toString("hex"), sign: async bytes => current!.holder.signStatus(bytes),
  });
  const status = await fetchDelegationStatus(guard.fetch, config, cid, invocation.authorization);
  if (status.kind !== "status") throw new Error("node refused the holder's status call");
  return { at, status: status.value as unknown as NodeGrantStatus };
}

function chainCheck(verify: typeof verifyRenewalHistory, grant: StandingReadGrant, history: RenewalStampHistoryEntry[], at: number) {
  try {
    const result = verify({ originalCid: grant.originalCid, leaseCid: grant.leaseCid, leaseExpiresAt: grant.leaseEnd, nodeIdentity: nodeKeys, history, now: at });
    return { ok: true, effectiveExpiry: result.effectiveExpiry, latestStampCid: result.latestStampCid };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The owner's read settings: meetings were turned on with a finite grant that has since ended. */
function awayOwnerGrants(grants: TrustBotReadGrants): TrustBotReadGrants {
  return new Proxy(grants, {
    get(target, property) {
      if (property === "status") return async () => ({ expiresAt: Date.now() - DAY * 1000, grantCid: null, areas: { meetings: "ended", feed_chats: "off" } });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function readsBackend(runtime: StandingReadRuntime): express.Express {
  const grants = new TrustBotReadGrants({
    // No finite grant is stored, so a refused standing read has no fallback to the owner's browser grant.
    reader: { did: "did:key:unused", useDelegation: () => { throw new Error("finite read used"); }, computeDelegationCid: () => "" } as never,
    store: { get: async () => undefined, put: async () => true, delete: async () => true },
    host: host!, sealSecret: randomBytes(32), standing: runtime,
  });
  const options = {
    grants: awayOwnerGrants(grants),
    config: { accountAllowed: () => true, serviceUrl: "http://127.0.0.1:9" } as unknown as BotsConfig,
    auth: ((req, _res, next) => { Object.assign(req, { user: { address } }); next(); }) as RequestHandler,
    callSecret, standingEnabled: true, standing: controller,
    audit: {
      begin: async attempt => {
        if (auditFault.begin) { events.push("audit begin failed"); throw new Error("audit store unavailable"); }
        const id = await audit.begin(attempt);
        events.push("audit begin");
        return id;
      },
      settle: async (id, outcome) => { await audit.settle(id, outcome); events.push(`audit settle ${outcome}`); },
      summary: (...args) => audit.summary(...args),
    } satisfies ReadAudit,
  };
  const app = express();
  app.use(createBotsServiceGuardRouter());
  app.use("/api/bots/main/reads", createTrustBotReadsRouter(options));
  app.use(TRUSTBOT_READS_INTERNAL_PREFIX, createTrustBotReadsInternalRouter(options));
  return app;
}

/** OpenKey's lease-status route as specified for TinyChat: the holder's proof is checked before any state is returned. */
function openKeyLeaseStatus(): express.Express {
  const app = express();
  app.post("/api/approval-requests/:id/lease-status", express.json(), (req, res) => {
    const approval = approvals.get(req.params.id);
    const proof = req.get("OpenKey-Session-Proof") ?? "";
    const [header, payload, signature] = proof.split(".");
    if (!approval || !header || !payload || !signature) { res.status(404).json({ code: "not_found" }); return; }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const { bodyCid, originalCid } = req.body as { bodyCid?: string; originalCid?: string | null };
    const binding = createHash("sha256").update(JSON.stringify(["lease-status", req.params.id, bodyCid, originalCid ?? "", ""])).digest("base64url");
    if (bodyCid !== approval.link.bodyCid || claims.client_id !== "openkey-approval-result-v1" || claims.htm !== "POST" ||
      claims.htu !== `${openKeyOrigin}${req.path}` || Math.abs(claims.iat - nowSeconds()) > 60 || claims.cred_hash !== binding ||
      !verifyDidKeyEd25519Signature(approval.request.targetDid, Buffer.from(`${header}.${payload}`), Buffer.from(signature, "base64url"))) {
      res.status(401).json({ code: "invalid_proof" });
      return;
    }
    approval.proofs++;
    if (!approval.lease) { res.json({ leaseState: "none", originalCid: null }); return; }
    if (originalCid !== approval.lease.originalCid) { res.status(409).json({ code: "request_binding" }); return; }
    res.set("Cache-Control", "no-store").json({ leaseState: approval.lease.state, originalCid: approval.lease.originalCid, leaseExpiresAt: approval.lease.leaseExpiresAt });
  });
  return app;
}

const requestIdOf = () => Array.from(randomBytes(26), byte => "abcdefghijklmnopqrstuvwxyz234567"[byte & 31]).join("");

beforeAll(async () => {
  if (!host) return;
  if (new URL(host).hostname !== "127.0.0.1") throw new Error("loopback node required");
  globalThis.fetch = guard.fetch;
  // The candidate verifier is chosen at run time, so the same run can compare an unreleased SDK build.
  if (renewalModule) injectedVerify = (await import(renewalModule)).verifyRenewalHistory;
  const registry = await emptyLocationRegistry();
  cleanups.push(registry.close);
  // The node also publishes its share invitation key; the approval receipt carries only the four renewal fields.
  const published = await json(await guard.fetch(`${host}/.well-known/tinycloud/node-keys`));
  assertRenewalNodeIdentity(published);
  const { nodeDid, renewerDid, renewerPublicKey, renewerEpoch } = published;
  nodeKeys = { nodeDid, renewerDid, renewerPublicKey, renewerEpoch };
  record("node-identity", { nodeDid: nodeKeys.nodeDid, renewerDid: nodeKeys.renewerDid, renewerEpoch: nodeKeys.renewerEpoch });

  // The owner's data: one meeting row in the applications space, written while the owner is signed in.
  owner = new TinyCloudNode({
    privateKey: ownerKey, host, prefix: "standing-proof-owner", autoCreateSpace: true, includeAccountRegistryPermissions: false,
    tinycloudRegistryUrl: registry.url,
    manifest: {
      manifest_version: 1, app_id: APP_ID, name: "Standing read proof owner", defaults: false, includePublicSpace: false,
      space: "applications", prefix: "", expiry: "2h",
      permissions: [{ service: "tinycloud.sql", space: "applications", path: CONNECTORS_SQL_DB_NAME, actions: ["read", "write", "schema"], skipPrefix: true }],
    },
  });
  await owner.signIn();
  spaceId = await owner.ensureOwnedSpaceHosted("applications");
  const db = owner.sql.db(CONNECTORS_SQL_DB_NAME);
  for (const { sql } of CONNECTOR_SCHEMA) {
    const created = await db.execute(sql);
    if (!created.ok) throw new Error(`schema: ${created.error.code}`);
  }
  const at = new Date().toISOString();
  const inserted = await db.execute(
    "INSERT INTO connector_meeting (id, source, source_id, title, started_at, duration_secs, participants, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [randomBytes(16).toString("hex"), "granola", randomBytes(8).toString("hex"), sentinel, at, 1800, "[]", at, at],
  );
  if (!inserted.ok) throw new Error(`insert: ${inserted.error.code}`);

  // The backend's own space holds the standing approval metadata and the read audit, as in production. Its session
  // gets the same KV-only grant as packages/server createBackendIdentity.
  const backendPrefix = "standing-proof-backend";
  const backend = new TinyCloudNode({
    privateKey: generatePrivateKey(), host, prefix: backendPrefix, autoCreateSpace: true, includeAccountRegistryPermissions: false,
    tinycloudRegistryUrl: registry.url,
    manifest: {
      app_id: backendPrefix, name: "Backend identity", space: backendPrefix, prefix: "", defaults: false, includePublicSpace: false,
      permissions: [{ service: "tinycloud.kv", path: "", actions: ["get", "put", "del", "list"] }],
    },
  });
  await backend.signIn();
  audit = createReadAudit(backend);
  metadata = backendStandingMetadataStore(backend);

  openKeyOrigin = await listen(openKeyLeaseStatus());
  const openKeyClient = new StandingApprovalClient({ keys, origins: { links: openKeyOrigin, api: openKeyOrigin, web: openKeyOrigin }, fetch: guard.fetch });
  config = { backendOrigin: "http://127.0.0.1:1", nodeOrigin: host, nodeDid: nodeKeys.nodeDid, renewerDid: nodeKeys.renewerDid };
  controller = new StandingReadsController({
    store: metadata, keys, config, fetch: backendFetch,
    enabledAreas: async () => ["meetings"],
    openKey: {
      async create(_scope, holder, request) {
        expect(request.targetDid).toBe(holder.did);
        const link: StandingApprovalLink = {
          requestId: requestIdOf(), bodyCid: `body-${randomBytes(8).toString("hex")}`, expiresAt: iso(nowSeconds() + 3600),
          record: { header: {} as StandingApprovalLink["record"]["header"], signature: {} as StandingApprovalLink["record"]["signature"] },
        };
        approvals.set(link.requestId, { request, link, proofs: 0 });
        return link;
      },
      url: async (_scope, link) => `${openKeyOrigin}/approve/${link.requestId}`,
      collect: async (_scope, _holder, link) => approvals.get(link.requestId)?.result ?? { state: "pending" },
      acknowledge: async () => {},
      leaseState: (holder, link, originalCid, leaseEnd) => openKeyClient.leaseState(holder, link, originalCid, leaseEnd),
    },
  });
  readsApp = readsBackend(new StandingReadRuntime({ store: controller, config, fetch: backendFetch, verifyRenewalChain: injectedVerify }));
  backendOrigin = await listen(readsApp);
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  if (guard.refused.length > 0) console.error(`requests refused because they were not to this machine: ${guard.refused.join(", ")}`);
  expect(guard.refused).toEqual([]);
});

let first: StandingReadGrant & { start: number };
let firstRequestId: string;

describe.skipIf(!host)("standing reads against a real node", () => {
  test("1. the owner approves a seven-day window under a 90-day lease and the backend derives the holder", async () => {
    const asked = await ownerCall<StandingReadView>("POST", "/standing");
    expect(asked.status).toBe(200);
    expect(asked.body.pending?.approveUrl).toStartWith(`${openKeyOrigin}/approve/`);
    const pending = (await state()).pending!;
    firstRequestId = pending.link.requestId;
    const { request } = approvals.get(firstRequestId)!;
    expect(request.grantLifetimeSeconds).toBe(STANDING_READ_WINDOW_SECONDS);
    expect(request.renewal?.leaseLifetimeSeconds).toBe(STANDING_READ_LEASE_SECONDS);
    expect(request.permissions).toEqual(standingReadPermissions(["meetings"]));
    const holder = await keys.derive(ownerDid, pending.scope.approvalId, pending.scope.generation);
    expect(request.targetDid).toBe(holder.did);
    expect(rootPaths.every(path => path === STANDING_HOLDER_ROOT)).toBe(true);

    first = await approve(firstRequestId, windowSeconds);
    const view = await ownerCall<StandingReadView>("GET", "/standing");
    expect(view.status).toBe(200);
    if (!view.body.active) {
      // The controller records only "failed"; ask the verifier directly so the log names the refused check.
      const { link } = approvals.get(firstRequestId)!;
      const opened = approvals.get(firstRequestId)!.result;
      const why = await verifyStandingReadApproval({
        opened: opened?.state === "ready" ? opened.opened : {}, requestId: link.requestId, bodyCid: link.bodyCid, request, address,
        areas: ["meetings"], config, now: nowSeconds(),
      }).then(() => "accepted", (error: unknown) => (error instanceof Error ? error.message : String(error)));
      record("1-approval-refused", { outcome: view.body.outcome, verifier: why });
    }
    expect(view.body.active).toEqual({ originalCid: first.originalCid, areas: ["meetings"], validUntil: first.originalEnd * 1000 });
    const stored = await state();
    expect(stored.active?.grant).toMatchObject({ originalCid: first.originalCid, leaseCid: first.leaseCid, holderDid: holder.did });
    // Only public metadata is kept: no private key, seed or relay secret.
    const kept = JSON.stringify(stored);
    expect(kept).not.toContain(testRoot.toString("hex"));
    expect(kept).not.toMatch(/"(d|privateKey|seed|secret)":/);
    expect(approvals.get(firstRequestId)!.proofs).toBeGreaterThan(0);
    record("1-approval", {
      originalCid: first.originalCid, leaseCid: first.leaseCid, holderDid: holder.did, generation: stored.generation,
      signedStart: iso(first.start), originalSignedEnd: iso(first.originalEnd), leaseEnd: iso(first.leaseEnd),
      requestedWindowSeconds: request.grantLifetimeSeconds, requestedLeaseSeconds: request.renewal?.leaseLifetimeSeconds,
    });
  }, 120_000);

  test("2. with the owner away each read commits its audit row first, a failed audit write refuses the read and the owner sees counts only", async () => {
    events.length = 0;
    const read = await botRead(FIND, { limit: 5 });
    expect(read.ok).toBe(true);
    expect(read.text).toContain(sentinel);
    const firstNode = events.findIndex(event => event.startsWith("node "));
    expect(events[0]).toBe("audit begin");
    expect(firstNode).toBeGreaterThan(0);
    expect(events).toContain("node /invoke");
    expect(events.at(-1)).toBe("audit settle ok");
    const order = [...events];

    events.length = 0;
    auditFault.begin = true;
    const refused = await botRead(FIND, { limit: 5 });
    auditFault.begin = false;
    expect(refused).toEqual({ ok: false, error: "unavailable" });
    expect(events).toEqual(["audit begin failed"]);

    const seen = await summary();
    expect(seen.total).toBe(1);
    expect(seen.days).toEqual([{ day: new Date().toISOString().slice(0, 10), area: "meetings", tool: FIND, ok: 1, refused: 0 }]);
    const shown = JSON.stringify(seen);
    for (const hidden of [sentinel, first.originalCid, first.leaseCid, first.holderDid, "SELECT"]) expect(shown).not.toContain(hidden);
    record("2-away-reads", { order, refusedWhenAuditFails: refused, nodeCallsWhenAuditFails: 0, summary: seen });
  }, 120_000);

  test("3. the node renews with two stamps and a read past the original signed end verifies the stamp chain", async () => {
    const deadline = first.originalEnd + 2 * windowSeconds;
    let observed: Awaited<ReturnType<typeof holderStatus>>;
    let stamps: RenewalStampHistoryEntry[] = [];
    for (;;) {
      observed = await holderStatus(first.originalCid);
      stamps = observed.status.renewal_history.filter(entry => entry.lease_cid === first.leaseCid);
      if (stamps.length >= 2 && observed.at > first.originalEnd) break;
      if (nowSeconds() > deadline) throw new Error(`node issued ${stamps.length} stamps by ${iso(nowSeconds())}`);
      // The node's own scheduler issues the stamps on its real clock; there is no event to wait on.
      await Bun.sleep(15_000);
    }
    const history = observed.status.renewal_history as RenewalStampHistoryEntry[];
    const stampView = stamps.map(({ cid, generation, previous_stamp_cid, new_end }) => ({ cid, generation, previous_stamp_cid, newEnd: iso(new_end) }));
    const pinned = chainCheck(verifyRenewalHistory, first, history, observed.at);
    const candidate = injectedVerify ? chainCheck(injectedVerify, first, history, observed.at) : undefined;
    record("3-node-stamps", {
      observedAt: iso(observed.at), effectiveExpiry: iso(observed.status.effective_expiry), stamps: stampView,
      pinnedSdkChainCheck: pinned, ...(candidate ? { injectedChainCheck: candidate } : {}),
    });

    const read = await botRead(FIND, { limit: 5 });
    const view = await ownerCall<StandingReadView>("GET", "/standing");
    record("3-read-after-original-end", { at: iso(nowSeconds()), read: read.ok ? { ok: true } : read, viewValidUntil: view.body.active?.validUntil ?? null });
    expect(read.ok).toBe(true);
    expect(read.text).toContain(sentinel);
    expect(stamps.every(stamp => stamp.generation === 1)).toBe(true);
    expect(observed.status.effective_expiry).toBeGreaterThan(first.originalEnd);
  }, (2 * windowSeconds + 900) * 1000);

  test("4. Stop revokes the original at the node, retires the holder generation and refuses reads; the history stays", async () => {
    const before = await state();
    const revoked = await owner.revokeDelegation(first.originalCid);
    expect(revoked.ok).toBe(true);
    const stopped = await ownerCall("DELETE", `/standing/${first.originalCid}`);
    expect(stopped.status).toBe(204);
    const after = await state();
    expect(after.active).toBeUndefined();
    expect(after.generation).toBe(before.generation + 1);
    approvals.get(firstRequestId)!.lease!.state = "stopped";

    events.length = 0;
    const read = await botRead(FIND, { limit: 5 });
    expect(read.ok).toBe(false);
    expect(events).not.toContain("node /invoke");
    expect(events[0]).toBe("audit begin");
    const seen = await summary();
    const row = seen.days.find(day => day.tool === FIND)!;
    expect(row.ok).toBeGreaterThanOrEqual(1);
    expect(row.refused).toBeGreaterThanOrEqual(1);
    record("4-stop", { generationBefore: before.generation, generationAfter: after.generation, readAfterStop: read, summary: seen });
  }, 120_000);

  test("5. a new approval gets a new holder and its seven-day window refuses reads at its signed end on a simulated clock", async () => {
    const asked = await ownerCall<StandingReadView>("POST", "/standing");
    expect(asked.status).toBe(200);
    const pending = (await state()).pending!;
    expect(pending.link.requestId).not.toBe(firstRequestId);
    const second = await approve(pending.link.requestId, STANDING_READ_WINDOW_SECONDS);
    cleanups.push(() => owner.revokeDelegation(second.originalCid));
    const view = await ownerCall<StandingReadView>("GET", "/standing");
    expect(view.body.active).toEqual({ originalCid: second.originalCid, areas: ["meetings"], validUntil: second.originalEnd * 1000 });
    expect(second.holderDid).not.toBe(first.holderDid);
    const live = await botRead(FIND, { limit: 5 });
    expect(live.ok).toBe(true);
    expect(live.text).toContain(sentinel);

    // The node's real status, read now, evaluated by a backend whose clock is at the end of the seven days. The node
    // checks invocation times against its own clock, so the simulated backend replays this answer for its status call.
    const real = await holderStatus(second.originalCid);
    expect(real.status.effective_expiry).toBe(second.originalEnd);
    const replay = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === host && url.pathname === "/delegation/status") return Response.json(real.status);
      if (url.origin === host && url.pathname === "/invoke") throw new Error("simulated clock must not read");
      return backendFetch(input, init);
    }) as typeof fetch;
    const at = (offset: number) => new StandingReadRuntime({ store: controller, config, fetch: replay, now: () => second.originalEnd + offset, verifyRenewalChain: injectedVerify });
    const refusals: string[] = [];
    const justBefore = await at(-120).access(address, "meetings", undefined, outcome => refusals.push(outcome));
    expect(justBefore.state).toBe("active");

    const simulated = readsBackend(at(1));
    const simulatedOrigin = await listen(simulated);
    const read = await botRead(FIND, { limit: 5 }, simulatedOrigin);
    expect(read).toEqual({ ok: false, error: "ended" });
    const afterEnd = await state();
    expect(afterEnd.active).toBeUndefined();
    const seen = await summary();
    record("5-seven-day-end", {
      originalCid: second.originalCid, holderDid: second.holderDid, signedWindowSeconds: second.originalEnd - second.start,
      nodeEffectiveExpiry: iso(real.status.effective_expiry), activeAt: iso(second.originalEnd - 120), refusedAt: iso(second.originalEnd + 1),
      read, refusalsBeforeEnd: refusals, summary: seen,
    });
  }, 180_000);
});
