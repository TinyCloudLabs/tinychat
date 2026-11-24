// TC-4225: earlier (v1) history never costs the chat a network-wide decrypt. Opening the chat asks for the exact key
// (and the network only when it is missing); only "Move earlier history" asks for decrypt on the whole network, and
// a decline there hides earlier history without touching the chat's own authorization.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import type { connectWallet } from "@tinyboilerplate/client";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import { makePkhSpaceId } from "@tinycloud/sdk-core";

import { installDom } from "@/test/dom";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";
import { EARLIER_HISTORY_STRINGS } from "./botsStrings";
import { botHistoryDirectory } from "./botHistoryPath";
import { EarlierHistoryAction } from "./EarlierHistoryAction";
import {
  isEarlierHistoryHeld, recordHeldEarlierHistory, requestEarlierHistoryAccess, resetEarlierHistory, useEarlierHistory,
} from "./earlierHistory";
import { authorizeBotHistory, clearHistoryDecline } from "./historyAuthorization";
import { readBotHistory } from "./historyRead";

const address = `0x${"34".repeat(20)}`;
const networkId = encryptionNetworkId(address);
const session = {
  address, chainId: 1, sessionKey: "fixture", signature: "fixture",
  siwe: `URI: did:key:fixture\nExpiration Time: ${new Date(Date.now() + 30 * 86_400_000).toISOString()}`,
};
const descriptor = {
  networkId, keyPath: BOT_HISTORY_KEY_PATH, alg: "x25519-aes256gcm/v1", keyVersion: 1,
  publicEncryptionKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", kind: "deletable", state: "active",
} as const;
const enabled = async () => ({ enabled: true });
const connect = (async () => ({ address, openkey: { signMessage: async () => ({ signature: "x" }) } })) as unknown as typeof connectWallet;

const label = (permissions: PermissionEntry[]) => `${permissions[0]!.path}:${permissions[0]!.actions.join(",")}`;
const isNetworkDecrypt = (permissions: PermissionEntry[]) => permissions[0]!.path === networkId && permissions[0]!.actions.includes("decrypt");

/** A session whose grants are exactly those the owner approved: `approve` decides each request. */
function fixture(options: { network: boolean; approve?: (permissions: PermissionEntry[]) => boolean }) {
  const granted: string[] = [];
  const requests: PermissionEntry[][] = [];
  const kvCalls: string[] = [];
  const client = {
    session: () => ({ ...session }),
    hasPermissions: (permissions: PermissionEntry[]) => granted.includes(label(permissions)),
    requestPermissions: async (permissions: PermissionEntry[]) => {
      requests.push(permissions);
      const approved = options.approve?.(permissions) ?? true;
      if (approved) granted.push(label(permissions));
      return { approved };
    },
    setRuntimePermissionSigner() {},
    getEncryptionNetwork: async () => (options.network ? {} : undefined),
    ensureEncryptionNetwork: async () => {},
    keys: { ensureKey: async () => descriptor },
    kvForSpace: () => ({
      list: async () => { kvCalls.push("list"); return { ok: true, data: { keys: ["v1-record"], truncated: false } }; },
      get: async () => { kvCalls.push("get"); return { ok: true, data: { data: { v: 1 } } }; },
    }),
    signSessionBytes: async () => new Uint8Array(64),
  } as unknown as TinyCloudWeb;
  return { client, requests, kvCalls };
}

beforeEach(() => { clearHistoryDecline(); resetEarlierHistory(); });

test("opening the chat with v1 history present asks only for the exact key", async () => {
  const f = fixture({ network: true });
  await authorizeBotHistory(f.client, connect, enabled, { postDescriptor: async () => {} });
  expect(f.requests.map(label)).toEqual([`${networkId}/${BOT_HISTORY_KEY_PATH}:key.create,decrypt`]);
  expect(f.requests.some(isNetworkDecrypt)).toBe(false);
  expect(f.kvCalls).toEqual([]);
});

test("opening the chat adds network.create only when the network is missing, and still no network-wide decrypt", async () => {
  const f = fixture({ network: false });
  await authorizeBotHistory(f.client, connect, enabled, { postDescriptor: async () => {} });
  expect(f.requests.map(label)).toEqual([`${networkId}/${BOT_HISTORY_KEY_PATH}:key.create,decrypt`, `${networkId}:network.create`]);
  expect(f.requests.some(isNetworkDecrypt)).toBe(false);
});

async function thread(): Promise<{ client: TinyCloudWeb; granted: { network: boolean }; v1Opened: string[]; decryptCalls: { count: number } }> {
  const prefix = await botHistoryDirectory(address, "main");
  const owner = `did:pkh:eip155:1:${address.toLowerCase()}`;
  const spaceId = makePkhSpaceId(address, 1, "applications");
  const record = (seq: number, text: string, sealed: "v1" | "v2") => {
    const key = `${prefix}1/${seq}-c${seq}`;
    const batch = { v: 1, generation: "1", seq, challenge: `c${seq}`, record: { type: "user", text, at: `2026-11-14T00:00:0${seq}Z` } };
    const aad = btoa(JSON.stringify({ owner, spaceId, path: key }));
    const envelope = sealed === "v1" ? { aad, key } : { v: 2, keyPath: BOT_HISTORY_KEY_PATH, keyVersion: 1, networkId, aad, key };
    return { key, envelope, batch };
  };
  const records = [record(1, "earlier", "v1"), record(2, "current", "v2")];
  const granted = { network: false };
  const v1Opened: string[] = [];
  const decryptCalls = { count: 0 };
  const client = {
    session: () => ({ ...session }),
    hasPermissions: (permissions: PermissionEntry[]) => granted.network && isNetworkDecrypt(permissions),
    kvForSpace: () => ({
      list: async () => ({ ok: true, data: { keys: records.map(r => r.key), truncated: false } }),
      get: async (key: string) => ({ ok: true, data: { data: records.find(r => r.key === key)!.envelope } }),
    }),
    encryption: {
      // Without the network-wide grant the node refuses a v1 record.
      decryptEnvelope: async (envelope: { key: string }) => {
        decryptCalls.count++;
        if (!granted.network) return { ok: false };
        v1Opened.push(envelope.key);
        return { ok: true, data: new TextEncoder().encode(JSON.stringify(records.find(r => r.key === envelope.key)!.batch)) };
      },
    },
    keys: { decrypt: async (envelope: { key: string }) => new TextEncoder().encode(JSON.stringify(records.find(r => r.key === envelope.key)!.batch)) },
  } as unknown as TinyCloudWeb;
  return { client, granted, v1Opened, decryptCalls };
}

test("without the network-wide grant a read returns the chat on its own key and holds earlier records back", async () => {
  const { client, v1Opened, decryptCalls } = await thread();
  const messages = await readBotHistory(client, undefined, { reseal: true });
  expect(messages.map(message => message.text)).toEqual(["current"]);
  expect(v1Opened).toEqual([]);
  expect(decryptCalls.count).toBe(0);
  expect(isEarlierHistoryHeld("main")).toBe(true);
});

test("once the owner has granted the network, the same read returns earlier history too and nothing is held", async () => {
  const { client, granted } = await thread();
  await readBotHistory(client);
  expect(isEarlierHistoryHeld("main")).toBe(true);
  granted.network = true;
  const messages = await readBotHistory(client);
  expect(messages.map(message => message.text)).toEqual(["earlier", "current"]);
  expect(isEarlierHistoryHeld("main")).toBe(false);
});

test("a decrypt that fails with the network grant held still fails the read", async () => {
  const { client, granted } = await thread();
  granted.network = true;
  (client as unknown as { encryption: { decryptEnvelope: () => Promise<unknown> } }).encryption.decryptEnvelope = async () => ({ ok: false });
  await expect(readBotHistory(client)).rejects.toThrow("history_decrypt_unavailable");
});

test("with the grant held, a v1 record that fails to open fails the read and is not held back", async () => {
  const { client, granted } = await thread();
  granted.network = true;
  const real = (client as unknown as { encryption: { decryptEnvelope: (e: { key: string }) => Promise<unknown> } }).encryption;
  const open = real.decryptEnvelope;
  real.decryptEnvelope = async (envelope) => { if (envelope.key.endsWith("/1-c1")) throw new Error("tampered"); return open(envelope); };
  await expect(readBotHistory(client)).rejects.toThrow("tampered");
  expect(isEarlierHistoryHeld("main")).toBe(false);
});

test("the move action is the one request for decrypt on the whole network, with its own description", async () => {
  const f = fixture({ network: true });
  expect(await requestEarlierHistoryAccess(f.client, connect)).toBe(true);
  expect(f.requests).toEqual([[expect.objectContaining({ path: networkId, actions: ["decrypt"], description: EARLIER_HISTORY_STRINGS.approval })]]);
  expect(await requestEarlierHistoryAccess(f.client, connect)).toBe(true);
  expect(f.requests).toHaveLength(1);
});

test("declining the move leaves the chat's authorization working, and asks nothing more of the chat", async () => {
  const f = fixture({ network: true, approve: permissions => !isNetworkDecrypt(permissions) });
  expect(await requestEarlierHistoryAccess(f.client, connect)).toBe(false);
  await authorizeBotHistory(f.client, connect, enabled, { postDescriptor: async () => {} });
  expect(f.requests.map(label)).toEqual([`${networkId}:decrypt`, `${networkId}/${BOT_HISTORY_KEY_PATH}:key.create,decrypt`]);
});

test("a decline of the chat's own request does not block the move, and the other way round", async () => {
  const f = fixture({ network: true, approve: permissions => isNetworkDecrypt(permissions) });
  await expect(authorizeBotHistory(f.client, connect, enabled, { postDescriptor: async () => {} })).rejects.toThrow("history_approval_declined");
  expect(await requestEarlierHistoryAccess(f.client, connect)).toBe(true);
});

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

function Harness({ request, reload }: { request: () => Promise<boolean>; reload: () => Promise<void> }) {
  const earlier = useEarlierHistory("main", request, reload);
  return earlier ? <EarlierHistoryAction earlier={earlier} /> : <p>nothing held</p>;
}
const move = () => [...document.querySelectorAll("button")].find(node => node.textContent === EARLIER_HISTORY_STRINGS.move);

async function mount(request: () => Promise<boolean>, reload: () => Promise<void>) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(<Harness request={request} reload={reload} />));
}

test("nothing is offered until a read held earlier history back; declining keeps it hidden and the action available", async () => {
  const calls: string[] = [];
  await mount(async () => { calls.push("request"); return false; }, async () => { calls.push("reload"); });
  expect(document.body.textContent).toContain("nothing held");
  await act(async () => recordHeldEarlierHistory(address, "main", 2));
  expect(move()).toBeDefined();
  await act(async () => { move()!.click(); });
  expect(calls).toEqual(["request"]);
  expect(document.body.textContent).toContain(EARLIER_HISTORY_STRINGS.declined);
  expect(move()).toBeDefined();
});

test("approving the move reads the chat again, and the action goes away once nothing is held", async () => {
  const calls: string[] = [];
  await mount(async () => { calls.push("request"); return true; }, async () => { calls.push("reload"); recordHeldEarlierHistory(address, "main", 0); });
  await act(async () => recordHeldEarlierHistory(address, "main", 1));
  await act(async () => { move()!.click(); });
  expect(calls).toEqual(["request", "reload"]);
  expect(move()).toBeUndefined();
  expect(document.body.textContent).toContain("nothing held");
});

test("a reload that does not bring earlier history in after the approval shows as failed, not as moved", async () => {
  const calls: string[] = [];
  // The chat's read swallows its own failure and resolves; the records stay held.
  await mount(async () => { calls.push("request"); return true; }, async () => { calls.push("reload"); });
  await act(async () => recordHeldEarlierHistory(address, "main", 1));
  await act(async () => { move()!.click(); });
  expect(calls).toEqual(["request", "reload"]);
  expect(document.body.textContent).toContain(EARLIER_HISTORY_STRINGS.failed);
  expect(move()).toBeDefined();
});

test("a reload that rejects shows as failed", async () => {
  await mount(async () => true, async () => { throw new Error("read failed"); });
  await act(async () => recordHeldEarlierHistory(address, "main", 1));
  await act(async () => { move()!.click(); });
  expect(document.body.textContent).toContain(EARLIER_HISTORY_STRINGS.failed);
});
