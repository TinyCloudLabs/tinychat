import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import { ensureTrustBotReadGrant } from "./trustbotReadGrant";

const DID = "did:pkh:eip155:1:0x" + "11".repeat(20);
const DAY_MS = 86_400_000;
let restore: (() => void) | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  restore?.();
});

/** A grant that is not due for renewal, so a tick only recovers the replaced grant. */
function setup(revokeResult: { ok: boolean }) {
  restore = installDom({});
  new SessionStore("xyz.tinycloud.tinychat:session").setSession("fixture-token", 3600, "0x" + "22".repeat(20));
  const now = Date.now();
  const revoked: string[] = [];
  const tcw = {
    session: () => ({ siwe: `Expiration Time: ${new Date(now + 14 * DAY_MS).toISOString()}`, signature: "fixture" }),
    hosts: [],
    hasPermissions: () => true,
    revokeDelegation: async (cid: string) => {
      revoked.push(cid);
      return revokeResult;
    },
  } as unknown as TinyCloudWeb;
  const renewal = (replacedGrantCid: unknown) => ({
    serviceDid: DID, grantCid: "current", expiresAt: now + 6 * DAY_MS, renewAfter: now + 3 * DAY_MS,
    areas: { meetings: "on", feed_chats: "off" }, replacedGrantCid,
  });
  return { tcw, revoked, renewal };
}

test("a confirmed revoke tells the backend to forget the replaced grant, so the next tick has nothing to retry", async () => {
  const { tcw, revoked, renewal } = setup({ ok: true });
  let stored: string | null = "prior-grant_1";
  const cleared: string[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (init?.method === "DELETE") {
      cleared.push(String(url));
      stored = null;
      return new Response(null, { status: 204 });
    }
    return Response.json(renewal(stored));
  });

  expect(await ensureTrustBotReadGrant(tcw)).toBe(true);
  expect(revoked).toEqual(["prior-grant_1"]);
  expect(cleared).toHaveLength(1);
  expect(cleared[0]).toEndWith("/api/bots/main/reads/renewal?replaced=prior-grant_1");

  expect(await ensureTrustBotReadGrant(tcw)).toBe(false);
  expect(revoked).toEqual(["prior-grant_1"]);
  expect(cleared).toHaveLength(1);
});

test("a revoke the node did not confirm keeps the replaced grant for the next tick", async () => {
  const { tcw, revoked, renewal } = setup({ ok: false });
  const methods: string[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    methods.push(init?.method ?? "GET");
    return Response.json(renewal("prior"));
  });

  expect(await ensureTrustBotReadGrant(tcw)).toBe(false);
  expect(revoked).toEqual(["prior"]);
  expect(methods).toEqual(["GET"]);
});

test.each(["../other", "prior grant", "prior?x=1", "", "a".repeat(129), 42])(
  "a malformed replaced grant ID %p is dropped without asking the node",
  async malformed => {
    const { tcw, revoked, renewal } = setup({ ok: true });
    const methods: string[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json(renewal(malformed));
    });

    expect(await ensureTrustBotReadGrant(tcw)).toBe(false);
    expect(revoked).toEqual([]);
    expect(methods).toEqual(["GET"]);
  },
);
