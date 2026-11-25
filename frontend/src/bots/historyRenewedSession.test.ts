// TC-4322: a session restored through its renewal lease runs past its SIWE's signed end. Main's history bounds its
// descriptor, its grant to the backend and its approval by the renewed end that the backend bound into this session's
// bearer at verify-renewal, for this session key only. Without one, the signed end holds.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import type { ClientSession, TinyCloudWeb } from "@tinycloud/web-sdk";
import { SessionStore, type connectWallet } from "@tinyboilerplate/client";
import { installDom } from "@/test/dom";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";
import { signBotHistoryKeyDescriptor } from "./botHistoryKey";
import { ownerPermissionRequester } from "./historyAuthorization";
import { ensureBotHistoryGrant } from "./historyGrant";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const address = `0x${"12".repeat(20)}`;
const sessionDid = "did:key:z6MkRenewedSessionKey";
const session = (now: number): ClientSession => ({
  address, walletAddress: address, chainId: 1, sessionKey: "renewed", signature: "fixture",
  siwe: `URI: ${sessionDid}#z6MkRenewedSessionKey\nExpiration Time: ${new Date(now - HOUR).toISOString()}`,
});
const descriptor = {
  networkId: encryptionNetworkId(address), keyPath: BOT_HISTORY_KEY_PATH, alg: "x25519-aes256gcm/v1", keyVersion: 1,
  publicEncryptionKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", kind: "deletable", state: "active",
} as const;

/** A bearer as /api/auth/verify-renewal issues it; One reads its claims, the backend checks its signature. */
function bearer(renewal?: { sessionDid: string; end: number }): string {
  const claims = Buffer.from(JSON.stringify({ address, sub: address, ...(renewal ? { renewal } : {}) })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${claims}.signature`;
}
const renewedUntil = (end: number, did = sessionDid) => bearer({ sessionDid: did, end: Math.floor(end / 1000) });

let restoreDom: (() => void) | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
beforeEach(() => { restoreDom = installDom({}); });
afterEach(() => { fetchSpy?.mockRestore(); restoreDom?.(); });

test("the descriptor of a renewed session past its signed end lasts until the renewed end", async () => {
  const now = Date.now();
  const tcw = { signSessionBytes: async () => new Uint8Array(64) } as unknown as TinyCloudWeb;
  const end = now + 3 * DAY;
  const envelope = await signBotHistoryKeyDescriptor(tcw, descriptor, session(now), now, renewedUntil(end));
  expect(envelope.descriptor.exp).toBe(Math.floor(end / 1000));
  expect(envelope.signerDid).toBe(sessionDid);

  const weekLater = await signBotHistoryKeyDescriptor(tcw, descriptor, session(now), now, renewedUntil(now + 30 * DAY));
  expect(weekLater.descriptor.exp).toBe(Math.floor((now + 7 * DAY) / 1000));
});

test("an expired session without a renewed end for its own key signs no descriptor", async () => {
  const now = Date.now();
  const tcw = { signSessionBytes: async () => new Uint8Array(64) } as unknown as TinyCloudWeb;
  for (const token of [null, bearer(), renewedUntil(now + 3 * DAY, "did:key:z6MkAnotherSessionKey"), renewedUntil(now - 60_000), "not-a-bearer"]) {
    await expect(signBotHistoryKeyDescriptor(tcw, descriptor, session(now), now, token)).rejects.toThrow("history_session_expired");
  }
});

function grantClient(now: number) {
  const expiries: number[] = [];
  const tcw = {
    session: () => session(now),
    hasPermissions: () => true,
    delegateTo: async (_did: string, _permissions: unknown, options: { expiry: number }) => {
      expiries.push(options.expiry);
      throw new Error("reached_delegation");
    },
  } as unknown as TinyCloudWeb;
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ enabled: true, backendDid: `did:pkh:eip155:1:0x${"11".repeat(20)}` }));
  return { tcw, expiries };
}

test("a renewed session past its signed end mints the history grant up to the renewed end", async () => {
  const now = Date.now();
  const { tcw, expiries } = grantClient(now);
  new SessionStore("xyz.tinycloud.tinychat:session").setSession(renewedUntil(now + 2 * DAY), 3600, address);
  await expect(ensureBotHistoryGrant(tcw)).rejects.toThrow("reached_delegation");
  expect(expiries).toHaveLength(1);
  expect(expiries[0]).toBeGreaterThan(2 * DAY - 60_000);
  expect(expiries[0]).toBeLessThanOrEqual(2 * DAY);
});

test("an expired session with a plain bearer mints no history grant", async () => {
  const now = Date.now();
  const { tcw, expiries } = grantClient(now);
  new SessionStore("xyz.tinycloud.tinychat:session").setSession(bearer(), 3600, address);
  await expect(ensureBotHistoryGrant(tcw)).rejects.toThrow("history_session_expired");
  expect(expiries).toEqual([]);
});

function approvalClient(now: number) {
  const asked: number[] = [];
  const tcw = {
    session: () => session(now),
    setRuntimePermissionSigner() {},
    requestPermissions: async (_permissions: unknown, options: { expiryMs: number }) => {
      asked.push(options.expiryMs);
      return { approved: true };
    },
  } as unknown as TinyCloudWeb;
  const connect = (async () => ({ address, openkey: {} })) as unknown as typeof connectWallet;
  return { request: ownerPermissionRequester(tcw, session(now), connect), asked };
}

test("the owner's approval for a renewed session is bounded by the renewed end", async () => {
  const now = Date.now();
  const { request, asked } = approvalClient(now);
  new SessionStore("xyz.tinycloud.tinychat:session").setSession(renewedUntil(now + 2 * DAY), 3600, address);
  expect(await request([])).toBe(true);
  expect(asked[0]).toBeGreaterThan(2 * DAY - 60_000);
  expect(asked[0]).toBeLessThanOrEqual(2 * DAY);
});

test("an expired session without a renewed end asks the owner nothing", async () => {
  const now = Date.now();
  const { request, asked } = approvalClient(now);
  new SessionStore("xyz.tinycloud.tinychat:session").setSession(bearer(), 3600, address);
  await expect(request([])).rejects.toThrow("history_session_expired");
  expect(asked).toEqual([]);
});
