import { expect, test } from "bun:test";
import type { ISessionStorage, TinyCloudWeb } from "@tinycloud/web-sdk";
import type { TinyCloudWebConfig } from "@tinyboilerplate/client";
import { reauthorizeHome, type HomeReauthorizeDeps } from "./homeReauthorize";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";
import { createWebSignInPrefetch } from "./webSignInPrefetch";

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const storage = {
  load: async () => null, save: async () => {}, clear: async () => {}, exists: () => false, isAvailable: () => true,
} as unknown as ISessionStorage;

function run(authorize: (siwe: string, advance: (ms: number) => void) => Promise<void>) {
  let now = 0;
  const seen: { config: TinyCloudWebConfig | null; signInArgs: unknown[]; authorizeCalls: number } = { config: null, signInArgs: [], authorizeCalls: 0 };
  const openkey = {
    authorizeTinyCloud: async (request: { siwe: string }) => {
      seen.authorizeCalls++;
      await authorize(request.siwe, (ms) => { now += ms; });
      return { signature: "0x" };
    },
  };
  const prefetch = createWebSignInPrefetch("http://backend.invalid", { now: () => now, requestNonce: async () => "nonce-1" });
  const deps: HomeReauthorizeDeps = {
    connect: async () => ({ address: ADDRESS, openkey: openkey as never, web3Provider: { on() {}, removeListener() {}, request: async () => null } }),
    prefetch,
    createTcw: (_provider, config) => {
      seen.config = config;
      return {
        signIn: async (...args: unknown[]) => {
          seen.signInArgs = args;
          await (config.openkey!.client as unknown as typeof openkey).authorizeTinyCloud({ siwe: "siwe" });
          return { siwe: "siwe", signature: "signature" };
        },
        hasPermissions: () => true,
        cleanup: () => {},
      } as unknown as TinyCloudWeb;
    },
    verify: async () => ({ token: "bearer", expiresIn: 3600 }),
    sessionStorage: storage,
  };
  return { seen, result: reauthorizeHome(deps, { address: ADDRESS, features: ["connectors"], config: { autoCreateSpace: true }, canCommit: () => null }) };
}

test("the Connectors re-sign goes through OpenKey's versioned authorization: its client in the frame, the nonce in the SIWE config, and no sign-in options", async () => {
  const { seen, result } = run(async () => {});
  expect((await result).outcome).toBe("granted");
  expect(seen.config?.openkey?.mode).toBe("iframe");
  expect(seen.config?.siweConfig).toEqual({ nonce: "nonce-1" });
  expect(seen.signInArgs).toEqual([]);
  expect(seen.authorizeCalls).toBe(1);
  void WEB_APP_MANIFEST;
});

test("a nonce that ages out on OpenKey's screen fails the re-sign instead of reaching the backend", async () => {
  const { result } = run(async (_siwe, advance) => { advance(4 * 60_000); });
  expect((await result).outcome).toBe("failed");
});

test("an approval narrowed in OpenKey's review is not kept: the outcome says so, nothing is verified, and the new session is cleaned up", async () => {
  let cleaned = 0;
  let verified = 0;
  const deps: HomeReauthorizeDeps = {
    connect: async () => ({ address: ADDRESS, openkey: { authorizeTinyCloud: async () => ({}) } as never, web3Provider: { on() {}, removeListener() {}, request: async () => null } }),
    prefetch: createWebSignInPrefetch("http://backend.invalid", { requestNonce: async () => "nonce-1" }),
    createTcw: () => ({
      signIn: async () => ({ siwe: "siwe", signature: "signature" }),
      hasPermissions: () => false, // OpenKey signed less than was asked
      cleanup: () => { cleaned++; },
    }) as unknown as TinyCloudWeb,
    verify: async () => { verified++; return { token: "bearer", expiresIn: 3600 }; },
    sessionStorage: storage,
  };
  const result = await reauthorizeHome(deps, { address: ADDRESS, features: ["connectors"], config: { autoCreateSpace: true }, canCommit: () => null });
  expect(result.outcome).toBe("narrowed");
  expect(verified).toBe(0);
  expect(cleaned).toBe(1);
});
