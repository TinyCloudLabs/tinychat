import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionStore } from "@tinyboilerplate/client";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import { BotHistoryApprovalNeeded, ensureBotHistoryGrant, ensureSiblingHistoryGrant } from "./historyGrant";
import { readHistoryForBot } from "./historyRead";

// The same fixed vector as bots/src/__tests__/siblings.test.ts and
// backend/src/__tests__/bot-history-siblings.test.ts.
const OWNER = "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
const ADDRESS = "0x2222222222222222222222222222222222222222";
const KEY = "abababababababababababababababab";
const SIBLING_DIRECTORY = "xyz.tinycloud.tinychat/threads/bots/v1/c3b8444e14bf08dc624dfd314fb3a4746688b5970324a4dc3f65e10390683643/";
const MAIN_DIRECTORY = "xyz.tinycloud.tinychat/threads/bots/v1/11db6cc2930810ec2e88a86f05026feb734250c7b9afbd5914a6a82955e32136/";
const SIGNER_DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const SIWE = "Expiration Time: 2099-01-01T00:00:00.000Z";
const GENERATION = "a".repeat(32);
const CHALLENGE = "b".repeat(64);
const RECORD_PATH = `${GENERATION}/1-${CHALLENGE}`;

let restore: (() => void) | undefined;
let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restore?.();
  restoreFetch = restore = undefined;
});

function fakeGrant(options: { allowed?: boolean; prompted?: boolean; refusesDerivation?: boolean; token?: string } = {}) {
  restore = installDom({});
  new SessionStore("xyz.tinycloud.tinychat:session").setSession(options.token ?? crypto.randomUUID(), 3600, ADDRESS);
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
    init?.method === "POST" ? new Response(null, { status: 204 }) : Response.json({ enabled: true, backendDid: SIGNER_DID }));
  restoreFetch = () => fetchSpy.mockRestore();
  const authority: PermissionEntry[][] = [];
  const delegations: Array<Parameters<TinyCloudWeb["delegateTo"]>> = [];
  const tcw = {
    hosts: ["https://test-node.invalid"],
    session: () => ({ address: ADDRESS, chainId: 1, siwe: SIWE, signature: "test-signature" }),
    hasPermissions: (permissions: PermissionEntry[]) => {
      authority.push(permissions);
      return options.allowed ?? true;
    },
    delegateTo: async (...args: Parameters<TinyCloudWeb["delegateTo"]>) => {
      delegations.push(args);
      if (options.refusesDerivation) {
        const error = new Error("test delegation refusal");
        error.name = "PermissionNotInManifestError";
        throw error;
      }
      return {
        delegation: { cid: "test-cid", authHeader: "Bearer test-delegation", expiry: new Date("2099-01-01T00:00:00.000Z") },
        prompted: options.prompted ?? false,
      };
    },
  } as unknown as TinyCloudWeb;
  return { tcw, fetchSpy, authority, delegations };
}

test("a sibling uses the shared id and delegates exactly get and put on its directory without approval", async () => {
  const { tcw, fetchSpy, authority, delegations } = fakeGrant();
  await ensureSiblingHistoryGrant(tcw, KEY);
  const exact = [{ service: "tinycloud.kv", space: "applications", skipPrefix: true, path: SIBLING_DIRECTORY, actions: ["get", "put"] }];
  expect(authority).toEqual([exact]);
  expect(delegations).toEqual([[SIGNER_DID, exact, { expiry: 604_800_000, forceWalletSign: false }]]);
  expect(String(fetchSpy.mock.calls[0]?.[0])).toEndWith("/api/bots/history/status");
  expect(String(fetchSpy.mock.calls[1]?.[0])).toEndWith(`/api/bots/${KEY}/history/grant`);
  expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("POST");
});

test("a sibling with insufficient authority stops before delegation or grant submission", async () => {
  const { tcw, fetchSpy, delegations } = fakeGrant({ allowed: false });
  await expect(ensureSiblingHistoryGrant(tcw, KEY)).rejects.toBeInstanceOf(BotHistoryApprovalNeeded);
  expect(delegations).toHaveLength(0);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test.each([{ prompted: true }, { refusesDerivation: true }])("a sibling reports approval needed and submits nothing on SDK refusal (%j)", async (options) => {
  const { tcw, fetchSpy } = fakeGrant(options);
  await expect(ensureSiblingHistoryGrant(tcw, KEY)).rejects.toBeInstanceOf(BotHistoryApprovalNeeded);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("Main's grant request remains byte for byte and its cache cannot suppress a sibling", async () => {
  const { tcw, fetchSpy, authority, delegations } = fakeGrant({ token: "per-bot-test" });
  await ensureBotHistoryGrant(tcw);
  const mainPermission = `[{"service":"tinycloud.kv","space":"applications","skipPrefix":true,"path":"${MAIN_DIRECTORY}","actions":["get","put"]}]`;
  expect(JSON.stringify(authority[0])).toBe(mainPermission);
  expect(JSON.stringify(delegations[0]?.[1])).toBe(mainPermission);
  expect(delegations[0]?.[2]).toEqual({ expiry: 604_800_000 });
  const [url, init] = fetchSpy.mock.calls[1]!;
  expect(String(url)).toEndWith("/api/bots/history/grant");
  expect(init?.method).toBe("POST");
  expect(JSON.stringify(init?.headers)).toBe('{"authorization":"Bearer per-bot-test","X-Requested-With":"XMLHttpRequest","content-type":"application/json"}');
  expect(init?.body).toBe(String.raw`{"serialized":"{\"cid\":\"test-cid\",\"authHeader\":\"Bearer test-delegation\",\"expiry\":\"2099-01-01T00:00:00.000Z\",\"delegationHeader\":{\"Authorization\":\"Bearer test-delegation\"},\"ownerAddress\":\"0x2222222222222222222222222222222222222222\",\"chainId\":1,\"host\":\"https://test-node.invalid\"}","siwe":"Expiration Time: 2099-01-01T00:00:00.000Z","signature":"test-signature"}`);
  await ensureSiblingHistoryGrant(tcw, KEY);
  await ensureSiblingHistoryGrant(tcw, KEY);
  await ensureBotHistoryGrant(tcw);
  expect(fetchSpy).toHaveBeenCalledTimes(4);
  expect(delegations).toHaveLength(2);
  expect(delegations[1]?.[1][0]?.path).toBe(SIBLING_DIRECTORY);
});

function fakeReader(keys: string[], bot?: string) {
  const prefixes: string[] = [];
  const reads: string[] = [];
  const spaceId = makePkhSpaceId(ADDRESS, 1, "applications");
  const batch = { v: 1, seq: 1, generation: GENERATION, challenge: CHALLENGE, bot, record: { type: "assistant", text: "test" } };
  const tcw = {
    session: () => ({ address: ADDRESS, chainId: 1 }),
    hasPermissions: () => true,
    kvForSpace: () => ({
      list: async ({ prefix }: { prefix: string }) => {
        prefixes.push(prefix);
        return { ok: true, data: { keys, truncated: false } };
      },
      get: async (path: string) => {
        reads.push(path);
        return { ok: true, data: { data: { aad: btoa(JSON.stringify({ owner: OWNER, spaceId, path })) } } };
      },
    }),
    encryption: {
      decryptEnvelope: async () => ({ ok: true, data: new TextEncoder().encode(JSON.stringify(batch)) }),
    },
  } as unknown as TinyCloudWeb;
  return { tcw, prefixes, reads };
}

for (const [key, directory, batchBot, outside] of [
  ["main", MAIN_DIRECTORY, undefined, SIBLING_DIRECTORY],
  [KEY, SIBLING_DIRECTORY, KEY, MAIN_DIRECTORY],
] as const) {
  test(`${key} lists its own directory including the closing slash and reads its bound record`, async () => {
    const path = directory + RECORD_PATH;
    const { tcw, prefixes, reads } = fakeReader([path], batchBot);
    expect(await readHistoryForBot(tcw, key)).toMatchObject([{ role: "bot", text: "test" }]);
    expect(prefixes).toEqual([directory]);
    expect(reads).toEqual([path]);
  });

  test(`${key} rejects invalid paths before fetching any record`, async () => {
    for (const invalid of [outside + RECORD_PATH, directory + "x/" + RECORD_PATH, directory + RECORD_PATH + "\n",
      directory + RECORD_PATH.replace("1-", "01-"), directory + RECORD_PATH.toUpperCase()]) {
      const { tcw, reads } = fakeReader([directory + RECORD_PATH, invalid], batchBot);
      await expect(readHistoryForBot(tcw, key)).rejects.toThrow("history_path_mismatch");
      expect(reads).toHaveLength(0);
    }
  });

  test(`${key} refuses a batch that names another bot`, async () => {
    const { tcw } = fakeReader([directory + RECORD_PATH], key === "main" ? KEY : "cd".repeat(16));
    await expect(readHistoryForBot(tcw, key)).rejects.toThrow("history_binding_mismatch");
  });
}
