import { describe, expect, test } from "bun:test";
import { createWebSignInPrefetch } from "./webSignInPrefetch";

const backend = "https://api.example.test";
const address = "0x1234567890123456789012345678901234567890";

describe("web sign-in prefetch", () => {

  test("replaces a prefetch that expires just before SDK signing with a bound nonce", async () => {
    let now = 1_000;
    const owners: (string | undefined)[] = [];
    const attempt = createWebSignInPrefetch(backend, {
      now: () => now,
      requestNonce: async (_url, owner) => { owners.push(owner); return owner ? "fresh" : "old"; },
    });
    now += 4 * 60_000;
    expect(await attempt.nonceForSigning(address)).toBe("fresh");
    expect(owners).toEqual([undefined, address]);
  });

  test("refuses a nonce that ages out while the SDK prepares the SIWE signature", async () => {
    let now = 0;
    const attempt = createWebSignInPrefetch(backend, {
      now: () => now,
      requestNonce: async () => "nonce",
    });
    expect(await attempt.nonceForSigning(address)).toBe("nonce");
    const provider = {
      on() {},
      removeListener() {},
      async request() { return "signature"; },
    };
    const guarded = attempt.guardSigning(provider);
    expect(await guarded.request({ method: "personal_sign", params: ["0x00"] })).toBe("signature");
    now = 4 * 60_000;
    await expect(guarded.request({ method: "personal_sign", params: ["0x00"] })).rejects.toThrow(/nonce expired/i);
    expect(await guarded.request({ method: "eth_chainId" })).toBe("signature");
  });

  test("a verified client keeps its signer after prefetch cleanup, but abandoned attempts fail closed", async () => {
    let now = 0;
    let signCalls = 0;
    const services = {
      now: () => now,
      requestNonce: async () => "nonce",
    };
    const provider = {
      on() {},
      removeListener() {},
      async request() { signCalls++; return "signature"; },
    };
    const completed = createWebSignInPrefetch(backend, services);
    await completed.nonceForSigning(address);
    const retainedSigner = completed.guardSigning(provider);
    await retainedSigner.request({ method: "personal_sign", params: ["login"] });
    completed.complete();
    completed.cancel(); // App's finally runs after publishing the SDK client.
    now = 4 * 60_000;
    expect(await retainedSigner.request({ method: "personal_sign", params: ["host-secrets"] })).toBe("signature");
    expect(signCalls).toBe(2);

    const abandoned = createWebSignInPrefetch(backend, services);
    await abandoned.nonceForSigning(address);
    const abandonedSigner = abandoned.guardSigning(provider);
    abandoned.cancel();
    await expect(abandonedSigner.request({ method: "personal_sign", params: ["abandoned"] })).rejects.toThrow(/cancelled/i);
    expect(signCalls).toBe(2);
  });

  test("never reuses a nonce within or across cancelled attempts", async () => {
    const firstNonce = Promise.withResolvers<string>();
    let requests = 0;
    const services = {
      requestNonce: async () => ++requests === 1 ? firstNonce.promise : `nonce-${requests}`,
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
    const attempt = createWebSignInPrefetch(backend, {
      requestNonce: () => nonce.promise,
    });
    attempt.cancel();
    nonce.reject(new Error("network down"));
    await Promise.allSettled([nonce.promise]);
    await expect(attempt.manifest()).rejects.toThrow(/cancelled/i);
  });

});
