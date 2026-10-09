import { expect, test } from "bun:test";
import { tinycloud, initialized } from "@tinycloud/web-sdk-wasm";
import { privateKeyToAccount } from "viem/accounts";
import type { NativeSession, OpenKeyNative } from "@openkey/sdk-capacitor";
import type { ISessionStorage, PersistedSessionData, TinyCloudWeb } from "@tinycloud/web-sdk";
import { installNativeSession, type NativeSignInDeps } from "./openkeyNative";
import { NativeRenewal, guardNativeTinyCloudCalls } from "./openkeyNativeRenewal";

// This fake mirrors web-sdk 2.11's restoreSession graph retirement. Each
// service signs real WASM proofs, and the fake HTTP node rejects an expired CID.
test("held calls and an in-flight audio-part overwrite use the renewed graph", async () => {
  await initialized;
  const account = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
  const issued = Date.now();
  const spaceId = `tinycloud:pkh:eip155:1:${account.address}:applications`;
  const sign = async (ttl: number, jwk?: unknown) => {
    const prepared = tinycloud.prepareSession({
      abilities: { kv: { "app/threads/": ["tinycloud.kv/put"] } },
      address: account.address, chainId: 1, domain: "openkey.so", spaceId, jwk,
      issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + ttl).toISOString(),
    });
    const signature = await account.signMessage({ message: prepared.siwe });
    return { ...tinycloud.completeSessionSetup({ ...prepared, signature }), siwe: prepared.siwe, signature };
  };
  const oldSigned = await sign(1_200);
  const newSigned = await sign(300_000, oldSigned.jwk);
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
  const signedByCid = new Map([[oldSigned.delegationCid, oldSigned], [newSigned.delegationCid, newSigned]]);
  const records = new Map<string, PersistedSessionData>();
  const storage = {
    save: async (address: string, data: PersistedSessionData) => { records.set(address, data); },
    load: async (address: string) => records.get(address) ?? null,
    clear: async (address: string) => { records.delete(address); },
    exists: () => true, isAvailable: () => true, activeAddress: () => account.address,
  } as ISessionStorage;
  const openkey = {
    current: async () => original, renew: async () => renewed,
    sessionStorageAdapter: () => storage,
  } as unknown as OpenKeyNative;
  const seen: string[] = [];
  const node = Bun.serve({ port: 0, fetch(request) {
    const authorization = request.headers.get("authorization") ?? "";
    const payload = JSON.parse(Buffer.from(authorization.split(".")[1] ?? "", "base64url").toString()) as { prf: string[] };
    const cid = payload.prf[0];
    seen.push(cid);
    if (Date.now() > issued + 1_200 && cid === oldSigned.delegationCid) return new Response("expired", { status: 401 });
    return Response.json({ ok: true });
  } });
  let releaseOld!: () => void;
  let oldEntered!: () => void;
  const oldPaused = new Promise<void>((resolve) => { releaseOld = resolve; });
  const atOld = new Promise<void>((resolve) => { oldEntered = resolve; });
  let graph: { retire: () => void; kv: { put: (key: string, value: string) => Promise<Response> } } | null = null;
  const raw = {
    get kv() { return graph?.kv; },
    async restoreSession(address: string) {
      graph?.retire();
      const cid = records.get(address)?.tinycloudSession?.delegationCid;
      const signed = signedByCid.get(cid ?? "");
      if (!signed) return { status: "missing" };
      let retired = false;
      graph = {
        retire: () => { retired = true; },
        kv: { put: async (key: string, value: string) => {
          if (signed === oldSigned && key.endsWith("/p/000001")) { oldEntered(); await oldPaused; }
          if (retired) throw new Error("Service graph has been retired by session replacement.");
          const proof = tinycloud.invoke(signed, "tinycloud.kv", key, "tinycloud.kv/put", []);
          return fetch(`${node.url}kv`, { method: "PUT", headers: proof, body: value });
        } },
      };
      return { status: "restored" };
    },
  } as unknown as TinyCloudWeb;
  const config = { backendUrl: "https://backend.example", tinycloudHost: "https://fake.node" };
  const deps = {
    activateSession: async () => ({ success: true, status: 200, activated: [spaceId], skipped: [] }),
  } as unknown as NativeSignInDeps;
  try {
    await installNativeSession(openkey, original, config, deps, raw);
    let now = issued;
    const renewal = new NativeRenewal({
      openkey, tcw: raw, session: original,
      sessionStore: { setSession: () => {} }, requestNonce: async () => "nonce",
      verifySession: async () => ({ token: "jwt", expiresIn: 86_400, address: account.address }),
      install: async (next, current) => { await installNativeSession(openkey, next, config, deps, current); },
      onTerminal: () => {}, onStorage: () => {}, jitter: () => 0, now: () => now,
    });
    const held = guardNativeTinyCloudCalls(raw, renewal).kv;
    expect((await held.put("app/threads/first", "before")).status).toBe(200);
    expect(seen.at(-1)).toBe(oldSigned.delegationCid);
    const inFlight = held.put("app/threads/audio/p/000001", "during");
    await atOld;
    now = issued + 900;
    await renewal.check();
    releaseOld();
    expect((await inFlight).status).toBe(200);
    expect(seen.at(-1)).toBe(newSigned.delegationCid);
    await Bun.sleep(1_250);
    now = issued + 1_300;
    expect((await held.put("app/threads/later", "after")).status).toBe(200);
    expect(seen.at(-1)).toBe(newSigned.delegationCid);
    renewal.stop();
  } finally { node.stop(true); }
});
