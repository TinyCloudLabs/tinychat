import { expect, test } from "bun:test";
import { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { connectWallet } from "@tinyboilerplate/client";
import { authorizeBotHistory } from "./historyAuthorization";

const owner = "0x" + "11".repeat(20);
const otherOwner = "0x" + "22".repeat(20);
type Session = NonNullable<ReturnType<TinyCloudWeb["session"]>>;
async function fixture() {
  const node: { session?: Session } = { session: { address: owner, walletAddress: owner, chainId: 1, sessionKey: "session-key-1",
    siwe: `Expiration Time: ${new Date(Date.now() + 3_600_000).toISOString()}`, signature: "fixture" } };
  const client = new TinyCloudWeb({ ui: false, persistSession: false });
  await (client as unknown as { _initPromise: Promise<void> })._initPromise;
  let allowed = false, approvals = 0, networks = 0, signers = 0;
  let duringApproval = () => {};
  // Keep the installed SDK's real session() implementation: it projects a fresh object from this backing session.
  Object.assign(client, { _node: node, hasPermissions: () => allowed,
    setRuntimePermissionSigner: () => { signers++; },
    requestPermissions: async () => { approvals++; duringApproval(); allowed = true; return { approved: true }; },
    ensureEncryptionNetwork: async () => { networks++; },
  });
  const connect = (async () => ({ address: owner, openkey: { signMessage: async () => ({ signature: "fixture" }) } })) as unknown as typeof connectWallet;
  return { client, node, connect, counts: () => ({ approvals, networks, signers }),
    duringApproval: (callback: () => void) => { duringApproval = callback; } };
}
const enabled = async () => ({ enabled: true });

test("first-use approval accepts fresh equal snapshots from the installed web-sdk session getter", async () => {
  const f = await fixture();
  expect(f.client.session()).not.toBe(f.client.session());
  expect(f.client.session()).toEqual(f.client.session());
  await authorizeBotHistory(f.client, f.connect, enabled);
  expect(f.counts()).toEqual({ approvals: 1, networks: 1, signers: 1 });
});

test("a different connected owner aborts before installing a signer or asking for permission", async () => {
  const f = await fixture();
  const connect = (async () => ({ ...await f.connect(), address: otherOwner })) as typeof connectWallet;
  await expect(authorizeBotHistory(f.client, connect, enabled)).rejects.toThrow("history_owner_changed");
  expect(f.counts()).toEqual({ approvals: 0, networks: 0, signers: 0 });
});

for (const change of [{ address: otherOwner }, { sessionKey: "session-key-2" }, { chainId: 2 }]) {
  test(`a change in ${Object.keys(change)[0]} during connect aborts before approval`, async () => {
    const f = await fixture();
    const connect = (async () => { Object.assign(f.node.session!, change); return f.connect(); }) as typeof connectWallet;
    await expect(authorizeBotHistory(f.client, connect, enabled)).rejects.toThrow("history_owner_changed");
    expect(f.counts()).toEqual({ approvals: 0, networks: 0, signers: 0 });
  });
  test(`a change in ${Object.keys(change)[0]} during permission approval aborts before network setup`, async () => {
    const f = await fixture();
    f.duringApproval(() => { Object.assign(f.node.session!, change); });
    await expect(authorizeBotHistory(f.client, f.connect, enabled)).rejects.toThrow("history_authority_missing");
    expect(f.counts().networks).toBe(0);
  });
}

test("sign-out during connect aborts before installing a signer or asking for permission", async () => {
  const f = await fixture();
  const connect = (async () => { f.node.session = undefined; return f.connect(); }) as typeof connectWallet;
  await expect(authorizeBotHistory(f.client, connect, enabled)).rejects.toThrow("history_owner_changed");
  expect(f.counts()).toEqual({ approvals: 0, networks: 0, signers: 0 });
});
