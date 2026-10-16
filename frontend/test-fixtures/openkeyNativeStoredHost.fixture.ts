import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  OpenKeyNative,
  verifyTinyCloudDelegation,
  type NativeDelegationPermission,
  type NativeSession,
  type OpenKeyCapacitorPlugin,
  type OpenKeyNativeOptions,
  type TinyCloudDelegation,
} from "@openkey/sdk-capacitor";
import { initialized, tinycloud } from "@tinycloud/web-sdk-wasm";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import type { Manifest } from "@tinycloud/sdk-core";
import type { PersistedSessionData, TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  nativeClientOptions,
  nativeRenewalServices,
  resetNativeOpenKeyClientForTests,
  restoreNativeAtBoot,
  signInNative,
  type NativeSignInConfig,
  type NativeSignInDeps,
} from "../src/lib/openkeyNative";
import { NativeRenewal } from "../src/lib/openkeyNativeRenewal";

const TEE = "https://tee.node.tinycloud.xyz";
const NODE = "https://node.tinycloud.xyz";
const ISSUED = Date.parse("2026-10-01T12:00:00.000Z");
const ISSUER = "https://api.openkey.invalid/api/auth";
const CLIENT_ID = "fixture-native-client";
const account = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const SPACE = `tinycloud:pkh:eip155:1:${account.address}:applications`;
const PERMISSIONS: NativeDelegationPermission[] = [
  { service: "tinycloud.capabilities", space: "applications", path: "", actions: ["tinycloud.capabilities/read"] },
  { service: "tinycloud.kv", space: "applications", path: "fixture/", actions: ["tinycloud.kv/put"] },
];
const MANIFEST = {
  app_id: "fixture", prefix: "fixture",
  permissions: [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["put"] }],
} as Manifest;
const bindings = {
  ensureInitialized: () => initialized,
  siweToDelegationHeaders: tinycloud.siweToDelegationHeaders,
  computeCid: tinycloud.computeCid,
};

function config(host: string): NativeSignInConfig {
  return {
    backendUrl: "https://backend.invalid", tinycloudHost: host, tinycloudHosts: [host],
    env: { VITE_OPENKEY_NATIVE_CLIENT_ID: CLIENT_ID, VITE_OPENKEY_HOST: "https://openkey.invalid" },
  };
}

type PublicJwk = NativeSession["sessionKey"]["publicJwk"];
type Grant = { publicJwk: PublicJwk; host: string; permissions: NativeDelegationPermission[] };
type Par = Grant & { state: string; redirect: string; challenge: string; nonce?: string };

// All HTTP is injected. The platform alone is fake; OAuth, proof signing, SDK
// response validation, key coordination and secure-store session adapters are real.
function fixture(initialHost: string) {
  const secureValues = new Map<string, string>();
  const refreshGrants = new Map<string, Grant>();
  const signed = new Map<string, TinyCloudDelegation>();
  const revoked: string[] = [];
  const renewalTokens: string[] = [];
  const activations: string[] = [];
  const restoredHosts: string[][] = [];
  const verifiedCids: string[] = [];
  let responseHost = initialHost;
  let par: Par | undefined;
  let serial = 0;
  let browserOpens = 0;
  let installed: PersistedSessionData | null = null;
  let restoreConfig: Parameters<NativeSignInDeps["restoreSession"]>[1] | undefined;

  const plugin: OpenKeyCapacitorPlugin = {
    secureStoreGet: async ({ key }) => ({ value: secureValues.get(key) ?? null }),
    secureStoreSet: async ({ key, value }) => { secureValues.set(key, value); },
    secureStoreRemove: async ({ key }) => { secureValues.delete(key); },
    openAuthSession: async ({ url, callbackUrl, expectedState }) => {
      browserOpens++;
      expect(new URL(url).origin).toBe(new URL(ISSUER).origin);
      expect(new URL(url).searchParams.get("request_uri")).toBe("urn:fixture:request");
      expect(expectedState).toBe(par?.state);
      const callback = new URL(callbackUrl!);
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("state", par!.state);
      callback.searchParams.set("iss", ISSUER);
      return { url: callback.toString() };
    },
  };

  async function delegation(grant: Grant, nonce?: string): Promise<TinyCloudDelegation> {
    await initialized;
    const abilities: Record<string, Record<string, string[]>> = {};
    for (const permission of grant.permissions) {
      const service = permission.service.replace("tinycloud.", "");
      (abilities[service] ??= {})[permission.path ?? ""] = permission.actions;
    }
    const prepared = tinycloud.prepareSession({
      abilities, jwk: grant.publicJwk, address: account.address, chainId: 1,
      spaceId: SPACE, domain: "openkey.invalid", issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 300_000).toISOString(),
    });
    // Use the backend's requested nonce in the signed SIWE, not an echoed config field.
    const siwe = nonce ? prepared.siwe.replace(/^Nonce: .+$/m, `Nonce: ${nonce}`) : prepared.siwe;
    const signature = await account.signMessage({ message: siwe });
    const completed = tinycloud.completeSessionSetup({ ...prepared, siwe, signature });
    const result: TinyCloudDelegation = {
      address: account.address, chainId: 1, spaceId: SPACE,
      verificationMethod: completed.verificationMethod,
      siwe, signature, delegationHeader: completed.delegationHeader,
      delegationCid: completed.delegationCid, issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      permissions: grant.permissions, tinycloudHost: grant.host,
    };
    signed.set(result.delegationCid!, result);
    return result;
  }

  function checkProof(headers: Record<string, string> | undefined, url: string, credential: string, publicJwk: PublicJwk) {
    const proof = headers?.["OpenKey-Session-Proof"];
    expect(proof).toBeString();
    const [header, payload, signature] = proof!.split(".");
    expect(verify(null, Buffer.from(`${header}.${payload}`), createPublicKey({ key: publicJwk, format: "jwk" }), Buffer.from(signature, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({ typ: "openkey-session-proof+jwt", alg: "EdDSA" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      htm: "POST", htu: url, client_id: CLIENT_ID,
      cred_hash: createHash("sha256").update(credential).digest("base64url"),
    });
  }

  const fetchFn: NonNullable<OpenKeyNativeOptions["fetchFn"]> = async (url, init) => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe(new URL(ISSUER).origin);
    if (parsed.pathname === "/.well-known/oauth-authorization-server/api/auth") {
      return Response.json({
        issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`, pushed_authorization_request_endpoint: `${ISSUER}/par`,
        tinycloud_delegation_renew_endpoint: `${ISSUER}/renew`,
        tinycloud_delegation_revocation_endpoint: `${ISSUER}/revoke`,
      });
    }
    expect(init?.method).toBe("POST");
    const body = new URLSearchParams(init?.body);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    if (parsed.pathname === "/api/auth/par") {
      const details = JSON.parse(body.get("authorization_details")!)[0];
      par = {
        publicJwk: details.session_key, permissions: details.permissions, host: responseHost,
        state: body.get("state")!, redirect: body.get("redirect_uri")!,
        challenge: body.get("code_challenge")!, nonce: details.siwe_nonce,
      };
      return Response.json({ request_uri: "urn:fixture:request", expires_in: 90 });
    }
    if (parsed.pathname === "/api/auth/token") {
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("redirect_uri")).toBe(par!.redirect);
      expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(par!.challenge);
      checkProof(init?.headers, url, body.get("code")!, par!.publicJwk);
      const token = `fixture-refresh-${++serial}`;
      refreshGrants.set(token, par!);
      return Response.json({ access_token: `fixture-access-${serial}`, refresh_token: token,
        tinycloud_delegation: await delegation(par!, par!.nonce) });
    }
    const token = body.get("refresh_token")!;
    const grant = refreshGrants.get(token);
    expect(grant).toBeDefined();
    checkProof(init?.headers, url, token, grant!.publicJwk);
    if (parsed.pathname === "/api/auth/revoke") {
      revoked.push(token);
      refreshGrants.delete(token);
      return new Response(null, { status: 204 });
    }
    expect(parsed.pathname).toBe("/api/auth/renew");
    renewalTokens.push(token);
    refreshGrants.delete(token);
    const next = `fixture-refresh-${++serial}`;
    refreshGrants.set(next, grant!);
    return Response.json({ refresh_token: next,
      tinycloud_delegation: await delegation(grant!, body.get("siwe_nonce") ?? undefined) });
  };

  const create = (options: OpenKeyNativeOptions) => new OpenKeyNative({
    ...options, plugin, fetchFn,
    verifyDelegation: (value) => verifyTinyCloudDelegation(value, bindings),
  });
  async function loadInstalled(address: string) {
    const record = await restoreConfig!.sessionStorage!.load(address);
    expect(record).not.toBeNull();
    const jwk = JSON.parse(record!.sessionKey);
    const proof = { ...record!.tinycloudSession!, jwk, address: record!.address,
      chainId: record!.chainId, siwe: record!.siwe, signature: record!.signature };
    tinycloud.validatePersistedSession(proof);
    installed = record;
    return { status: "restored" as const };
  }
  const tcw = { restoreSession: loadInstalled, cleanup: () => {} } as unknown as TinyCloudWeb;
  const deps: NativeSignInDeps = {
    createOpenKeyNative: create,
    requestNonce: async () => "fixturebackendnonce",
    loadManifest: async () => MANIFEST,
    activateSession: async (host, header) => {
      const grant = [...signed.values()].find((value) => value.delegationHeader!.Authorization === header.Authorization);
      expect(grant?.tinycloudHost).toBe(host);
      activations.push(host);
      return { success: true, status: 200, activated: [SPACE], skipped: [] };
    },
    restoreSession: async (address, options) => {
      restoreConfig = options;
      restoredHosts.push(options.tinycloudHosts!);
      await loadInstalled(address);
      return { tcw, status: "restored" };
    },
    verifySession: async (_url, siwe, signature) => {
      expect(await verifyMessage({ address: account.address, message: siwe, signature: signature as `0x${string}` })).toBe(true);
      const grant = [...signed.values()].find((value) => value.siwe === siwe && value.signature === signature);
      expect(grant).toBeDefined();
      verifiedCids.push(grant!.delegationCid!);
      return { token: `fixture-jwt-${verifiedCids.length}`, expiresIn: 3600, address: account.address };
    },
  };
  return {
    create, deps, secureValues, renewalTokens, activations, restoredHosts, revoked, verifiedCids,
    setResponseHost: (host: string) => { responseHost = host; },
    browserOpens: () => browserOpens,
    installed: () => installed,
    seed: () => create(nativeClientOptions(config(initialHost).env, initialHost)).signIn({ capabilities: PERMISSIONS }),
  };
}

afterEach(() => {
  resetNativeOpenKeyClientForTests();
  setSystemTime();
});

for (const [storedHost, configuredHost] of [[TEE, NODE], [NODE, TEE]] as const) {
  test(`boot renewal retains ${storedHost} when the build config changes to ${configuredHost}`, async () => {
    setSystemTime(new Date(ISSUED));
    const f = fixture(storedHost);
    const original = await f.seed();
    setSystemTime(new Date(ISSUED + 90_000));
    const result = await restoreNativeAtBoot(config(configuredHost), false, f.deps);
    expect(result.kind).toBe("restored");
    if (result.kind !== "restored") throw new Error(`Unexpected native boot outcome: ${result.kind}`);
    expect(result.session.delegation.tinycloudHost).toBe(storedHost);
    expect(result.session.delegation.delegationCid).not.toBe(original.delegation.delegationCid);
    expect(result.session.sessionKey.privateJwk).toEqual(original.sessionKey.privateJwk);
    expect(result.session.tokens.refreshToken).not.toBe(original.tokens.refreshToken);
    expect(f.installed()!.tinycloudHosts).toEqual([storedHost]);
    expect(f.restoredHosts[0][0]).toBe(storedHost);
    expect(f.activations).toEqual([storedHost]);
    expect(f.verifiedCids).toEqual([result.session.delegation.delegationCid!]);
    expect(result.verified?.token).toBe("fixture-jwt-1");
    expect((await result.openkey.current())!.sessionKey.privateJwk).toEqual(original.sessionKey.privateJwk);
    expect(f.browserOpens()).toBe(1);
    expect(f.revoked).toEqual([]);
  });

  test(`restored ${storedHost} grant stays renewable live under ${configuredHost} config`, async () => {
    setSystemTime(new Date(ISSUED));
    const f = fixture(storedHost);
    const original = await f.seed();
    setSystemTime(new Date(ISSUED + 90_000));
    const restored = await restoreNativeAtBoot(config(configuredHost), true, f.deps);
    expect(restored.kind).toBe("restored");
    if (restored.kind !== "restored") throw new Error(`Unexpected native boot outcome: ${restored.kind}`);
    expect(restored.session.delegation.delegationCid).toBe(original.delegation.delegationCid);
    expect(f.renewalTokens).toEqual([]);
    const services = await nativeRenewalServices(config(configuredHost), restored.openkey, f.deps);
    const jwtCommits: string[] = [];
    const errors: string[] = [];
    const renewal = new NativeRenewal({
      openkey: restored.openkey, tcw: restored.tcw, session: restored.session, ...services,
      sessionStore: { setSession: (token) => { jwtCommits.push(token); } },
      onTerminal: (message) => { errors.push(message); }, onStorage: (message) => { errors.push(message); },
      onUnavailable: (message) => { errors.push(message); }, jitter: () => 0, saveBusy: () => false,
    });
    try {
      setSystemTime(new Date(ISSUED + 225_000));
      await renewal.check();
      expect(errors).toEqual([]);
      expect(jwtCommits).toEqual(["fixture-jwt-1"]);
      const next = (await restored.openkey.current())!;
      expect(next.delegation.tinycloudHost).toBe(storedHost);
      expect(next.delegation.delegationCid).not.toBe(original.delegation.delegationCid);
      expect(next.sessionKey.privateJwk).toEqual(original.sessionKey.privateJwk);
      expect(next.tokens.refreshToken).not.toBe(original.tokens.refreshToken);
      expect(JSON.parse(f.installed()!.sessionKey)).toEqual(original.sessionKey.privateJwk);
      expect(f.installed()!.tinycloudSession!.delegationCid).toBe(next.delegation.delegationCid);
      expect(f.installed()!.tinycloudHosts).toEqual([storedHost]);
      expect(f.activations).toEqual([storedHost, storedHost]);
      expect(f.renewalTokens).toEqual([original.tokens.refreshToken]);
      expect(f.browserOpens()).toBe(1);
      expect(f.revoked).toEqual([]);
      // A different host shares this issuer/client namespace; neither a different
      // client nor a different issuer is allowed to acquire its key or token.
      const options = nativeClientOptions(config(configuredHost).env, configuredHost);
      expect((await f.create(options).current())!.tokens.refreshToken).toBe(next.tokens.refreshToken);
      expect(await f.create({ ...options, clientId: "another-fixture-client" }).current()).toBeNull();
      expect(await f.create({ ...options, issuer: "https://other-issuer.invalid/api/auth" }).current()).toBeNull();
    } finally {
      renewal.stop();
    }
  });

  test(`fresh ${configuredHost} sign-in rejects a ${storedHost} delegation`, async () => {
    setSystemTime(new Date(ISSUED));
    const f = fixture(storedHost);
    await expect(signInNative(config(configuredHost), undefined, f.deps)).rejects.toThrow();
    expect(await f.create(nativeClientOptions(config(configuredHost).env, configuredHost)).current()).toBeNull();
    expect(f.activations).toEqual([]);
    expect(f.verifiedCids).toEqual([]);
    expect(f.revoked).toHaveLength(1);
  });

  test(`fresh ${configuredHost} sign-in after ${storedHost} restore selects the configured host`, async () => {
    setSystemTime(new Date(ISSUED));
    const f = fixture(storedHost);
    const original = await f.seed();
    const restored = await restoreNativeAtBoot(config(configuredHost), true, f.deps);
    expect(restored.kind).toBe("restored");
    f.setResponseHost(configuredHost);
    const next = await signInNative(config(configuredHost), undefined, f.deps);
    expect(next.session.delegation.tinycloudHost).toBe(configuredHost);
    expect(next.session.sessionKey.privateJwk.x).not.toBe(original.sessionKey.privateJwk.x);
    expect(next.session.tokens.refreshToken).not.toBe(original.tokens.refreshToken);
    expect(f.installed()!.tinycloudHosts).toEqual([configuredHost]);
    expect(f.revoked).toEqual([original.tokens.refreshToken]);
    expect(f.browserOpens()).toBe(2);
  });
}

test("the pinned SDK refuses signed delegation material with a substituted CID", async () => {
  setSystemTime(new Date(ISSUED));
  const f = fixture(TEE);
  const original = await f.seed();
  await expect(verifyTinyCloudDelegation({ ...original.delegation, delegationCid: "bafy-invalid-fixture-cid" }, bindings)).rejects.toThrow("integrity");
});
