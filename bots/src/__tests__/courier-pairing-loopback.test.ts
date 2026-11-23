// Real pairing against a local TinyCloud node: C2 orchestration + sealed peer store + C1's lib-adapter + the headless
// Courier SDK, with a stock Courier CLI as the remote agent. Every node request for https://node.tinycloud.xyz is
// routed to the loopback node, in this process and in the CLI children, so the production host pin stays exact.
//
// Skipped unless both are set:
//   TC_COURIER_HEADLESS_NODE_BIN  tinycloud node binary (serve)
//   TC_COURIER_HEADLESS_PACKAGE   the headless packages/courier dir; this test must run from an isolated package root
//                                 whose @tinycloud/courier (and its @tinycloud/* deps) resolve to that package.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CourierGrant } from "../courier/grant-store";
import type { CourierPairing } from "../courier/pairing";
import type { CourierPeerStore } from "../courier/peer-store";

const bin = process.env.TC_COURIER_HEADLESS_NODE_BIN;
const pkg = process.env.TC_COURIER_HEADLESS_PACKAGE;
const live = test.skipIf(!bin || !pkg);
const exec = promisify(execFile);
const PROD = "https://node.tinycloud.xyz";
type Artifact = Record<string, unknown> & { completion?: { x: string; signature: string }; callMe: string; delegation?: string };

let root = "";
let node: ChildProcess | undefined;
let log = -1;
let realFetch: typeof fetch | undefined;
let owner = "";
let store: CourierPeerStore;
let pairing: CourierPairing;
let cli: (home: string, ...args: string[]) => Promise<Artifact>;
let remoteHome = "";
let malloryHome = "";

const rewrite = `const PROD = ${JSON.stringify(PROD)};
const inner = globalThis.fetch;
globalThis.fetch = Object.assign((input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== PROD && !url.startsWith(PROD + "/")) return inner(input, init);
  const next = process.env.C2_LOOPBACK_ORIGIN + url.slice(PROD.length);
  return inner(input instanceof Request ? new Request(next, input) : next, init);
}, { preconnect: inner.preconnect });
`;

async function freePort() {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}

async function rejected(run: Promise<unknown>) {
  try { await run; } catch (error) {
    if (error instanceof Error && "code" in error && "status" in error) return { code: error.code, status: error.status };
    throw error;
  }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  if (!bin || !pkg) return;
  root = mkdtempSync(join(tmpdir(), "c2-loopback-"));
  const port = await freePort();
  const host = `http://127.0.0.1:${port}`;
  process.env.C2_LOOPBACK_ORIGIN = host;
  log = openSync(join(root, "node.log"), "w", 0o600);
  node = spawn(bin, ["serve"], { cwd: root, stdio: ["ignore", log, log], env: {
    ...process.env, HOME: root, TC_HOME: root, COURIER_HOME: root,
    TINYCLOUD_STORAGE__DATADIR: join(root, "db"), TINYCLOUD_PORT: String(port), TINYCLOUD_ADDRESS: "127.0.0.1",
    ROCKET_PORT: String(port), ROCKET_ADDRESS: "127.0.0.1", TINYCLOUD_KEYS__TYPE: "Static", TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
  } });
  let healthy = false;
  for (let i = 0; i < 200 && !healthy && node.exitCode === null; i++) {
    // Real child process start-up: the node exposes no readiness signal other than /healthz.
    try { healthy = (await fetch(`${host}/healthz`)).ok; } catch { await Bun.sleep(50); }
  }
  if (!healthy) throw new Error("loopback node did not start");

  const sdkCore = await import("@tinycloud/sdk-core");
  const nodeSdk = await import("@tinycloud/node-sdk");
  const courier = await import("@tinycloud/courier");
  const registryOrigin = new URL(sdkCore.DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL).origin;
  realFetch = globalThis.fetch;
  const inner = realFetch;
  // Fixture transport only: dstack key service, a cold registry and the loopback node. Anything else is refused.
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "dstack") return Response.json({ key: "42".repeat(32) });
    if (url.origin === registryOrigin) return new Response(sdkCore.REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { "content-type": "application/json" } });
    if (url.origin === PROD) {
      const next = host + url.pathname + url.search;
      return inner(input instanceof Request ? new Request(next, input) : next, init);
    }
    if (url.origin === host) return inner(input, init);
    throw new Error(`fixture refused ${url.origin}`);
  }, { preconnect: inner.preconnect }) as typeof fetch;

  const manifest = {
    app_id: "xyz.tinycloud.courier", name: "C2 loopback", space: "agents", prefix: "xyz.tinycloud.courier", defaults: false, includePublicSpace: false, expiry: "2h",
    permissions: [{ service: "tinycloud.kv", path: "/", actions: ["get", "put", "list", "del", "metadata"] }, { service: "tinycloud.hooks", path: "kv/xyz.tinycloud.courier/", actions: ["subscribe"], skipPrefix: true }],
  };
  const wasm = new nodeSdk.NodeWasmBindings();
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const p of courier.AGENT_GRANT) (abilities[p.service.replace("tinycloud.", "")] ??= {})[p.path!] = [...p.actions];
  async function space(privateKey: string) {
    const signer = new nodeSdk.PrivateKeySigner(privateKey);
    const human = new nodeSdk.TinyCloudNode({ ...courier.nodeOpts(PROD), privateKey, autoCreateSpace: true, manifest } as never);
    await human.signIn();
    return { signer, address: await signer.getAddress(), spaceId: human.spaceId! };
  }
  async function session(privateKey: string, jwk: JsonWebKey) {
    const { signer, address, spaceId } = await space(privateKey);
    const expiresAt = Date.now() + 3_600_000;
    const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: "node.tinycloud.xyz", issuedAt: new Date().toISOString(), expirationTime: new Date(expiresAt).toISOString(), spaceId, jwk });
    const signature = await signer.signMessage(prepared.siwe);
    const done = wasm.completeSessionSetup({ ...prepared, signature });
    if (!(await sdkCore.activateSessionWithHost(PROD, done.delegationHeader)).success) throw new Error("grant activation failed");
    return { address, spaceId, expiresAt, prepared, signature, done };
  }

  // TrustBot side: the owner's real grant to the gateway-derived Courier key.
  const { courierIdentity } = await import("../courier/identity");
  const ownerKey = randomBytes(32).toString("hex");
  const ownerAddress = await new nodeSdk.PrivateKeySigner(ownerKey).getAddress();
  owner = `did:pkh:eip155:1:${ownerAddress.toLowerCase()}`;
  const identity = await courierIdentity(owner);
  const ours = await session(ownerKey, identity.publicJwk);
  const grant: CourierGrant = { expiresAt: ours.expiresAt, raw: {
    delegationHeader: ours.done.delegationHeader, delegationCid: ours.done.delegationCid, spaceId: ours.spaceId, address: ours.address, chainId: 1,
    siwe: ours.prepared.siwe, signature: ours.signature, verificationMethod: `${identity.did}#${identity.did.slice(8)}`, jwk: identity.publicJwk,
  } };
  const { createCourierPeerStore } = await import("../courier/peer-store");
  const { createCourierPairing } = await import("../courier/pairing");
  store = createCourierPeerStore(join(root, "peers"), randomBytes(32));
  pairing = createCourierPairing({ store, grants: { async get() { return grant; }, async put() {}, async delete() {} } });

  // Remote agents: stock Courier CLI profiles, each with its own owner space and agent grant.
  async function remote(name: string) {
    const manager = wasm.createSessionManager();
    const keyId = manager.createSessionKey(name);
    const jwk = keyId && manager.jwk(keyId);
    if (!keyId || !jwk) throw new Error("session key was not created");
    const key = { v: 1, jwk: JSON.parse(jwk), did: manager.getDID(keyId), createdAt: new Date().toISOString() };
    const theirs = await session(randomBytes(32).toString("hex"), key.jwk);
    const ownerDid = `did:pkh:eip155:1:${theirs.address}`;
    const grantJson = { v: 1, delegationHeader: theirs.done.delegationHeader, delegationCid: theirs.done.delegationCid, spaceId: theirs.spaceId, ownerDid, address: theirs.address, chainId: 1, siwe: theirs.prepared.siwe, signature: theirs.signature, verificationMethod: key.did, expiresAt: new Date(theirs.expiresAt).toISOString(), receivedAt: new Date().toISOString() };
    const profile = { version: 3, host: PROD, openkeyHost: PROD, label: name, selfHandle: name, courierDid: key.did.split("#")[0], ownerDid, spaceId: theirs.spaceId, grantExpiresAt: grantJson.expiresAt, status: "ready", peers: {} };
    const home = join(root, name);
    mkdirSync(home, { mode: 0o700 });
    for (const [file, body] of [["profile.json", profile], ["key.json", key], ["grant.json", grantJson]] as const) writeFileSync(join(home, file), JSON.stringify(body), { mode: 0o600 });
    return home;
  }
  const preload = join(root, "rewrite.mjs");
  writeFileSync(preload, rewrite);
  const registry = join(pkg, "test/support/registry-fixture.mjs");
  cli = async (home, ...args) => JSON.parse((await exec(process.env.NODE_BINARY ?? "node", [join(pkg, "dist/cli.js"), ...args], { timeout: 30_000, env: {
    ...process.env, HOME: home, TC_HOME: home, USERPROFILE: home, COURIER_HOME: home, COURIER_TEST_NODE_ORIGIN: host, C2_LOOPBACK_ORIGIN: host,
    NODE_OPTIONS: `--import=${registry} --import=${preload}`,
  } })).stdout);
  [remoteHome, malloryHome] = await Promise.all([remote("remote"), remote("mallory")]);
}, 120_000);

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (node && node.exitCode === null && node.signalCode === null) {
    const exited = new Promise(resolve => node!.once("exit", resolve));
    node.kill("SIGTERM");
    await exited;
  }
  if (log >= 0) closeSync(log);
  if (root) rmSync(root, { recursive: true, force: true });
});

let A: Artifact;
let B: Artifact & { challenge: string };
let C: Artifact;
let malloryC: Artifact;

live("a legacy A without the signed-challenge version is refused with update-Courier guidance", async () => {
  A = await cli(remoteHome, "pair", "start", "trustbot", "--call-me", "remote");
  const { challengeVersion: _, ...legacy } = A;
  expect(await rejected(pairing.pair(owner, JSON.stringify(legacy)))).toEqual({ code: "courier_update_required", status: 426 });
  expect(await store.listPending(owner)).toEqual([]);
}, 60_000);

live("A creates only a pending row whose B carries a fresh challenge of at least 128 bits", async () => {
  const started = await pairing.pair(owner, JSON.stringify(A));
  if (!("pending" in started)) throw new Error("expected a pending pairing");
  expect(started.handle).toBe("remote");
  expect(started.pendingExpiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
  B = JSON.parse(started.acceptArtifact);
  expect(Buffer.from(B.challenge, "base64url").length).toBeGreaterThanOrEqual(16);
  expect(await store.listRuntime(owner)).toEqual([]);
  expect(await rejected(pairing.pair(owner, JSON.stringify(A)))).toEqual({ code: "duplicate", status: 409 });

  const malloryA = await cli(malloryHome, "pair", "start", "trustbot", "--call-me", "mallory");
  const mallory = await pairing.pair(owner, JSON.stringify(malloryA));
  if (!("pending" in mallory)) throw new Error("expected a pending pairing");
  expect(JSON.parse(mallory.acceptArtifact).challenge).not.toBe(B.challenge);
  C = await cli(remoteHome, "pair", "accept", started.acceptArtifact);
  malloryC = await cli(malloryHome, "pair", "accept", mallory.acceptArtifact);
}, 90_000);

live("C without a signed completion, or signed by a key other than the peer DID's, is refused", async () => {
  const { completion: _, ...unsigned } = C;
  for (const forged of [
    unsigned,
    { ...C, completion: malloryC.completion },
    { ...C, completion: { ...C.completion!, x: malloryC.completion!.x } },
    { ...C, completion: { ...C.completion!, signature: malloryC.completion!.signature } },
  ]) expect(await rejected(pairing.pair(owner, JSON.stringify(forged)))).toEqual({ code: "invalid", status: 400 });
  expect(await store.listRuntime(owner)).toEqual([]);
  expect((await store.getPending(owner, "remote"))?.pending.handle).toBe("remote");
}, 60_000);

live("the signed context binds the C delegation CID: another grant under a valid completion is refused", async () => {
  expect(await rejected(pairing.pair(owner, JSON.stringify({ ...C, delegation: malloryC.delegation })))).toEqual({ code: "invalid", status: 400 });
  expect(await store.listRuntime(owner)).toEqual([]);
}, 60_000);

live("a valid C cannot finalize a different mailbox, even when the unsigned A copied the peer's identity", async () => {
  const victim = await pairing.pair(owner, JSON.stringify({ ...A, callMe: "victim" }));
  if (!("pending" in victim)) throw new Error("expected a pending pairing");
  expect(await rejected(pairing.pair(owner, JSON.stringify({ ...C, callMe: "victim" })))).toEqual({ code: "invalid", status: 400 });
  expect(await store.listRuntime(owner)).toEqual([]);
}, 60_000);

live("concurrent finalization of one C succeeds once and consumes the challenge", async () => {
  const results = await Promise.allSettled([pairing.pair(owner, JSON.stringify(C)), pairing.pair(owner, JSON.stringify(C))]);
  const paired = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  const refused = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  expect(paired).toHaveLength(1);
  expect(paired[0]).toMatchObject({ peer: { handle: "remote", status: "paired" } });
  expect(refused).toEqual([expect.objectContaining({ code: "duplicate", status: 409 })]);
  const [runtime] = await store.listRuntime(owner);
  expect(runtime!.proof.cid.length).toBeGreaterThan(0);
  expect(runtime!.delegationExpiresAt).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
  expect(await store.getPending(owner, "remote")).toBeUndefined();
}, 90_000);

live("after unpair, the old C is refused against a new challenge and never reactivates intake", async () => {
  await pairing.unpair(owner, "remote");
  expect(await store.listRuntime(owner)).toEqual([]);
  const fresh = await pairing.pair(owner, JSON.stringify(A));
  if (!("pending" in fresh)) throw new Error("expected a pending pairing");
  expect(JSON.parse(fresh.acceptArtifact).challenge).not.toBe(B.challenge);
  expect(await rejected(pairing.pair(owner, JSON.stringify(C)))).toEqual({ code: "invalid", status: 400 });
  expect(await store.listRuntime(owner)).toEqual([]);
  expect(await store.list(owner)).toEqual([]);
}, 90_000);
