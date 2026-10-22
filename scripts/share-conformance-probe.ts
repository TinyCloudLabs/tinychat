/**
 * Share conformance probe.
 *
 * Runs against a local TinyCloud node that you start yourself. Skipped unless
 * SHARE_PROBE_NODE_URL is set, and only loopback hosts are accepted.
 *
 *   SHARE_PROBE_NODE_URL=http://127.0.0.1:<port> bun run scripts/share-conformance-probe.ts
 *
 * Keys are generated in memory for each run and are never written to disk.
 * Every check prints one line:
 *   PROBE <name>: <expected> -> <ALLOWED|REFUSED|ERROR> HTTP=<statuses> code=<code> marker=<name|none>
 * Exits 1 if a refused check returns a seeded marker.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  KVService,
  NodeWasmBindings,
  SQLService,
  ServiceContext,
  TinyCloudNode,
  type Manifest,
  type PortableDelegation,
  type ServiceSession,
} from "@tinycloud/node-sdk";

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const nodeUrlRaw = process.env.SHARE_PROBE_NODE_URL;
if (!nodeUrlRaw) {
  print("share conformance probe: skipped (SHARE_PROBE_NODE_URL not set)");
  process.exit(0);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const nodeUrl = new URL(nodeUrlRaw);
if (!["http:", "https:"].includes(nodeUrl.protocol) || !LOOPBACK_HOSTS.has(nodeUrl.hostname)) {
  print("share conformance probe: refused, SHARE_PROBE_NODE_URL must be a loopback http(s) URL");
  process.exit(1);
}
const host = nodeUrl.origin;

// SDK diagnostics are silenced so that only probe lines reach the output.
const quiet = (): void => {};
console.log = quiet;
console.warn = quiet;
console.error = quiet;
console.info = quiet;
console.debug = quiet;

// Every request the probe makes must stay on loopback.
const originalFetch = globalThis.fetch;
let httpStatuses: number[] = [];
// Bun's fetch type carries a `preconnect` member that this wrapper omits.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!LOOPBACK_HOSTS.has(target.hostname)) throw new Error("non-loopback request refused");
  const res = await originalFetch(input, init);
  httpStatuses.push(res.status);
  return res;
}) as unknown as typeof fetch;

type Outcome = { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } };
type Session = ServiceSession;
type ManifestFile = { permissions: Array<{ service: string; path: string; actions: string[] }> } & Record<string, unknown>;

const APP = "xyz.tinycloud.tinychat";
const THREADS = `${APP}/threads`;
const SHARE_PREFIX = `${THREADS}/shares/`;
const INDEX_PREFIX = `${THREADS}/share-index/`;

const idA = randomUUID();
const keyA = SHARE_PREFIX + idA;
const bId = randomUUID();
const keyB = SHARE_PREFIX + bId;
const threadId = randomUUID();
const threadKey = `${THREADS}/${threadId}`;
const indexKeyA = INDEX_PREFIX + idA;

// One unguessable marker per seeded value. A refused check must never return any of them.
const markers = {
  A: `MARK-A-${randomUUID()}`,
  B: `MARK-B-${randomUUID()}`,
  X: `MARK-X-${randomUUID()}`,
  EVIL: `MARK-EVIL-${randomUUID()}`,
  C: `MARK-C-${randomUUID()}`,
  T: `MARK-T-${randomUUID()}`,
  I: `MARK-I-${randomUUID()}`,
};
type MarkerName = keyof typeof markers;
const leaks: string[] = [];

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
function markerOf(value: unknown): MarkerName | "none" {
  const text = safeStringify(value);
  return (Object.keys(markers) as MarkerName[]).find((name) => text.includes(markers[name])) ?? "none";
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const redact = (text: string): string => text.replace(/0x[0-9a-fA-F]+|[A-Za-z0-9_+/=-]{48,}/g, "[REDACTED]").slice(0, 700);
const httpLine = (): string => (httpStatuses.length ? httpStatuses.join(",") : "no-http");

async function probe(name: string, expected: string, run: () => Promise<Outcome>): Promise<Outcome> {
  httpStatuses = [];
  let outcome: Outcome;
  try {
    outcome = await run();
  } catch (error: unknown) {
    print(`DETAIL ${name}: ${redact(messageOf(error))}`);
    print(`PROBE ${name}: ${expected} -> ERROR HTTP=${httpLine()} code=SDK_EXCEPTION marker=none`);
    return { ok: false, error: { code: "SDK_EXCEPTION" } };
  }
  const allowed = outcome.ok !== false;
  if (!allowed && outcome.error?.message) print(`DETAIL ${name}: ${redact(outcome.error.message)}`);
  const marker = markerOf(outcome.data);
  if (!allowed && marker !== "none") leaks.push(name);
  const code = allowed ? "OK" : (outcome.error?.code ?? "UNKNOWN");
  print(`PROBE ${name}: ${expected} -> ${allowed ? "ALLOWED" : "REFUSED"} HTTP=${httpLine()} code=${code} marker=${marker}`);
  return outcome;
}

function need(outcome: Outcome): unknown {
  if (outcome.ok === false) throw new Error(`SDK_RESULT_${outcome.error?.code ?? "unknown"}`);
  return outcome.data;
}

function shareTokenOf(value: unknown): string {
  if (value && typeof value === "object" && "token" in value && typeof value.token === "string") return value.token;
  throw new Error("share grant returned no token");
}

function parseManifest(text: string): ManifestFile {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { permissions?: unknown }).permissions)) {
    throw new Error("manifest.json has no permissions array");
  }
  return parsed as ManifestFile;
}

// The viewer authenticates with the share delegation header the SDK returns for the link.
function viewerAuthorization(delegation: { cid: string }): string {
  const header: unknown = Reflect.get(delegation, "authHeader");
  if (typeof header === "string") return header;
  if (header && typeof header === "object" && "Authorization" in header && typeof header.Authorization === "string") {
    return header.Authorization;
  }
  return `Bearer ${delegation.cid}`;
}

const wasm = new NodeWasmBindings();
function serviceContext(session: Session, serviceHost: string): ServiceContext {
  const context = new ServiceContext({ invoke: wasm.invoke, fetch: globalThis.fetch.bind(globalThis), hosts: [serviceHost] });
  context.setSession(session);
  return context;
}
function kvFor(session: Session, serviceHost: string): KVService {
  const kv = new KVService({});
  kv.initialize(serviceContext(session, serviceHost));
  return kv;
}

async function main(): Promise<void> {
  // Same repo manifest the app serves; `space` is the only addition.
  const manifestFile = parseManifest(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  // The SDK types the manifest as its own Manifest; the repo file is parsed JSON with the same keys.
  const manifest = { ...manifestFile, space: "applications" } as unknown as Manifest;
  const kvGrants = manifestFile.permissions.filter((p) => p.service === "tinycloud.kv");
  print(`MANIFEST kv ${JSON.stringify(kvGrants.map((p) => ({ path: p.path, actions: p.actions })))}`);

  const owner = new TinyCloudNode({ privateKey: `0x${randomBytes(32).toString("hex")}`, host, autoCreateSpace: true, manifest });
  await owner.signIn();
  await owner.ensureOwnedSpaceHosted("applications");
  print("SETUP owner key generated in memory; synthetic values only");

  const snapshot = (title: string, marker: string): string =>
    JSON.stringify({ format: "tinychat.share.snapshot", version: 1, title, messages: [{ role: "user", text: marker }] });
  const seeds: Array<[string, string, string]> = [
    ["A", keyA, snapshot("Synthetic thread A", markers.A)],
    ["B", keyB, snapshot("Synthetic thread B", markers.B)],
    ["X", `${keyA}x`, snapshot("Synthetic prefix suffix", markers.X)],
    ["EVIL", `${keyA}-evil`, snapshot("Synthetic dash suffix", markers.EVIL)],
    ["C", `${keyA}/child`, snapshot("Synthetic child path", markers.C)],
    ["T", threadKey, snapshot("Synthetic normal thread", markers.T)],
    ["I", indexKeyA, JSON.stringify({ marker: markers.I })],
  ];
  for (const [name, key, value] of seeds) {
    need(await probe(`ownerWrite${name} control`, "ALLOWED", () => owner.kv.put(key, value)));
  }
  need(await probe("ownerReadA control", "ALLOWED", () => owner.kv.get(keyA, { source: "network" })));

  const expiry = new Date(Date.now() + 7 * 86400 * 1000);
  const token = shareTokenOf(need(await probe("createShareA", "ALLOWED", () =>
    owner.sharing.generate({ path: keyA, actions: ["tinycloud.kv/get"], expiry, description: "Synthetic thread A" }),
  )));
  const link = owner.sharing.decodeLink(token);
  const delegation = link.delegation;
  print(`TOKEN_PATH ${JSON.stringify({ path: link.path, actions: delegation.actions })}`);

  const viewerSession = {
    delegationHeader: { Authorization: viewerAuthorization(delegation) },
    delegationCid: delegation.cid,
    spaceId: link.spaceId,
    verificationMethod: link.keyDid,
    jwk: link.key,
  } as Session;
  const viewerKv = kvFor(viewerSession, link.host);
  print("SETUP viewer session restored from the share token only; no owner key or owner session");
  await probe("viewerReadA", "ALLOWED", () => viewerKv.get(keyA, { source: "network" }));

  // Traversal and encoding toward B, the owner index, and a normal thread key.
  await probe("viewerReadBTraversalDotDot", "REFUSED", () => viewerKv.get(`${keyA}/../${bId}`, { source: "network" }));
  await probe("viewerReadBTraversalEncoded", "REFUSED", () => viewerKv.get(`${keyA}/%2e%2e/${bId}`, { source: "network" }));
  await probe("viewerReadBTraversalDoubleSlash", "REFUSED", () => viewerKv.get(`${SHARE_PREFIX}/${bId}`, { source: "network" }));
  await probe("viewerReadBDirect", "REFUSED", () => viewerKv.get(keyB, { source: "network" }));
  await probe("viewerReadIndexTraversal", "REFUSED", () => viewerKv.get(`${SHARE_PREFIX}../share-index/${idA}`, { source: "network" }));
  await probe("viewerReadIndexDirect", "REFUSED", () => viewerKv.get(indexKeyA, { source: "network" }));
  await probe("viewerReadThreadTraversal", "REFUSED", () => viewerKv.get(`${keyA}/../../${threadId}`, { source: "network" }));
  await probe("viewerReadThreadDirect", "REFUSED", () => viewerKv.get(threadKey, { source: "network" }));

  // Prefix confusion. The grant path has no trailing slash, so it is a prefix grant covering shares/<A>/.
  await probe("viewerReadAPrefixSuffix", "REFUSED", () => viewerKv.get(`${keyA}x`, { source: "network" }));
  await probe("viewerReadADashSuffix", "REFUSED", () => viewerKv.get(`${keyA}-evil`, { source: "network" }));
  await probe("viewerReadAChildPath", "REPORT", () => viewerKv.get(`${keyA}/child`, { source: "network" }));

  // SQL threads database and other spaces, with the same share token.
  const viewerSql = new SQLService({});
  viewerSql.initialize(serviceContext(viewerSession, link.host));
  await probe("viewerSqlThreadsDatabase", "REFUSED", () =>
    viewerSql.db(THREADS).query("SELECT name FROM sqlite_master WHERE type = ?", ["table"]),
  );
  const shareSpace = link.spaceId;
  if (!shareSpace.endsWith(":applications")) throw new Error("unexpected share spaceId format");
  const baseSpace = shareSpace.slice(0, -":applications".length);
  for (const space of ["default", "secrets"]) {
    const spaceKv = kvFor({ ...viewerSession, spaceId: `${baseSpace}:${space}` } as Session, link.host);
    await probe(`viewerReadASpace_${space}`, "REFUSED", () => spaceKv.get(keyA, { source: "network" }));
  }

  // Child sub-delegation through the SDK. The SDK refuses this in session-only mode.
  const viewerNode = new TinyCloudNode({ host: link.host, autoCreateSpace: false });
  await viewerNode.restoreSession(viewerSession);
  print(`MODE viewerNode sessionOnly=${String(viewerNode.isSessionOnly)}`);
  // The share link delegation is the encoded form; the cast only lets the call reach the SDK's session-only refusal.
  await probe("viewerSubDelegationSdk", "REPORT", () =>
    viewerNode.createSubDelegation(delegation as unknown as PortableDelegation, { path: keyA, actions: ["tinycloud.kv/get"], delegateDID: owner.did }).then((v) => ({ ok: true, data: v })),
  );
  print("NOT RUN child rows: raw POST /delegate with prf:[parentCid] is not built by this script");

  // Revoke from a later owner session that was restored from a saved session.
  const ownerSession = owner.restorableSession;
  if (!ownerSession) throw new Error("owner restorableSession missing");
  const laterOwner = new TinyCloudNode({ host: link.host, autoCreateSpace: false, manifest });
  await laterOwner.restoreSession(ownerSession);
  print(`MODE laterOwner sessionOnly=${String(laterOwner.isSessionOnly)}`);
  await probe("revokeShareFromLaterOwnerSession", "REPORT", () => laterOwner.revokeDelegation(delegation.cid));
  await probe("viewerReadAAfterLaterRevokeAttempt", "REPORT", () => viewerKv.get(keyA, { source: "network" }));
  await probe("revokeShareAsOwnerPrimary", "ALLOWED", () => owner.revokeDelegation(delegation.cid));
  await probe("revokeShareTwice", "REPORT", () => owner.revokeDelegation(delegation.cid));
  await probe("ownerReadAAfterRevoke control", "ALLOWED", () => owner.kv.get(keyA, { source: "network" }));
  await probe("viewerReadAAfterRevoke", "REFUSED", () => viewerKv.get(keyA, { source: "network" }));
  print("IDENTIFIER revocation receives the delegation CID only; the share key is not supplied");

  print(`ASSERT refused checks carry no marker: ${leaks.length === 0 ? "PASS" : `FAIL ${leaks.join(",")}`}`);
  if (leaks.length > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    print(`RUN_ERROR ${redact(messageOf(error))}`);
    process.exit(1);
  },
);
