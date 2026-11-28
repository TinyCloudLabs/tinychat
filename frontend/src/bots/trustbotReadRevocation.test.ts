import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import { changeReadArea, ensureTrustBotReadGrant, readSettings, setReadArea, signReadGrant } from "./trustbotReadGrant";

const DID = "did:pkh:eip155:1:0x" + "11".repeat(20);
const DAY_MS = 86_400_000;
let restore: (() => void) | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  restore?.();
});

function setup() {
  restore = installDom({});
  new SessionStore("xyz.tinycloud.tinychat:session").setSession("fixture-token", 3600, "0x" + "22".repeat(20));
  const now = Date.now();
  const revoked: string[] = [];
  const lifetimes: number[] = [];
  const tcw = {
    session: () => ({ siwe: `Expiration Time: ${new Date(now + 14 * DAY_MS).toISOString()}`, signature: "fixture" }),
    hosts: [],
    hasPermissions: () => true,
    delegateTo: async (_did: string, _areas: unknown, { expiry }: { expiry: number }) => {
      lifetimes.push(expiry);
      return { prompted: false, delegation: { cid: "replacement", expiry: new Date(now + expiry), authHeader: "Bearer fixture" } };
    },
    revokeDelegation: async (cid: string) => {
      revoked.push(cid);
      return { ok: true };
    },
  } as unknown as TinyCloudWeb;
  const saved = {
    serviceDid: DID, grantCid: "prior", expiresAt: now + DAY_MS, renewAfter: now - DAY_MS,
    areas: { meetings: "on", feed_chats: "off" } as const,
  };
  return { tcw, saved, revoked, lifetimes };
}

test.each(["renewal", "enable"] as const)("%s revokes the proposed grant when the backend refuses its save", async action => {
  const { tcw, saved, revoked, lifetimes } = setup();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "GET") return Response.json(saved);
    expect(JSON.parse(init?.body as string).grant.serialized).toContain('"cid":"replacement"');
    expect(revoked).toEqual([]);
    return Response.json({ error: "invalid_grant", code: "changed" }, { status: 400 });
  });

  if (action === "renewal") {
    expect(await ensureTrustBotReadGrant(tcw)).toBe(false);
    expect(lifetimes).toEqual([7 * DAY_MS - 60_000]);
  } else {
    await expect(changeReadArea({
      readSettings, setReadArea,
      signReadGrant: (did, areas) => signReadGrant(tcw, did, areas),
      revokeReadGrant: async cid => { await tcw.revokeDelegation(cid); },
    }, saved, "meetings", true)).rejects.toThrow();
  }

  expect(revoked).toEqual(["replacement"]);
});

test("the next renewal tick revokes the prior grant when the committed save lost its response", async () => {
  const { tcw, saved, revoked, lifetimes } = setup();
  const prior = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  const replacement = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  saved.grantCid = prior;
  let committed = false;
  let cleared = false;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (String(_url).endsWith("/renewal/revoked")) {
      cleared = true;
      return new Response(null, { status: 204 });
    }
    if (init?.method === "PUT") {
      committed = true;
      throw new DOMException("Timed out", "TimeoutError");
    }
    return Response.json(committed ? {
      ...saved, grantCid: replacement, replacedGrantCid: cleared ? null : prior,
      expiresAt: Date.now() + 6 * DAY_MS, renewAfter: Date.now() + 3 * DAY_MS,
    } : saved);
  });

  expect(await ensureTrustBotReadGrant(tcw)).toBe(false);
  expect(revoked).toEqual([]);
  expect(await ensureTrustBotReadGrant(tcw)).toBe(true);
  expect(await ensureTrustBotReadGrant(tcw)).toBe(false);
  expect(revoked).toEqual([prior]);
  expect(lifetimes).toHaveLength(1);
});
