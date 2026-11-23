import { expect, test, spyOn } from "bun:test";
import { createTinyCloudWeb, loadRenewalReceipt, saveRenewalReceipt } from "@tinyboilerplate/client";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
import { BrowserSessionStorage, type ISessionStorage, type TinyCloudWeb } from "@tinycloud/web-sdk";
import { Window } from "happy-dom";
import { installDom } from "@/test/dom";
import { atOrigin } from "@/test/productOrigin";
import { encryptionDecryptGrant } from "./connectors/encryptionGrant";
import { webSignInManifest } from "./homeFeatures";
import { reauthorizeHome, type HomeReauthorizeDeps } from "./homeReauthorize";
import { fixture } from "./renewalReceipt.fixture";
import { webSignInGrantWindow, webSignInRenewal } from "./renewalReceipt";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";

const DAY_MS = 86_400_000;
const HOST = "http://127.0.0.1:9";
const NONCE = "connectorRenewal1";

function deps(owner: Awaited<ReturnType<typeof fixture>>["owner"], authorizeTinyCloud: (request: { siwe: string }) => Promise<unknown>): HomeReauthorizeDeps {
  return {
    connect: async () => ({
      address: owner.address,
      openkey: { authorizeTinyCloud },
      web3Provider: {
        request: async ({ method }) => {
          if (method === "eth_accounts" || method === "eth_requestAccounts") return [owner.address];
          if (method === "eth_chainId") return "0x1";
          throw new Error(`Unexpected wallet request: ${method}`);
        },
      },
    }),
    prefetch: {
      manifest: async () => WEB_APP_MANIFEST,
      nonceForSigning: async () => NONCE,
      guardSigning: (provider) => provider,
      complete: () => {},
      cancel: () => {},
    },
    createTcw: createTinyCloudWeb,
    renewalSignIn: webSignInRenewal,
    verify: async () => ({ token: "bearer", expiresIn: 3600 }),
  };
}

function input(address: string): Parameters<typeof reauthorizeHome>[1] {
  return {
    address,
    features: ["connectors"],
    config: { autoCreateSpace: false, tinycloudHosts: [HOST], tinycloudRegistryUrl: HOST, newUserHost: HOST },
    canCommit: () => null,
  };
}

test("the web grant window is seven days for network decrypt or secrets and thirty days for the base grant", async () => {
  const { owner } = await fixture();
  const base = webSignInManifest(WEB_APP_MANIFEST, [], owner.address);
  const connectors = webSignInManifest(WEB_APP_MANIFEST, ["connectors"], owner.address);
  const decrypt = encryptionDecryptGrant(owner.address);
  expect(webSignInGrantWindow(base)).toBe(30 * DAY_MS);
  expect(webSignInGrantWindow(connectors)).toBe(7 * DAY_MS);
  expect(webSignInGrantWindow({ ...base, secrets: WEB_APP_MANIFEST.secrets })).toBe(7 * DAY_MS);
  expect(webSignInGrantWindow({ ...base, permissions: [decrypt] })).toBe(7 * DAY_MS);
  expect(webSignInGrantWindow({ ...base, permissions: [{ ...decrypt, path: `${decrypt.path}/secrets/shared`, actions: ["key.create"] }] })).toBe(7 * DAY_MS);
  expect(webSignInGrantWindow({
    ...base,
    permissions: [{ service: "tinycloud.kv", space: "secrets", path: "vault/secrets/EXAMPLE", skipPrefix: true, actions: ["get"] }],
  })).toBe(7 * DAY_MS);
});

test("the SDK asks OpenKey for renewal with a seven-day draft and saves the approved Connectors session", async () => {
  const { owner } = await fixture();
  const restoreDom = installDom({ localStorage: new Window().localStorage });
  atOrigin();
  const node = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/v2/locations/") || path.startsWith("/v1/locations/")) {
      return Response.json({ error: "location record not found" }, { status: 404 });
    }
    return Response.json(path === "/info" ? {
      protocol: 1, version: "test", features: ["kv", "delegation", "sql", "hooks", "encryption", "encryption-named-keys-v1"],
      nodeId: "did:key:z6MkvSbonMn1Xgewrb4EsbjTmvMT8T9Y3PTb5PcnQcQUbzjc",
    } : {});
  });
  try {
    const authorize = spyOn({
      async approve({ siwe }: { siwe: string }) {
        const permissions = Object.entries(extractRecapAttenuations(siwe)).flatMap(([resource, grants]) => {
          const { space, path } = parseCanonicalRecapResource(resource);
          const byService = Map.groupBy(Object.keys(grants), (action) => action.split("/")[0]);
          return [...byService].map(([service, actions]) => ({ service, space, path, actions }));
        });
        const selectedActionKeys = permissions.flatMap(({ service, space, path, actions }) =>
          actions.map((action) => [service, space, path, action].join("\0")));
        return {
          protocolVersion: 1, address: owner.address, signedMessage: siwe, signature: await owner.signMessage({ message: siwe }),
          permissions, selectedActionKeys,
        };
      },
    }, "approve");
    const result = await reauthorizeHome(deps(owner, authorize), input(owner.address));
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0]).toEqual([expect.objectContaining({
      expiryChangeable: true,
      renewal: { version: 1, leaseLifetimeSeconds: 90 * 86_400, purpose: "standing" },
      siwe: expect.stringContaining(`Nonce: ${NONCE}`),
    }), { mode: "iframe" }]);
    const { siwe } = authorize.mock.calls[0][0];
    const date = (field: string) => Date.parse(new RegExp(`^${field}: (.+)$`, "m").exec(siwe)![1]);
    const start = siwe.includes("\nNot Before: ") ? date("Not Before") : date("Issued At");
    expect(date("Expiration Time") - start).toBe(7 * DAY_MS);
    expect(result.outcome).toBe("granted");
    expect(await new BrowserSessionStorage().load(owner.address)).toMatchObject({ siwe });
    if (result.outcome === "granted") result.tcw.cleanup();
  } finally {
    node.mockRestore();
    restoreDom();
  }
}, 30_000);

test.each([true, false])("Connectors commits the session and handles renewal admission (node accepts: %s)", async (accepted) => {
  const { owner, record, receipt } = await fixture();
  const restoreDom = installDom({ localStorage: new Window().localStorage });
  const oldRecord = { ...record, tinycloudSession: undefined };
  const oldReceipt = { version: 1, previousGrant: true };
  let saved: typeof record | null = oldRecord;
  const storage: ISessionStorage = {
    save: async (_address, session) => { saved = session; },
    load: async () => saved,
    clear: async () => { saved = null; },
    exists: () => saved !== null,
    isAvailable: () => true,
  };
  saveRenewalReceipt(owner.address, oldReceipt);
  const requests: string[] = [];
  const node = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    requests.push(String(url));
    expect(saved).toBe(record);
    expect(loadRenewalReceipt(owner.address)).toBeNull();
    expect(init?.signal?.aborted).toBe(false);
    return String(url).endsWith("/delegate")
      ? Response.json({}, { status: accepted ? 200 : 403 })
      : Response.json(receipt.receipt.nodeIdentity);
  });
  try {
    const services = deps(owner, async () => ({ renewal: receipt }));
    services.sessionStorage = storage;
    services.createTcw = (_provider, config) => ({
      signIn: async () => {
        await config.openkey!.client.authorizeTinyCloud({ siwe: "draft" } as never, { mode: "iframe" });
        await config.sessionStorage!.save(owner.address, record);
        expect(saved).toBe(oldRecord);
        return { siwe: "signed", signature: "signature" };
      },
      hasPermissions: () => true,
      activeNodeIdentity: async () => ({ origin: HOST }),
    }) as unknown as TinyCloudWeb;
    const result = await reauthorizeHome(services, input(owner.address));
    if (result.outcome !== "granted") throw new Error(result.outcome);
    expect(requests).toEqual([`${HOST}/.well-known/tinycloud/node-keys`, `${HOST}/delegate`]);
    expect(saved).toBe(record);
    expect(loadRenewalReceipt(owner.address)).toEqual(accepted ? receipt : null);
    expect(await result.rollback()).toBe(true);
    expect(saved).toBe(oldRecord);
    expect(loadRenewalReceipt(owner.address)).toEqual(oldReceipt);
  } finally {
    node.mockRestore();
    restoreDom();
  }
});
