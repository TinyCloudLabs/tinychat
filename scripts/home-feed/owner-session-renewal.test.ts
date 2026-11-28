import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import { openOwnerSession } from "./owner-session";

const HOST = "https://home-renewal.test";
const HOUR = 3_600_000;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const restore of cleanup.splice(0).reverse()) restore(); });

async function profile(kind: "leased" | "finite" | "revoked") {
  // Real SDK restoration and signed owner proof. Stub the node-facing renewal check and
  // pin its result to a different end from the lease's advertised ceiling.
  const now = Math.floor(Date.now() / 1000) * 1000;
  const originalEnd = now + HOUR;
  const admittedEnd = originalEnd + HOUR;
  const wasm = new NodeWasmBindings();
  const owner = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
  const address = await owner.getAddress(), chainId = await owner.getChainId();
  const spaceId = wasm.makeSpaceId(address, chainId, "applications");
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  const verificationMethod = manager.getDID("default");
  const signed = wasm.prepareSession({ address, chainId, domain: "home-renewal.test", jwk, spaceId,
    issuedAt: new Date(now).toISOString(), expirationTime: new Date(originalEnd).toISOString(),
    abilities: { kv: { "xyz.tinycloud.rocinante/board/": ["tinycloud.kv/get"] } },
  });
  const signature = await owner.signMessage(signed.siwe);
  const { delegationCid, delegationHeader } = wasm.completeSessionSetup({ ...signed, signature });
  const expiresAt = new Date(originalEnd).toISOString();
  const renewal = kind === "finite" ? undefined : { receipt: { leaseAuthorization: "synthetic-lease", leaseExpiresAt: new Date(admittedEnd + HOUR).toISOString() } };
  const root = mkdtempSync(join(tmpdir(), "home-owner-renewal-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "profiles", "roci-home-mirror");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.json"), JSON.stringify({ host: HOST, ownerDid: `did:pkh:eip155:${chainId}:${address}`, sessionDid: verificationMethod }));
  writeFileSync(join(dir, "key.json"), JSON.stringify(jwk));
  writeFileSync(join(dir, "session.json"), JSON.stringify({ address, chainId, spaceId, verificationMethod, delegationCid,
    delegationHeader, siwe: signed.siwe, signature, expiresAt, renewal }));
  let invoked = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (/^\/v[12]\/locations\//.test(url.pathname)) return new Response('{"error":"location record not found"}', { status: 404 });
    if (url.origin !== HOST || url.pathname !== "/invoke") throw new Error(`Unexpected fixture route: ${url.origin}${url.pathname}`);
    invoked++;
    if (kind !== "leased" || Date.now() >= admittedEnd || !req.headers.get("authorization")) return new Response(null, { status: 401 });
    return new Response('{"renewed":true}', { headers: { etag: '"mirror-test"', "content-type": "application/json" } });
  }, { preconnect: originalFetch.preconnect });
  const clock = spyOn(Date, "now").mockReturnValue(originalEnd + 1_000);
  const check = spyOn(TinyCloudNode.prototype, "getRenewalEffectiveExpiry").mockImplementation(async (token) => {
    if (token !== "synthetic-lease") throw new Error("wrong lease");
    if (kind === "revoked" || Date.now() >= admittedEnd) throw Object.assign(new Error("renewal inactive"), { code: "RENEWAL_AUTHORITY_INACTIVE" });
    return admittedEnd / 1000;
  });
  cleanup.push(() => { globalThis.fetch = originalFetch; clock.mockRestore(); check.mockRestore(); });
  const options = { tcHome: root, profile: "roci-home-mirror", ownerSpace: spaceId, legacySpace: spaceId, signal: new AbortController().signal };
  return { open: () => openOwnerSession(options), admittedEnd, afterAdmission: () => clock.mockReturnValue(admittedEnd + 1_000), invoked: () => invoked };
}

test("Home opens and reads past the original expiry only up to the verified renewal end", async () => {
  const fixture = await profile("leased");
  const { node, ctx } = await fixture.open();
  expect(node.sessionEnd?.getTime()).toBe(fixture.admittedEnd);
  const result = await ctx.legacy.get("xyz.tinycloud.rocinante/board/ask/renewal.json");
  expect(result).toMatchObject({ ok: true, data: { data: { renewed: true } } });
  fixture.afterAdmission();
  await expect(fixture.open()).rejects.toThrow("Existing owner session is unavailable");
  expect(fixture.invoked()).toBe(1);
});

test.each(["finite", "revoked"] as const)("Home refuses an expired %s profile without invoking storage", async (kind) => {
  const fixture = await profile(kind);
  await expect(fixture.open()).rejects.toThrow("Existing owner session is unavailable");
  expect(fixture.invoked()).toBe(0);
});
