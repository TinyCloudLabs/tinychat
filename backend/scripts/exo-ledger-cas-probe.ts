/**
 * TC-1013 S4b real-node KV conditional-write probe. Skipped unless EXO_PROBE_NODE_URL is set; never run in CI.
 *
 * Checks the node's if-none-match / if-match behavior on the KV service for the owner space, the
 * backend's applications space, and a delegate holding the exo jobs grant. Each check prints one
 * `PROBE <name>: <expected> -> <observed>` line. Keys stay in process memory; nothing is written to disk.
 * Every key written is deleted at the end.
 *
 * Only loopback nodes (127.0.0.1, [::1], localhost) are accepted. EXO_PROBE_ALLOW_REMOTE_NODE=yes-i-know
 * admits another host. The guard runs before any network call.
 */
import { randomUUID } from "node:crypto";
import { TinyCloudNode, type Manifest, type PortableDelegation } from "@tinycloud/node-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EXO_JOBS_PREFIX } from "../src/delegation-verify.js";
import { checkProbeNodeUrl } from "./exo-probe-host-guard.js";

const rawHost = process.env.EXO_PROBE_NODE_URL;
if (!rawHost) {
  console.log("SKIP: EXO_PROBE_NODE_URL not set");
  process.exit(0);
}
const hostCheck = checkProbeNodeUrl(rawHost, process.env.EXO_PROBE_ALLOW_REMOTE_NODE);
if (!hostCheck.ok) {
  console.log(`REFUSED: ${hostCheck.reason}`);
  process.exit(2);
}
const host = rawHost;

// Reads one field from an SDK return value without asserting its shape.
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

// Each call returns the SDK Result or the thrown error, so a probe line can show either.
async function attempt(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return error;
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return `threw ${value.message.slice(0, 120)}`;
  if (fieldOf(value, "ok") !== false) return "ALLOWED";
  const code = fieldOf(fieldOf(value, "error"), "code");
  const message = fieldOf(fieldOf(value, "error"), "message");
  const text = typeof message === "string" ? message.slice(0, 160) : "";
  return `REFUSED ${typeof code === "string" ? code : "unknown"} (${text})`;
}

async function probe(name: string, expected: string, run: () => Promise<unknown>): Promise<unknown> {
  const value = await attempt(run);
  console.log(`PROBE ${name}: ${expected} -> ${describe(value)}`);
  return value;
}

// Returns the strong etag from a network get; throws when absent so a write is never silently unconditional.
function requireEtag(getResult: unknown, label: string): string {
  const etag = fieldOf(fieldOf(fieldOf(getResult, "data"), "headers"), "etag");
  if (typeof etag !== "string") throw new Error(`${label}: network get returned no etag`);
  return etag;
}

const ownerKey = generatePrivateKey();
const ownerAddress = privateKeyToAccount(ownerKey).address;
const manifest: Manifest = {
  manifest_version: 1,
  app_id: "xyz.tinycloud.tinychat.exo-cas-probe",
  name: "TinyCloud exo CAS probe",
  description: "Throwaway probe owner for conditional KV writes.",
  defaults: false,
  includePublicSpace: false,
  space: "applications",
  prefix: "",
  expiry: "1h",
  permissions: [
    { service: "tinycloud.kv", space: "applications", path: EXO_JOBS_PREFIX, actions: ["get", "put", "del"], skipPrefix: true },
    { service: "tinycloud.encryption", path: `urn:tinycloud:encryption:did:pkh:eip155:1:${ownerAddress}:default`, actions: ["network.create"] },
  ],
};
const owner = new TinyCloudNode({ privateKey: ownerKey, host, prefix: "probe.cas.owner", autoCreateSpace: true, manifest });
const backendKey = generatePrivateKey();
const backendDid = `did:pkh:eip155:1:${privateKeyToAccount(backendKey).address.toLowerCase()}`;
const backend = new TinyCloudNode({ privateKey: backendKey, host, prefix: "probe.cas.backend", autoCreateSpace: false });

// Cleanup closures, so each key is deleted through the same handle that wrote it.
const written: Array<{ label: string; remove: () => Promise<unknown> }> = [];

async function main(): Promise<void> {
  try {
    await owner.signIn();
    await backend.signIn();
    const chainId = owner.session?.chainId;
    if (chainId === undefined) throw new Error("owner session has no chain");
    const spaceId = await owner.ensureOwnedSpaceHosted("applications");
    await owner.ensureEncryptionNetwork("default");
    const ownerSpace = owner.space(spaceId);

    // Owner-space conditional writes.
    const ownerKey1 = `${EXO_JOBS_PREFIX}${randomUUID()}`;
    written.push({ label: "owner", remove: () => ownerSpace.kv.delete(ownerKey1) });
    await probe("owner create if-none-match on absent key", "ALLOWED", () => ownerSpace.kv.put(ownerKey1, { w: 1 }, { ifNoneMatch: "*" }));
    await probe("owner create if-none-match on present key", "REFUSED KV_PRECONDITION_FAILED", () => ownerSpace.kv.put(ownerKey1, { w: 2 }, { ifNoneMatch: "*" }));
    const got1 = await probe("owner network get for etag", "ALLOWED", () => ownerSpace.kv.get(ownerKey1, { source: "network" }));
    const etag1 = requireEtag(got1, "owner");
    console.log(`PROBE owner etag shape: strong-etag -> ${etag1.startsWith("W/") ? "weak" : "strong"}`);
    await probe("owner if-match with current etag", "ALLOWED", () => ownerSpace.kv.put(ownerKey1, { w: 3 }, { ifMatch: etag1 }));
    await probe("owner if-match with now-stale etag", "REFUSED KV_PRECONDITION_FAILED", () => ownerSpace.kv.put(ownerKey1, { w: 4 }, { ifMatch: etag1 }));
    await probe("owner combined ifMatch and ifNoneMatch", "REFUSED INVALID_INPUT", () =>
      ownerSpace.kv.put(ownerKey1, { w: 5 }, { ifMatch: etag1, ifNoneMatch: "*" }));
    const got2 = await probe("owner network get after write", "ALLOWED", () => ownerSpace.kv.get(ownerKey1, { source: "network" }));
    const etag2 = requireEtag(got2, "owner");
    const race = await Promise.all([
      attempt(() => ownerSpace.kv.put(ownerKey1, { w: "a" }, { ifMatch: etag2 })),
      attempt(() => ownerSpace.kv.put(ownerKey1, { w: "b" }, { ifMatch: etag2 })),
    ]);
    const outcomes = race.map((value) => describe(value));
    const winners = outcomes.filter((text) => text === "ALLOWED").length;
    const losers = outcomes.filter((text) => text !== "ALLOWED");
    const loserText = losers.every((text) => text.includes("KV_PRECONDITION_FAILED")) ? "KV_PRECONDITION_FAILED" : losers.join(" | ");
    console.log(`PROBE owner two concurrent if-match writers: exactly-one-wins -> winners=${winners} losers=${losers.length} loser=${loserText}`);
    await probe("owner network get with 4-byte response bound", "REFUSED KV_RESPONSE_TOO_LARGE", () => ownerSpace.kv.get(ownerKey1, { source: "network", maxResponseBytes: 4 }));

    // Backend-space conditional writes on the backend's applications space (hosted explicitly: the backend key has no space yet).
    const backendSpaceId = await backend.ensureOwnedSpaceHosted("applications");
    const backendSpace = backend.space(backendSpaceId);
    const backendKey1 = `probe-cas/${randomUUID()}`;
    written.push({ label: "backend", remove: () => backendSpace.kv.delete(backendKey1) });
    await probe("backend create if-none-match on absent key", "ALLOWED", () => backendSpace.kv.put(backendKey1, { w: 1 }, { ifNoneMatch: "*" }));
    await probe("backend create if-none-match on present key", "REFUSED KV_PRECONDITION_FAILED", () => backendSpace.kv.put(backendKey1, { w: 2 }, { ifNoneMatch: "*" }));
    const backendGot = await probe("backend network get for etag", "ALLOWED", () => backendSpace.kv.get(backendKey1, { source: "network" }));
    const backendEtag = requireEtag(backendGot, "backend");
    await probe("backend if-match with current etag", "ALLOWED", () => backendSpace.kv.put(backendKey1, { w: 3 }, { ifMatch: backendEtag }));
    await probe("backend if-match with now-stale etag", "REFUSED KV_PRECONDITION_FAILED", () => backendSpace.kv.put(backendKey1, { w: 4 }, { ifMatch: backendEtag }));

    // Delegate holding the exo jobs grant (get/put/del on the jobs prefix only).
    const { delegation } = await owner.delegateTo(
      backendDid,
      [{ service: "tinycloud.kv", space: "applications", path: EXO_JOBS_PREFIX, actions: ["get", "put", "del"], skipPrefix: true }],
      { expiry: "1h" },
    );
    const portable: PortableDelegation = { ...delegation, ownerAddress, chainId, host };
    const actions = ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"];
    const delegate = await backend.useDelegation({
      cid: portable.cid,
      delegationHeader: portable.delegationHeader,
      spaceId,
      path: EXO_JOBS_PREFIX,
      actions,
      resources: [{ service: "kv", space: spaceId, path: EXO_JOBS_PREFIX, actions }],
      expiry: portable.expiry,
      delegateDID: backendDid,
      ownerAddress,
      chainId,
      host,
    });
    const delegateKey = randomUUID();
    written.push({ label: "delegate", remove: () => delegate.kv.delete(delegateKey) });
    await probe("delegate create if-none-match under exo jobs grant", "ALLOWED", () => delegate.kv.put(delegateKey, { state: "queued" }, { ifNoneMatch: "*" }));
    await probe("delegate create if-none-match on present key", "REFUSED KV_PRECONDITION_FAILED", () => delegate.kv.put(delegateKey, { state: "x" }, { ifNoneMatch: "*" }));
    const dGot = await probe("delegate network get for etag", "ALLOWED", () => delegate.kv.get(delegateKey, { source: "network" }));
    const dEtag = requireEtag(dGot, "delegate");
    await probe("delegate if-match with current etag", "ALLOWED", () => delegate.kv.put(delegateKey, { state: "running" }, { ifMatch: dEtag }));
    await probe("delegate if-match with now-stale etag", "REFUSED KV_PRECONDITION_FAILED", () => delegate.kv.put(delegateKey, { state: "done" }, { ifMatch: dEtag }));
  } finally {
    for (const entry of written) {
      const value = await attempt(entry.remove);
      console.log(`CLEANUP ${entry.label} delete: ${describe(value)}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    const message = error instanceof Error ? error.message.slice(0, 200) : "non-error";
    console.log(`PROBE run: ERROR -> ${message}`);
    process.exit(1);
  },
);
