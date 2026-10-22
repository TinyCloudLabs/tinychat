/**
 * TC-1013 S4a real-node probe. Skipped unless EXO_PROBE_NODE_URL is set; never run in CI.
 *
 * The owner signs in with an in-memory throwaway key and delegates the exo sync grant to a
 * throwaway backend DID. The real verifier and activateVerifiedDelegation run on the backend
 * side. Each check prints one `PROBE <name>: <expected> -> <observed>` line. Keys stay in
 * process memory; nothing is written to disk. Every key written is deleted at the end.
 */
import { randomUUID } from "node:crypto";
import { APP_ID, CONNECTORS_SQL_DB_NAME } from "@tinyboilerplate/core";
import { isKvMissingKeyResult } from "@tinyboilerplate/server";
import { serializeDelegation, TinyCloudNode, type Manifest, type PermissionEntry, type PortableDelegation } from "@tinycloud/node-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EXO_JOBS_PREFIX, EXO_REQUESTS_PREFIX, EXO_SYNC_RESOURCES, verifyTranscriptWriterGrant } from "../src/delegation-verify.js";
import { activateVerifiedDelegation } from "../src/portable-delegation.js";
import { createExoActivatedGrant, ownerApplicationsSpaceUri } from "../src/exo/activated-grant.js";

const host = process.env.EXO_PROBE_NODE_URL;
if (!host) {
  console.log("SKIP: EXO_PROBE_NODE_URL not set");
  process.exit(0);
}

type Resource = { path: string; actions: readonly string[] };

// The owner's sign-in recap must cover every KV path the probe sub-delegates. Without it the SDK
// takes the wallet-CACAO path (no session-key JWT), and the verifier refuses with session_mismatch.
const ownerManifest = (encryptionNetworkId: string): Manifest => ({
  manifest_version: 1,
  app_id: "xyz.tinycloud.tinychat.exo-probe",
  name: "TinyCloud exo grant probe",
  description: "Throwaway probe owner for the exo sync grant.",
  defaults: false,
  includePublicSpace: false,
  space: "applications",
  prefix: "",
  expiry: "1h",
  permissions: [
    { service: "tinycloud.kv", space: "applications", path: EXO_REQUESTS_PREFIX, actions: ["get", "list", "del", "put"], skipPrefix: true },
    { service: "tinycloud.kv", space: "applications", path: EXO_JOBS_PREFIX, actions: ["get", "put", "del"], skipPrefix: true },
    { service: "tinycloud.kv", space: "applications", path: `${APP_ID}/`, actions: ["get", "put", "del"], skipPrefix: true },
    { service: "tinycloud.encryption", path: encryptionNetworkId, actions: ["network.create"] },
  ],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function refusal(value: unknown): string {
  if (value instanceof Error) return `threw ${value.message.slice(0, 120)}`;
  if (isRecord(value) && isRecord(value.error) && typeof value.error.code === "string") return value.error.code;
  return "unknown";
}

async function observe(run: () => Promise<unknown>, key?: string): Promise<string> {
  try {
    const result = await run();
    if (key !== undefined && isKvMissingKeyResult(result, key)) return "ALLOWED key-not-found";
    if (isRecord(result) && result.ok === false) return `REFUSED ${refusal(result)}`;
    return "ALLOWED";
  } catch (error) {
    return `REFUSED ${refusal(error)}`;
  }
}

async function probe(name: string, expected: string, run: () => Promise<unknown>): Promise<void> {
  console.log(`PROBE ${name}: ${expected} -> ${await observe(run)}`);
}

type ResultLike<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

// Throws the SDK Result error with its message, so the probe line shows the refusal reason, not only the code.
function unwrap<T>(result: ResultLike<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

// Logs status of each SDK fetch to a decrypt route: method, path, status. No body, headers, or keys.
function traceDecryptRoutes(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await original(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/decrypt")) console.log(`TRACE ${init?.method ?? "GET"} ${url.pathname} -> ${response.status}`);
    return response;
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

async function main(): Promise<void> {
  const ownerKey = generatePrivateKey();
  const ownerNetworkId = `urn:tinycloud:encryption:did:pkh:eip155:1:${privateKeyToAccount(ownerKey).address}:default`;
  const owner = new TinyCloudNode({ privateKey: ownerKey, host, prefix: "probe.owner", autoCreateSpace: true, manifest: ownerManifest(ownerNetworkId) });
  const backendKey = generatePrivateKey();
  const backendDid = `did:pkh:eip155:1:${privateKeyToAccount(backendKey).address.toLowerCase()}`;
  const backend = new TinyCloudNode({ privateKey: backendKey, host, prefix: "probe.backend", autoCreateSpace: false });

  let spaceId = "";
  const written = new Set<string>();
  const track = (key: string): string => {
    written.add(key);
    return key;
  };

  try {
    await owner.signIn();
    await backend.signIn();
    const session = owner.session;
    const ownerAddress = owner.address;
    const chainId = session?.chainId;
    if (!session || !ownerAddress || chainId === undefined) throw new Error("owner session has no address or chain");
    spaceId = await owner.ensureOwnedSpaceHosted("applications");
    await owner.ensureEncryptionNetwork("default");
    console.log(`PROBE owner encryption network create: ok -> networkId=${ownerNetworkId}`);
    const space = owner.space(spaceId);

    const toPermissions = (resources: readonly Resource[]): PermissionEntry[] =>
      resources.map(({ path, actions }) => ({
        service: "tinycloud.kv",
        space: "applications",
        path,
        actions: actions.map((action) => action.replace("tinycloud.kv/", "")),
        skipPrefix: true,
      }));

    const mint = async (resources: readonly Resource[]): Promise<PortableDelegation> => {
      const { delegation } = await owner.delegateTo(backendDid, toPermissions(resources), { expiry: "1h" });
      return { ...delegation, ownerAddress, chainId, host };
    };

    const accessFor = (delegation: PortableDelegation, path: string, actions: string[], targetSpace = spaceId) =>
      backend.useDelegation({
        cid: delegation.cid,
        delegationHeader: delegation.delegationHeader,
        spaceId: targetSpace,
        path,
        actions,
        resources: [{ service: "kv", space: targetSpace, path, actions }],
        expiry: delegation.expiry,
        delegateDID: backendDid,
        ownerAddress,
        chainId,
        host,
      });

    const THREAD = track(`${APP_ID}/threads/probe-seed`);
    const CONN = track(`${APP_ID}/connectors/probe-seed`);
    const REQ = track(`${EXO_REQUESTS_PREFIX}sync-meetings/${randomUUID()}`);
    const JOB = track(`${EXO_JOBS_PREFIX}${randomUUID()}`);
    const JOB_NEW = track(`${EXO_JOBS_PREFIX}${randomUUID()}`);
    await space.kv.put(THREAD, { seed: true });
    await space.kv.put(CONN, { seed: true });
    await space.kv.put(REQ, { kind: "sync-meetings" });
    await space.kv.put(JOB, { state: "queued" });

    const mainPortable = await mint(EXO_SYNC_RESOURCES);
    const verdict = await verifyTranscriptWriterGrant(
      {
        serialized: serializeDelegation(mainPortable),
        siwe: session.siwe,
        signature: session.signature,
        address: ownerAddress,
        backendDid,
        configuredHost: host,
        policy: "exo-sync",
      },
      { computeDelegationCid: (authorization) => backend.computeDelegationCid(authorization) },
    );
    console.log(`PROBE verifier exo-sync grant: ok -> ${verdict.ok ? "ok" : verdict.code}`);
    if (!verdict.ok) throw new Error(`verifier refused: ${verdict.code}`);

    const access = await activateVerifiedDelegation(backend, verdict.verified, { host });
    console.log(`PROBE activate exo-sync grant: ok -> kv=${access.kv !== undefined}`);
    const exo = createExoActivatedGrant({ kv: access.kv }, verdict.verified);

    await probe("accessor requestsGet seeded request", "ALLOWED", () => exo.requestsGet(REQ));
    await probe("accessor requestsList request directory", "ALLOWED", () => exo.requestsList(`${EXO_REQUESTS_PREFIX}sync-meetings/`));
    await probe("accessor jobsGet seeded job", "ALLOWED", () => exo.jobsGet(JOB));
    await probe("accessor jobsPut new job", "ALLOWED", () => exo.jobsPut(JOB_NEW, { state: "queued" }));
    await probe("accessor jobsRemove new job", "ALLOWED", () => exo.jobsRemove(JOB_NEW));
    await probe("accessor requestsRemove seeded request", "ALLOWED", () => exo.requestsRemove(REQ));
    await probe("accessor requestsGet traversal", "REFUSED before kv", () => exo.requestsGet(`${EXO_REQUESTS_PREFIX}../threads/probe-seed`));
    await probe("accessor requestsList bare prefix", "REFUSED before kv", () => exo.requestsList(`${APP_ID}/exo/v1/requests`));

    const requestsRaw = await accessFor(mainPortable, EXO_REQUESTS_PREFIX, [...EXO_SYNC_RESOURCES[0].actions]);
    const jobsRaw = await accessFor(mainPortable, EXO_JOBS_PREFIX, [...EXO_SYNC_RESOURCES[1].actions]);
    const newRequestKey = `sync-meetings/${randomUUID()}`;
    track(`${EXO_REQUESTS_PREFIX}${newRequestKey}`);
    await probe("node requests kv.put new key", "REFUSED", () => requestsRaw.kv.put(newRequestKey, {}));
    await probe("node requests kv.get threads seed", "REFUSED", () => requestsRaw.kv.get("../threads/probe-seed"));
    await probe("node requests kv.get connectors seed", "REFUSED", () => requestsRaw.kv.get("../connectors/probe-seed"));
    await probe("node requests kv.list app root", "REFUSED", () => requestsRaw.kv.list({ prefix: "../" }));
    await probe("node requests kv.get prefix requestsX", "REFUSED", () => requestsRaw.kv.get("../requestsX/a"));
    await probe("node jobs kv.put prefix jobs-evil", "REFUSED", () => jobsRaw.kv.put("../jobs-evil/a", {}));
    await probe("node jobs kv.get prefix requests", "REFUSED", () => jobsRaw.kv.get(`../requests/${randomUUID()}`));
    await probe("node requests kv.get pct-encoded threads seed", "REFUSED", () => requestsRaw.kv.get("%2e%2e/threads/probe-seed"));
    await probe("node requests kv.get double-slash threads seed", "REFUSED", () => requestsRaw.kv.get("/../threads/probe-seed"));
    await probe("node jobs kv.get traversal connectors seed", "REFUSED", () => jobsRaw.kv.get("../connectors/probe-seed"));
    await probe("node jobs kv.get pct-encoded connectors seed", "REFUSED", () => jobsRaw.kv.get("%2e%2e/connectors/probe-seed"));

    const otherSpace = (name: string) => spaceId.replace(/applications$/, name);
    await probe("node default-space kv.get", "REFUSED", async () =>
      (await accessFor(mainPortable, EXO_REQUESTS_PREFIX, ["tinycloud.kv/get"], otherSpace("default"))).kv.get("probe-x"));
    await probe("node secrets-space kv.get", "REFUSED", async () =>
      (await accessFor(mainPortable, EXO_REQUESTS_PREFIX, ["tinycloud.kv/get"], otherSpace("secrets"))).kv.get("probe-x"));
    await probe("node sql db query under exo grant", "REFUSED", () => access.sql.db(CONNECTORS_SQL_DB_NAME).query("SELECT 1", []));
    const plaintext = new TextEncoder().encode("tc1013-probe-plaintext");
    const envelope = unwrap(await owner.encryption.encryptToNetwork(ownerNetworkId, plaintext));
    console.log("PROBE owner encrypt for decrypt rows: ok -> envelope");
    const restoreFetch = traceDecryptRoutes();
    const ownerSecretName = `TC1013_PROBE_OWNER_${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    await probe("node encryption decrypt control (owner via secrets.get)", "ALLOWED", async () => {
      unwrap(await owner.secrets.put(ownerSecretName, "tc1013-probe-secret"));
      try {
        const value = unwrap(await owner.secrets.get(ownerSecretName));
        if (value !== "tc1013-probe-secret") throw new Error("secret mismatch");
        return value;
      } finally {
        unwrap(await owner.secrets.delete(ownerSecretName));
      }
    });
    await probe("node encryption decrypt control (owner grant + decryptEnvelope)", "ALLOWED", async () => {
      const [grant] = await owner.grantRuntimePermissions([{ service: "tinycloud.encryption", path: ownerNetworkId, actions: ["decrypt"], skipPrefix: true }]);
      if (!grant) throw new Error("grantRuntimePermissions returned no delegation");
      const data = unwrap(await owner.encryption.decryptEnvelope(envelope, { proofs: [grant.cid] }));
      if (new TextDecoder().decode(data) !== "tc1013-probe-plaintext") throw new Error("plaintext mismatch");
      return data;
    });
    await probe("node encryption decrypt under exo grant", "REFUSED", async () =>
      unwrap(await backend.encryption.decryptEnvelope(envelope, { proofs: [verdict.verified.cid] })));
    console.log(`PROBE delegate high-level secrets surface: ${"secrets" in access ? "present" : "absent"}`);
    restoreFetch();
    await probe("node secrets vault kv.get under exo grant", "REFUSED", async () =>
      (await accessFor(mainPortable, "vault/secrets/probe-secret", ["tinycloud.kv/get"], otherSpace("secrets"))).kv.get("probe-secret"));

    const jobsGetOnly = await accessFor(await mint([{ path: EXO_JOBS_PREFIX, actions: ["tinycloud.kv/get"] }]), EXO_JOBS_PREFIX, ["tinycloud.kv/get"]);
    await probe("node jobs-get-only kv.get seeded job", "ALLOWED", () => jobsGetOnly.kv.get(JOB.slice(EXO_JOBS_PREFIX.length)));
    const newJobKey = randomUUID();
    track(`${EXO_JOBS_PREFIX}${newJobKey}`);
    await probe("node jobs-get-only kv.put", "REFUSED", () => jobsGetOnly.kv.put(newJobKey, {}));
    await probe("node jobs-get-only kv.delete seeded job", "REFUSED", () => jobsGetOnly.kv.delete(JOB.slice(EXO_JOBS_PREFIX.length)));

    const putKey = `sync-meetings/${randomUUID()}`;
    track(`${EXO_REQUESTS_PREFIX}${putKey}`);
    const putOnly = await accessFor(await mint([{ path: EXO_REQUESTS_PREFIX, actions: ["tinycloud.kv/put"] }]), EXO_REQUESTS_PREFIX, ["tinycloud.kv/put"]);
    await probe("node requests-put-only kv.put", "ALLOWED", () => putOnly.kv.put(putKey, { kind: "sync-meetings" }));
    await probe("node requests-put-only kv.get", "REFUSED", () => putOnly.kv.get(putKey));

    const checksummed = ownerApplicationsSpaceUri(ownerAddress, chainId);
    const lowercase = checksummed.toLowerCase();
    console.log(
      `PROBE space-uri casing: report-only -> spaceId-equals-checksummed=${spaceId === checksummed} ` +
        `checksummed=${await observe(() => owner.space(checksummed).kv.get(THREAD), THREAD)} ` +
        `lowercase=${await observe(() => owner.space(lowercase).kv.get(THREAD), THREAD)}`,
    );
  } finally {
    const outcomes = new Map<string, string>();
    if (spaceId !== "") {
      for (const key of written) {
        outcomes.set(key, await observe(() => owner.space(spaceId).kv.delete(key), key));
      }
    }
    for (const [key, outcome] of outcomes) {
      if (outcome.startsWith("REFUSED")) console.log(`CLEANUP refused key ${key} -> ${outcome}`);
    }
    const values = [...outcomes.values()];
    console.log(
      `CLEANUP owner deletes: keys=${written.size} allowed=${values.filter((o) => o === "ALLOWED").length} ` +
        `key-not-found=${values.filter((o) => o === "ALLOWED key-not-found").length} refused=${values.filter((o) => o.startsWith("REFUSED")).length}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.log(`PROBE run: ERROR -> ${refusal(error)}`);
    process.exit(1);
  },
);
