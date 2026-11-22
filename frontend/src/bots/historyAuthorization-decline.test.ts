// TC-3887: a decline of the encryption request is remembered for the page session, so the request is not made again
// until the owner asks for it (the "Review request" button clears it).
import { beforeEach, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { connectWallet } from "@tinyboilerplate/client";
import { authorizeBotHistory, clearHistoryDecline, HISTORY_DECLINED, isHistoryDeclined } from "./historyAuthorization";

const address = "0x" + "77".repeat(20);

function fixture() {
  let allowed = false, approve = false, requests = 0;
  const session = { address, chainId: 1, sessionKey: "key-1", siwe: `Expiration Time: ${new Date(Date.now() + 3_600_000).toISOString()}` };
  const client = {
    session: () => ({ ...session }), hasPermissions: () => allowed, setRuntimePermissionSigner: () => {},
    requestPermissions: async () => { requests++; allowed = approve; return { approved: approve }; },
    ensureEncryptionNetwork: async () => {},
  } as unknown as TinyCloudWeb;
  const connect = (async () => ({ address, openkey: { signMessage: async () => ({ signature: "fixture" }) } })) as unknown as typeof connectWallet;
  return { client, connect, requests: () => requests, approveNext: () => { approve = true; } };
}
const enabled = async () => ({ enabled: true });

beforeEach(clearHistoryDecline);

test("after a decline the request is not made again until the owner asks for it", async () => {
  const f = fixture();
  await expect(authorizeBotHistory(f.client, f.connect, enabled)).rejects.toThrow(HISTORY_DECLINED);
  expect(f.requests()).toBe(1);
  for (let i = 0; i < 3; i++) {
    const again = await authorizeBotHistory(f.client, f.connect, enabled).catch((cause: unknown) => cause);
    expect(isHistoryDeclined(again)).toBe(true);
  }
  expect(f.requests()).toBe(1);

  clearHistoryDecline();
  f.approveNext();
  await authorizeBotHistory(f.client, f.connect, enabled);
  expect(f.requests()).toBe(2);
});

test("a decline by one session does not stop another owner's request", async () => {
  const first = fixture();
  await expect(authorizeBotHistory(first.client, first.connect, enabled)).rejects.toThrow(HISTORY_DECLINED);
  const second = fixture();
  (second.client as unknown as { session: () => unknown }).session = () => ({ address, chainId: 1, sessionKey: "key-2", siwe: `Expiration Time: ${new Date(Date.now() + 3_600_000).toISOString()}` });
  await expect(authorizeBotHistory(second.client, second.connect, enabled)).rejects.toThrow(HISTORY_DECLINED);
  expect(second.requests()).toBe(1);
});
