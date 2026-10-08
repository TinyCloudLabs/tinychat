import { expect, test } from "bun:test";
import { tinycloud, initialized } from "@tinycloud/web-sdk-wasm";
import { privateKeyToAccount } from "viem/accounts";
import type { NativeSession, OpenKeyNative } from "@openkey/sdk-capacitor";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { NativeRenewal, guardNativeTinyCloudCalls } from "./openkeyNativeRenewal";

// Real TinyCloud WASM signs both invocations. The fake node receives HTTP and
// rejects the old proof once its short delegation expires; the same live
// client sends the renewed proof without a restart.
test("a TinyCloud invocation after the original delegation expires uses the renewed CID", async () => {
  await initialized;
  const account = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
  const issued = Date.now();
  const spaceId = `tinycloud:pkh:eip155:1:${account.address}:applications`;
  const config = {
    abilities: { kv: { "app/threads/": ["tinycloud.kv/put"] } },
    address: account.address, chainId: 1, domain: "openkey.so", spaceId,
  };
  const sign = async (ttl: number, jwk?: unknown) => {
    const prepared = tinycloud.prepareSession({ ...config, jwk,
      issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + ttl).toISOString(),
    });
    const signature = await account.signMessage({ message: prepared.siwe });
    return { ...tinycloud.completeSessionSetup({ ...prepared, signature }), siwe: prepared.siwe, signature };
  };
  const oldSigned = await sign(1_200);
  const newSigned = await sign(300_000, oldSigned.jwk);
  expect(newSigned.verificationMethod).toBe(oldSigned.verificationMethod);
  const native = (signed: typeof oldSigned, ttl: number): NativeSession => ({
    tokens: { accessToken: "access", refreshToken: signed.delegationCid },
    sessionKey: { did: signed.verificationMethod.split("#")[0], keyId: signed.verificationMethod,
      publicJwk: { ...signed.jwk, d: undefined }, privateJwk: signed.jwk },
    delegation: { address: account.address, chainId: 1, spaceId,
      verificationMethod: signed.verificationMethod, siwe: signed.siwe, signature: signed.signature,
      delegationHeader: signed.delegationHeader, delegationCid: signed.delegationCid,
      issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + ttl).toISOString(),
      permissions: [], tinycloudHost: "https://fake.node" },
  } as NativeSession);
  const original = native(oldSigned, 1_200);
  const renewed = native(newSigned, 300_000);
  let live = oldSigned;
  const seen: string[] = [];
  const node = Bun.serve({ port: 0, fetch(request) {
    const authorization = request.headers.get("authorization") ?? "";
    const payload = JSON.parse(Buffer.from(authorization.split(".")[1] ?? "", "base64url").toString()) as { prf: string[] };
    const cid = payload.prf[0];
    seen.push(cid);
    if (Date.now() > issued + 1_200 && cid === oldSigned.delegationCid) return new Response("expired", { status: 401 });
    return Response.json({ ok: true });
  } });
  try {
    const raw = {
      kv: { put: async (key: string, value: string) => {
        const proof = tinycloud.invoke(live, "tinycloud.kv", key, "tinycloud.kv/put", []);
        return fetch(`${node.url}kv`, { method: "PUT", headers: proof, body: value });
      } },
    } as unknown as TinyCloudWeb;
    const renewal = new NativeRenewal({
      openkey: { renew: async () => renewed, current: async () => original } as unknown as OpenKeyNative,
      tcw: raw, session: original,
      sessionStore: { setSession: () => {} }, requestNonce: async () => "nonce",
      verifySession: async () => ({ token: "jwt", expiresIn: 86_400, address: account.address }),
      install: async (_session, current) => { expect(current).toBe(raw); live = newSigned; },
      onTerminal: () => {}, onStorage: () => {}, jitter: () => 0,
    });
    const guarded = guardNativeTinyCloudCalls(raw, renewal);
    const first = await guarded.kv.put("app/threads/x", "before");
    expect(first.status).toBe(200);
    expect(seen[0]).toBe(oldSigned.delegationCid);
    await Bun.sleep(1_250);
    const later = await guarded.kv.put("app/threads/x", "after");
    expect(later.status).toBe(200);
    expect(seen.at(-1)).toBe(newSigned.delegationCid);
    expect(seen.at(-1)).not.toBe(oldSigned.delegationCid);
    renewal.stop();
  } finally { node.stop(true); }
});
