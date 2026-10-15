import { describe, expect, test } from "bun:test";
import { createWebSignInPrefetch } from "./webSignInPrefetch";

const backend = "https://api.example.test";
const address = "0x1234567890123456789012345678901234567890";
const manifest = { app_id: "chat.example", name: "Chat", defaults: false };

describe("web sign-in prefetch", () => {
  test("starts nonce and manifest while OpenKey connect is pending, then uses the same manifest", async () => {
    const connect = Promise.withResolvers<void>();
    const calls: string[] = [];
    const attempt = createWebSignInPrefetch(backend, {
      requestNonce: async (_url, owner) => { calls.push(`nonce:${owner ?? "unbound"}`); return "prefetched"; },
      loadManifest: async (url) => { calls.push(`manifest:${url}`); return manifest; },
    });
    expect(calls).toEqual(["nonce:unbound", `manifest:${backend}/api/manifest`]);
    connect.resolve();
    expect(await connect.promise.then(() => attempt.manifest())).toEqual(manifest);
    // The connection's completion does not cause a second manifest request.
    expect(await attempt.nonceForSigning(address)).toBe("prefetched");
    expect(calls).toHaveLength(2);
  });

  test("replaces a prefetch that expires just before SDK signing with a bound nonce", async () => {
    let now = 1_000;
    const owners: (string | undefined)[] = [];
    const attempt = createWebSignInPrefetch(backend, {
      now: () => now,
      requestNonce: async (_url, owner) => { owners.push(owner); return owner ? "fresh" : "old"; },
      loadManifest: async () => manifest,
    });
    expect(await attempt.manifest()).toEqual(manifest);
    now += 4 * 60_000;
    expect(await attempt.nonceForSigning(address)).toBe("fresh");
    expect(owners).toEqual([undefined, address]);
  });

  test("refuses a nonce that ages out while the SDK prepares the SIWE signature", async () => {
    let now = 0;
    const attempt = createWebSignInPrefetch(backend, {
      now: () => now,
      requestNonce: async () => "nonce",
      loadManifest: async () => manifest,
    });
    expect(await attempt.nonceForSigning(address)).toBe("nonce");
    const provider = {
      on() {},
      removeListener() {},
      async request() { return "signature"; },
    };
    const guarded = attempt.guardSigning(provider);
    now = 4 * 60_000;
    await expect(guarded.request({ method: "personal_sign", params: ["0x00"] })).rejects.toThrow(/nonce expired/i);
    expect(await guarded.request({ method: "eth_chainId" })).toBe("signature");
  });

  test("never reuses a nonce within or across cancelled attempts", async () => {
    const firstNonce = Promise.withResolvers<string>();
    let requests = 0;
    const services = {
      requestNonce: async () => ++requests === 1 ? firstNonce.promise : `nonce-${requests}`,
      loadManifest: async () => manifest,
    };
    const old = createWebSignInPrefetch(backend, services);
    old.cancel();
    firstNonce.resolve("abandoned");
    await expect(old.nonceForSigning(address)).rejects.toThrow(/cancelled/i);
    const current = createWebSignInPrefetch(backend, services);
    expect(await current.nonceForSigning(address)).toBe("nonce-2");
    await expect(current.nonceForSigning(address)).rejects.toThrow(/already used/i);
    expect(requests).toBe(2);
  });

  test("a rejected prefetch after cancellation is handled, not an unhandled rejection", async () => {
    const nonce = Promise.withResolvers<string>();
    const appManifest = Promise.withResolvers<typeof manifest>();
    const attempt = createWebSignInPrefetch(backend, {
      requestNonce: () => nonce.promise,
      loadManifest: () => appManifest.promise,
    });
    attempt.cancel();
    nonce.reject(new Error("network down"));
    appManifest.reject(new Error("manifest down"));
    await Promise.allSettled([nonce.promise, appManifest.promise]);
    await expect(attempt.manifest()).rejects.toThrow(/cancelled/i);
  });

  test("manifest failure during connect is surfaced after connect, without signing", async () => {
    const attempt = createWebSignInPrefetch(backend, {
      requestNonce: async () => "unused",
      loadManifest: async () => { throw new Error("invalid manifest"); },
    });
    await expect(attempt.manifest()).rejects.toThrow("invalid manifest");
  });
});
