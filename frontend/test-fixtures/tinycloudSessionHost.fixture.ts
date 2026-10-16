import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { createRequire } from "node:module";
import { Window } from "happy-dom";
import { hexToBytes, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PersistedSessionData, TinyCloudWeb } from "@tinycloud/web-sdk";
import type { EIP1193Provider, TinyCloudWebConfig } from "@tinyboilerplate/client";
import type { Manifest } from "@tinycloud/sdk-core";
import { jcsCanonicalize, parseCompactUcanAuthorization } from "@tinycloud/sdk-core";
import { createTinyCloudFetch, selectNewSessionHosts, TINYCLOUD_CONNECTION_MESSAGE } from "../src/lib/tinycloudHosts";
import { authErrorMessage } from "../src/lib/authErrors";

const NODE = "https://node.tinycloud.xyz";
const TEE = "https://tee.node.tinycloud.xyz";
const CUSTOM = "https://fixture-node.invalid";
const account = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const dom = new Window({ url: "https://chat.fixture.invalid/chat" });
const originalFetch = globalThis.fetch;
const browserNames = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "CustomEvent", "Event", "customElements", "localStorage", "location"] as const;
const previousGlobals = new Map(browserNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const name of browserNames) {
  Object.defineProperty(globalThis, name, {
    configurable: true, writable: true,
    value: name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name],
  });
}

type RequestRecord = { url: URL; method: string; headers: Headers; body: string };
const requests: RequestRecord[] = [];
const unexpectedRequests: string[] = [];
let walletCalls: string[] = [];
let failInvocations = false;
const clients: TinyCloudWeb[] = [];
const FIXTURE_INFO_VERSION = "1.20.2-fixture";
// These labels advertise only fixture capabilities, not real server enforcement.
const FEATURES = ["policy_v3", "share_email"];
const digest = (text: string) => createHash("sha256").update(text).digest();

// All SDK HTTP is intercepted before the SDK is imported. There is no network fallback.
const fixtureFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const body = typeof init?.body === "string" ? init.body : "";
  requests.push({ url, method, headers, body });
  if (![NODE, TEE, CUSTOM].includes(url.origin)) {
    unexpectedRequests.push(url.href);
    throw new Error(`Fixture forbids external HTTP: ${url.href}`);
  }
  if (url.pathname === "/info") {
    expect(method).toBe("GET");
    expect(headers.has("authorization")).toBe(false);
    return Response.json({ version: FIXTURE_INFO_VERSION, protocol, nodeId: nodeDid, features: FEATURES });
  }
  if (url.pathname === "/delegate") {
    expect(method).toBe("POST");
    expect(headers.get("authorization")).toBeTruthy();
    return Response.json({ activated: [spaceId], skipped: [] });
  }
  if (url.pathname === "/invoke") {
    expect(method).toBe("POST");
    expect(headers.get("authorization")).toBeTruthy();
    if (failInvocations) throw new TypeError("Failed to fetch");
    return Response.json({ fixture: "stored-host-data" });
  }
  if (url.pathname === "/policy/v3/enforcer-bindings") {
    const request = JSON.parse(body);
    expect(request.enforcerDid).toBe(enforcerDid);
    const unsigned = {
      schema: "xyz.tinycloud.policy/attested-enforcer/v2",
      enforcerDid, nodeAudience: nodeDid,
      attestationBindingDigestHex: digest(jcsCanonicalize({ enforcerDid, nodeAudience: nodeDid })).toString("hex"),
      issuedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z"),
      expiresAt: request.rootExpiresAt,
    };
    const bytes = digest(`xyz.tinycloud.policy/AttestedEnforcerBinding/v2\0${jcsCanonicalize(unsigned)}`);
    return Response.json({ ...unsigned, signature: {
      suite: "Ed25519", signerDid: nodeDid,
      value: sign(null, bytes, createPrivateKey({ key: nodeKey, format: "jwk" })).toString("base64url"),
    } });
  }
  if (url.pathname === "/policy/v3/policies") {
    const request = JSON.parse(body);
    const policyRoot = parseCompactUcanAuthorization(request.policyRoot);
    const enforcementRoot = parseCompactUcanAuthorization(request.enforcementRoot);
    expect(policyRoot.payload.fct[0].nodeAudience).toBe(nodeDid);
    expect(enforcementRoot.payload.fct[0].nodeAudience).toBe(nodeDid);
    return Response.json({ policyCid: request.policyCid, policyRootCid: policyRoot.cid, enforcementRootCid: enforcementRoot.cid });
  }
  if (url.pathname === "/policy/v3/deliveries/authorize") {
    expect(headers.get("authorization")).toBeTruthy();
    // Deliberately no fake successful admission: this fixture proves routing/signatures only.
    return new Response("fixture delivery not admitted", { status: 403 });
  }
  unexpectedRequests.push(url.href);
  throw new Error(`Unhandled fixture HTTP: ${url.href}`);
};
globalThis.fetch = createTinyCloudFetch(fixtureFetch) as typeof fetch;
dom.fetch = globalThis.fetch as typeof dom.fetch;

// Browser globals must precede SDK evaluation (it registers custom elements).
const { BrowserSessionStorage, BrowserWasmBindings, TinyCloudWeb: RealTinyCloudWeb } = await import("@tinycloud/web-sdk");
const { createAndSignIn } = await import("@tinyboilerplate/client");
const { restoreSessionOnStoredHost } = await import("../src/lib/tinycloudSession");
// Use the exact transitive versions pinned by web-sdk, without adding test dependencies.
const sdkRequire = createRequire(import.meta.resolve("@tinycloud/web-sdk"));
const { publishAddressedShare, prepareAddressedShare } = sdkRequire("@tinycloud/share-sdk");
const { verifyEnvelopeV3SignatureOnly } = sdkRequire("@tinycloud/share-envelope");
const wasm = new BrowserWasmBindings();
await wasm.ensureInitialized();
const protocol = wasm.protocolVersion();
const identityManager = wasm.createSessionManager();
const nodeKeyId = identityManager.createSessionKey("fixture-node");
const nodeKey: JsonWebKey = JSON.parse(identityManager.jwk(nodeKeyId)!);
const nodeDid = identityManager.getDID(nodeKeyId).split("#")[0];
// Pinned v3 envelope validation requires the Node and enforcer audiences to match.
// This fixture-only did:key identity is not fresh hosted-policy acceptance proof.
const enforcerDid = nodeDid;
const spaceId = wasm.makeSpaceId(account.address, 1, "default");
const manifest: Manifest = {
  app_id: "host-fixture", name: "Pinned SDK host continuity fixture", prefix: "fixture",
  space: "default", defaults: false, includePublicSpace: false,
  permissions: [{ service: "tinycloud.kv", space: "default", path: "", actions: ["get", "put"] }],
};

function config(host: string): TinyCloudWebConfig {
  return { tinycloudHosts: [host], tinycloudRegistryUrl: null, tinycloudFallbackHosts: null,
    autoCreateSpace: false, manifest, includeAccountRegistryPermissions: false };
}
const provider: EIP1193Provider = {
  async request({ method, params }) {
    walletCalls.push(method);
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
    if (method === "eth_chainId") return "0x1";
    if (method === "personal_sign") {
      const [message, address] = params as [string, string];
      expect(address.toLowerCase()).toBe(account.address.toLowerCase());
      return account.signMessage({ message: { raw: hexToBytes(message as `0x${string}`) } });
    }
    throw new Error(`Unexpected wallet request: ${method}`);
  },
};
const sessionRecordKey = `tinycloud:session:${account.address.toLowerCase()}`;
function rawRecord() {
  const raw = dom.localStorage.getItem(sessionRecordKey);
  expect(raw).not.toBeNull();
  return raw!;
}
function record(): PersistedSessionData {
  return JSON.parse(rawRecord());
}
async function signIn(host: string) {
  const result = await createAndSignIn(provider, config(host));
  clients.push(result.tcw);
  expect(await verifyMessage({ address: account.address, message: result.session.siwe, signature: result.session.signature as `0x${string}` })).toBe(true);
  expect(record().tinycloudHosts).toEqual([host]);
  expect(record().tinycloudSession!.spaceId).toBe(spaceId);
  return result;
}
async function restore(defaultHost = NODE) {
  const result = await restoreSessionOnStoredHost(account.address, config(defaultHost));
  expect(result.status, result.error?.message).toBe("restored");
  expect(result.tcw).not.toBeNull();
  clients.push(result.tcw!);
  return result;
}
function validateRecord(value: PersistedSessionData) {
  wasm.validatePersistedSession({ ...value.tinycloudSession!, jwk: JSON.parse(value.sessionKey),
    address: value.address, chainId: value.chainId, siwe: value.siwe, signature: value.signature });
}
async function expectReadHost(client: TinyCloudWeb, host: string) {
  const start = requests.length;
  const result = await client.kv.get("fixture/document");
  expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
  if (result.ok) expect(result.data.data).toEqual({ fixture: "stored-host-data" });
  const invocations = requests.slice(start).filter((request) => request.url.pathname === "/invoke");
  expect(invocations.map((request) => request.url.href)).toEqual([`${host}/invoke`]);
}

beforeEach(() => {
  dom.localStorage.clear();
  requests.length = 0;
  walletCalls = [];
  failInvocations = false;
});
afterAll(() => {
  for (const client of clients) client.cleanup();
  expect(unexpectedRequests).toEqual([]);
  globalThis.fetch = originalFetch;
  dom.happyDOM.abort();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("new sessions select anonymous node info and sign in with real SDK/WASM/viem", async () => {
  const selected = await selectNewSessionHosts(undefined, fixtureFetch);
  expect(selected).toEqual([NODE]);
  expect(requests.map((request) => request.url.href)).toEqual([`${NODE}/info`]);
  const { tcw } = await signIn(selected[0]);
  expect(walletCalls.filter((method) => method === "personal_sign")).toHaveLength(1);
  validateRecord(record());
  await expectReadHost(tcw, NODE);
  expect(requests.every((request) => request.url.origin === NODE)).toBe(true);
});

test("real SDK upload errors stay clear through its error wrapper and never replay the body", async () => {
  const { tcw } = await signIn(NODE);
  const start = requests.length;
  failInvocations = true;
  const result = await tcw.kv.put("fixture/upload", new Uint8Array(2 * 1024 * 1024));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the synthetic connection failure");
  expect(result.error.code).toBe("NETWORK_ERROR");
  expect(authErrorMessage(result.error, "web")).toBe(TINYCLOUD_CONNECTION_MESSAGE);
  expect(requests.slice(start).filter((request) => request.url.pathname === "/invoke").map((request) => request.url.href))
    .toEqual([`${NODE}/invoke`]);
});

test("new-session fallback happens before signing and persists tee rather than replaying service requests", async () => {
  const probes: string[] = [];
  const selected = await selectNewSessionHosts(undefined, async (input, init) => {
    const url = String(input);
    probes.push(url);
    if (url === `${NODE}/info`) throw new TypeError("Failed to fetch");
    return fixtureFetch(input, init);
  });
  expect(probes).toEqual([`${NODE}/info`, `${TEE}/info`]);
  expect(selected).toEqual([TEE]);
  const { tcw } = await signIn(selected[0]);
  await expectReadHost(tcw, TEE);
  expect(requests.every((request) => request.url.origin === TEE)).toBe(true);
});

test("existing tee record survives node configuration without wallet sign-in or authority rewrite", async () => {
  await signIn(TEE);
  const original = record();
  const persisted = rawRecord();
  const walletBefore = [...walletCalls];
  requests.length = 0;
  const restored = await restore();
  expect(walletCalls).toEqual(walletBefore);
  expect(restored.session).toMatchObject({ address: original.address, siwe: original.siwe, signature: original.signature });
  expect(restored.tcw!.spaceId).toBe(original.tinycloudSession!.spaceId);
  expect(record().sessionKey).toBe(original.sessionKey);
  expect(record().tinycloudSession).toEqual(original.tinycloudSession);
  expect(rawRecord()).toBe(persisted);
  validateRecord(record());
  await expectReadHost(restored.tcw!, TEE);
  expect(requests.every((request) => request.url.origin === TEE)).toBe(true);
  expect(rawRecord()).toBe(persisted);
});

test("custom stored hosts remain custom and hostless legacy records use configured default", async () => {
  await signIn(CUSTOM);
  const persisted = rawRecord();
  const walletBefore = [...walletCalls];
  await expectReadHost((await restore()).tcw!, CUSTOM);
  expect(rawRecord()).toBe(persisted);
  const legacy = record();
  delete legacy.tinycloudHosts;
  dom.localStorage.setItem(sessionRecordKey, JSON.stringify(legacy));
  const hostless = rawRecord();
  await expectReadHost((await restore(NODE)).tcw!, NODE);
  expect(rawRecord()).toBe(hostless);
  expect(walletCalls).toEqual(walletBefore);
});

test("generic pinned SDK explicit host override is unchanged outside app restore helper", async () => {
  await signIn(TEE);
  const persisted = rawRecord();
  const walletBefore = [...walletCalls];
  const direct = await RealTinyCloudWeb.create({ tinycloudHosts: [NODE], sessionStorage: new BrowserSessionStorage(),
    notifications: { popups: false }, autoBootstrapAccount: false, autoCreateSpace: false });
  clients.push(direct);
  expect((await direct.restoreSession(account.address)).status).toBe("restored");
  await expectReadHost(direct, NODE);
  expect(rawRecord()).toBe(persisted);
  expect(walletCalls).toEqual(walletBefore);
});

test("real generated share reader retains its tee host after an independent new node session", async () => {
  await signIn(TEE);
  const restored = (await restore()).tcw!;
  const generated = await restored.sharing.generate({ path: "fixture/document", actions: ["tinycloud.kv/get"], expiry: new Date(Date.now() + 60_000) });
  expect(generated.ok, generated.ok ? undefined : generated.error.message).toBe(true);
  if (!generated.ok) throw new Error(generated.error.message);
  const encoded = restored.sharing.decodeLink(generated.data.token);
  expect(encoded.host).toBe(TEE);
  expect(encoded.spaceId).toBe(spaceId);
  expect(encoded.key.d).toBeTruthy();
  const originalShare = JSON.stringify(encoded);
  dom.localStorage.clear();
  await signIn((await selectNewSessionHosts(undefined, fixtureFetch))[0]);
  requests.length = 0;
  const received = await RealTinyCloudWeb.receiveShare(generated.data.token);
  expect(received.ok, received.ok ? undefined : received.error.message).toBe(true);
  if (received.ok) {
    expect(received.data.host).toBe(TEE);
    expect(received.data.spaceId).toBe(spaceId);
    expect(received.data.data).toEqual({ fixture: "stored-host-data" });
  }
  expect(requests.map((request) => request.url.pathname)).toEqual(["/delegate", "/invoke"]);
  expect(requests.every((request) => request.url.origin === TEE)).toBe(true);
  expect(JSON.stringify(restored.sharing.decodeLink(generated.data.token))).toBe(originalShare);
});

test("policy_v3/email signed roots and target origin stay bound to the restored tee session", async () => {
  const owner = (await signIn(TEE)).tcw;
  const persisted = rawRecord();
  const walletBefore = [...walletCalls];
  const prepared = prepareAddressedShare({ target: { kind: "email", address: "reader@example.invalid" },
    actions: ["read"], policyActions: ["tinycloud.kv/get"], filename: "document.txt" });
  const published = await publishAddressedShare({ ...prepared,
    shareId: "fixture_share_000001", shareOrigin: "https://share.fixture.invalid", nodeOrigin: TEE,
    // Node audience is independently supplied trust metadata, NEVER derived from a default hostname.
    nodeAudience: nodeDid, enforcerDid, spaceId, resource: { kind: "exact", path: "fixture/document" },
    actions: ["read"], policyActions: ["tinycloud.kv/get"], filename: "document.txt", mediaType: "text/plain", byteLength: 12,
    expiresAt: new Date(Date.now() + 60_000),
    contentSource: { shareId: "fixture_share_000001", kvResource: `${spaceId}/kv/fixture/document`, selector: "exact",
      encryptionNetwork: `urn:tinycloud:encryption:did:pkh:eip155:1:${account.address.toLowerCase()}:fixture`,
      encryptedSymmetricKeyDigestHex: "11".repeat(32), keyVersion: 1, mode: "mutable" },
    authority: { ownerDid: owner.credentialHolderDid, createOwnerRoot: owner.createUnifiedOwnerRoot.bind(owner),
      sign: owner.signSessionBytes.bind(owner), registerPolicy: owner.registerPolicy.bind(owner) },
  });
  const material = published.deliveryMaterial;
  const envelope = material.envelope;
  const signedEnvelope = JSON.stringify(envelope);
  expect(verifyEnvelopeV3SignatureOnly(envelope)).toBe(true);
  expect(envelope.target.origin).toBe(TEE);
  expect(envelope.target.nodeAudience).toBe(enforcerDid);
  expect(envelope.attestedEnforcerBinding.nodeAudience).toBe(nodeDid);
  expect(envelope.recipientMatcher).toEqual({ kind: "exactEmail", value: "reader@example.invalid" });
  for (const root of [envelope.policyRoot, envelope.enforcementRoot]) {
    const verified = parseCompactUcanAuthorization(root.authorization, root.cid);
    expect(verified.payload.fct[0].nodeAudience).toBe(nodeDid);
    const [header, payload, signature] = root.authorization.split(".");
    const changed = JSON.parse(Buffer.from(payload, "base64url").toString());
    changed.fct[0].nodeAudience = "did:web:node.tinycloud.xyz";
    expect(() => parseCompactUcanAuthorization(`${header}.${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`)).toThrow();
  }
  expect(verifyEnvelopeV3SignatureOnly({ ...envelope, target: { ...envelope.target, origin: NODE } })).toBe(false);
  const restoredOwner = (await restore()).tcw!;
  expect(restoredOwner.credentialHolderDid).toBe(owner.credentialHolderDid);
  requests.length = 0;
  await expect(restoredOwner.authorizeShareDeliveryV3({ ...material, resourcePath: "fixture/document", recipientEmail: "reader@example.invalid",
    shareUrl: published.url, documentName: "document.txt", expiresAt: new Date(Date.now() + 30_000).toISOString(),
    deliveryAudience: "https://email.fixture.invalid", idempotencyKey: "fixture-original-host-email" })).rejects.toThrow();
  const delivery = requests.filter((request) => request.url.pathname === "/policy/v3/deliveries/authorize");
  expect(delivery).toHaveLength(1);
  expect(delivery[0].url.origin).toBe(TEE);
  expect(JSON.parse(delivery[0].body).envelope).toEqual(envelope);
  expect(JSON.stringify(envelope)).toBe(signedEnvelope);
  expect(rawRecord()).toBe(persisted);
  expect(walletCalls).toEqual(walletBefore);
  // This does not assert a Node/email service accepted a grant or verified a TEE.
});
