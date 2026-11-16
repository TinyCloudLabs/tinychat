import { expect, test } from "bun:test";
import { createWebSignInPrefetch, guardOpenKey } from "./webSignInPrefetch";

const address = "0x00000000000000000000000000000000000000a1";

function client() {
  const calls: { method: string; args: unknown[]; self: unknown }[] = [];
  const self = {
    tag: "openkey",
    async authorizeTinyCloud(...args: unknown[]) { calls.push({ method: "authorizeTinyCloud", args, self: this }); return { ok: true }; },
    async connect() { calls.push({ method: "connect", args: [], self: this }); return { address }; },
  };
  return { self, calls };
}

test("the guarded client authorizes while the nonce is fresh, forwarding the request and keeping the client as `this`", async () => {
  const prefetch = createWebSignInPrefetch("http://backend.invalid", { now: () => 0, requestNonce: async () => "nonce" });
  await prefetch.nonceForSigning(address);
  const { self, calls } = client();
  const guarded = guardOpenKey(prefetch, self);
  expect(await guarded.authorizeTinyCloud({ siwe: "s" }, { mode: "iframe" })).toEqual({ ok: true });
  expect(calls[0]).toEqual({ method: "authorizeTinyCloud", args: [{ siwe: "s" }, { mode: "iframe" }], self });
});

test("every other member of the client is passed through, and still runs on the client", async () => {
  const prefetch = createWebSignInPrefetch("http://backend.invalid", { requestNonce: async () => "nonce" });
  await prefetch.nonceForSigning(address);
  const { self, calls } = client();
  const guarded = guardOpenKey(prefetch, self);
  expect(guarded.tag).toBe("openkey");
  expect(await guarded.connect()).toEqual({ address });
  expect(calls[0]!.self).toBe(self);
});

test("it refuses before OpenKey opens when the nonce is already too old, or the attempt is cancelled", async () => {
  let now = 0;
  const old = createWebSignInPrefetch("http://backend.invalid", { now: () => now, requestNonce: async () => "nonce" });
  await old.nonceForSigning(address);
  now = 4 * 60_000;
  const first = client();
  await expect(guardOpenKey(old, first.self).authorizeTinyCloud({})).rejects.toThrow(/nonce expired/i);
  expect(first.calls).toEqual([]);

  const cancelled = createWebSignInPrefetch("http://backend.invalid", { requestNonce: async () => "nonce" });
  await cancelled.nonceForSigning(address);
  cancelled.cancel();
  const second = client();
  await expect(guardOpenKey(cancelled, second.self).authorizeTinyCloud({})).rejects.toThrow(/cancelled/i);
  expect(second.calls).toEqual([]);
});

test("it refuses the approval that comes back after the nonce aged out, so the backend never sees a stale nonce", async () => {
  let now = 0;
  const prefetch = createWebSignInPrefetch("http://backend.invalid", { now: () => now, requestNonce: async () => "nonce" });
  await prefetch.nonceForSigning(address);
  const slow = { async authorizeTinyCloud() { now = 4 * 60_000; return { ok: true }; } };
  await expect(guardOpenKey(prefetch, slow).authorizeTinyCloud()).rejects.toThrow(/nonce expired/i);
});
