import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { authorizeBotHistory, botHistoryOwnerPermissions } from "./historyAuthorization";
import type { connectWallet } from "@tinyboilerplate/client";
const address = "0x" + "11".repeat(20);
function fixture(approved = true) {
  let allowed = false, connects = 0, creates = 0;
  const requests: unknown[] = [];
  const session = { address, siwe: `Expiration Time: ${new Date(Date.now() + 3_600_000).toISOString()}` };
  const client = { session: () => session, hasPermissions: () => allowed, setRuntimePermissionSigner: () => {},
    requestPermissions: async (permissions: unknown, options: { expiryMs: number }) => { requests.push({ permissions, options }); allowed = approved; return { approved }; },
    ensureEncryptionNetwork: async () => { creates++; },
  } as unknown as TinyCloudWeb;
  const connect = (async () => { connects++; return { address, openkey: { signMessage: async () => ({ signature: "fixture" }) } }; }) as unknown as typeof connectWallet;
  return { client, connect, requests, connects: () => connects, creates: () => creates };
}
test("disabled accounts never connect, request history authority or initialize a network", async () => {
  const f = fixture();
  await expect(authorizeBotHistory(f.client, f.connect, async () => ({ enabled: false }))).rejects.toThrow("history_disabled");
  expect(f.connects()).toBe(0); expect(f.requests).toEqual([]); expect(f.creates()).toBe(0);
});
test("first foreground use requests only the owner's exact network with at most the session lifetime", async () => {
  const f = fixture();
  await authorizeBotHistory(f.client, f.connect, async () => ({ enabled: true }));
  expect(f.connects()).toBe(1);
  expect(f.requests).toEqual([{ permissions: botHistoryOwnerPermissions(address), options: { expiryMs: expect.any(Number) } }]);
  const lifetime = (f.requests[0] as { options: { expiryMs: number } }).options.expiryMs;
  expect(lifetime).toBeGreaterThan(0); expect(lifetime).toBeLessThanOrEqual(3_600_000);
  expect(botHistoryOwnerPermissions(address)[0]).toMatchObject({ path: `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`, actions: ["network.create", "decrypt"] });
  await authorizeBotHistory(f.client, f.connect, async () => ({ enabled: true }));
  expect(f.connects()).toBe(1);
});
test("declining owner approval never initializes the network or changes backend authority", async () => {
  const f = fixture(false);
  await expect(authorizeBotHistory(f.client, f.connect, async () => ({ enabled: true }))).rejects.toThrow("history_approval_declined");
  expect(f.creates()).toBe(0);
  expect(f.requests).toHaveLength(1);
});
