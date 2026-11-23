import { expect, spyOn, test } from "bun:test";
import { loadRenewalReceipt, saveRenewalReceipt } from "@tinyboilerplate/client";
import type { ISessionStorage, Manifest, TinyCloudWeb } from "@tinycloud/web-sdk";
import { Window } from "happy-dom";
import { installDom } from "@/test/dom";
import { connectorKeyDecryptGrants, encryptionDecryptGrant } from "./connectors/encryptionGrant";
import { webSignInManifest } from "./homeFeatures";
import { reauthorizeHome, type HomeReauthorizeDeps } from "./homeReauthorize";
import { fixture } from "./renewalReceipt.fixture";
import { carriesWholeNetworkDecrypt, webSignInGrantWindow, webSignInRenewal } from "./renewalReceipt";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";

const DAY_MS = 86_400_000;
const HOST = "http://127.0.0.1:9";
const ADDRESS = "0x00000000000000000000000000000000000000a1";
const ASK = { version: 1, leaseLifetimeSeconds: 90 * 86_400, purpose: "standing" };

const exactKeysOnly: Manifest = { ...WEB_APP_MANIFEST, permissions: [...(WEB_APP_MANIFEST.permissions ?? []), ...connectorKeyDecryptGrants(ADDRESS)] } as Manifest;
const wholeNetworkOnly: Manifest = { ...WEB_APP_MANIFEST, permissions: [...(WEB_APP_MANIFEST.permissions ?? []), encryptionDecryptGrant(ADDRESS)] } as Manifest;
const manifests = {
  base: webSignInManifest(WEB_APP_MANIFEST, [], ADDRESS),
  exactKeysOnly,
  wholeNetworkOnly,
  connectors: webSignInManifest(WEB_APP_MANIFEST, ["connectors"], ADDRESS),
};

async function requestFor(manifest: Manifest, result: unknown = {}) {
  const requests: Record<string, unknown>[] = [];
  const openkey = { authorizeTinyCloud: async (request: Record<string, unknown>) => { requests.push(request); return result; } };
  const renewal = webSignInRenewal(openkey as never, manifest);
  await renewal.config.openkey.client.authorizeTinyCloud({ siwe: "draft" } as never, { mode: "iframe" } as never);
  return { request: requests[0], renewal };
}

test("a grant with decrypt on a whole encryption network is asked without the renewal lease, and one with exact keys only keeps it", async () => {
  expect(carriesWholeNetworkDecrypt(manifests.base)).toBe(false);
  expect(carriesWholeNetworkDecrypt(manifests.exactKeysOnly)).toBe(false);
  expect(carriesWholeNetworkDecrypt(manifests.wholeNetworkOnly)).toBe(true);
  expect(carriesWholeNetworkDecrypt(manifests.connectors)).toBe(true);
  expect((await requestFor(manifests.base)).request.renewal).toEqual(ASK);
  expect((await requestFor(manifests.exactKeysOnly)).request.renewal).toEqual(ASK);
  expect(await requestFor(manifests.wholeNetworkOnly).then(({ request }) => request)).not.toHaveProperty("renewal");
  expect(await requestFor(manifests.connectors).then(({ request }) => request)).not.toHaveProperty("renewal");
});

test("the signed window does not depend on whether the lease is asked", async () => {
  expect((await requestFor(manifests.connectors)).renewal.config.sessionExpirationMs).toBe(7 * DAY_MS);
  expect((await requestFor(manifests.exactKeysOnly)).renewal.config.sessionExpirationMs).toBe(7 * DAY_MS);
  expect((await requestFor(manifests.base)).renewal.config.sessionExpirationMs).toBe(webSignInGrantWindow(manifests.base));
});

test("a receipt that arrives for a whole-network grant anyway is not admitted or kept", async () => {
  const { owner, receipt } = await fixture();
  const restoreDom = installDom({ localStorage: new Window().localStorage });
  const node = spyOn(globalThis, "fetch");
  try {
    const { renewal } = await requestFor(manifests.connectors, { renewal: receipt });
    expect(await renewal.admit({ activeNodeIdentity: async () => ({ origin: HOST }) } as never, owner.address)).toBe(false);
    expect(node).not.toHaveBeenCalled();
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  } finally {
    node.mockRestore();
    restoreDom();
  }
});

test("the in-place Connectors ask for a grant with whole-network decrypt asks for no lease, admits none and keeps no receipt", async () => {
  const { owner, record, receipt } = await fixture();
  const restoreDom = installDom({ localStorage: new Window().localStorage });
  let saved: typeof record | null = null;
  const storage: ISessionStorage = {
    save: async (_address, session) => { saved = session; },
    load: async () => saved,
    clear: async () => { saved = null; },
    exists: () => saved !== null,
    isAvailable: () => true,
  };
  saveRenewalReceipt(owner.address, { version: 1, previousGrant: true });
  const requests: Record<string, unknown>[] = [];
  const node = spyOn(globalThis, "fetch");
  try {
    const services: HomeReauthorizeDeps = {
      connect: async () => ({
        address: owner.address,
        openkey: { authorizeTinyCloud: async (request: Record<string, unknown>) => { requests.push(request); return { renewal: receipt }; } } as never,
        web3Provider: { request: async () => { throw new Error("no wallet request expected"); } },
      }),
      prefetch: {
        manifest: async () => WEB_APP_MANIFEST,
        nonceForSigning: async () => "noLeaseNonce1",
        guardSigning: (provider) => provider,
        complete: () => {},
        cancel: () => {},
      },
      createTcw: ((_provider: unknown, config: Parameters<HomeReauthorizeDeps["createTcw"]>[1]) => ({
        signIn: async () => {
          await config.openkey!.client.authorizeTinyCloud({ siwe: "draft" } as never, { mode: "iframe" });
          await config.sessionStorage!.save(owner.address, record);
          return { siwe: "signed", signature: "signature" };
        },
        hasPermissions: () => true,
        activeNodeIdentity: async () => ({ origin: HOST }),
      }) as unknown as TinyCloudWeb) as HomeReauthorizeDeps["createTcw"],
      renewalSignIn: webSignInRenewal,
      verify: async () => ({ token: "bearer", expiresIn: 3600 }),
      sessionStorage: storage,
    };
    const result = await reauthorizeHome(services, {
      address: owner.address,
      features: ["connectors"],
      config: { autoCreateSpace: false, tinycloudHosts: [HOST], tinycloudRegistryUrl: HOST, newUserHost: HOST },
      canCommit: () => null,
    });
    expect(result.outcome).toBe("granted");
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("renewal");
    expect(node).not.toHaveBeenCalled();
    expect(saved).toBe(record);
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  } finally {
    node.mockRestore();
    restoreDom();
  }
});
