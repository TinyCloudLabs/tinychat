import { afterEach, expect, spyOn, test, type Mock } from "bun:test";
import { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

import { installDom } from "@/test/dom";
import { ensureTrustBotReadGrant, revokeReadGrant } from "./trustbotReadGrant";

const PRIOR = CID.createV1(raw.code, await sha256.digest(new TextEncoder().encode("prior"))).toString();
const CURRENT = CID.createV1(raw.code, await sha256.digest(new TextEncoder().encode("current"))).toString();
let restore: (() => void) | undefined;
let fetchSpy: Mock<typeof fetch> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); restore?.(); });

function setup(pending: string = PRIOR) {
  restore = installDom({});
  new SessionStore("xyz.tinycloud.tinychat:session").setSession("fixture-token", 3600, "0x" + "22".repeat(20));
  const state = { pending: pending as string | null, nodeOk: true, ackOk: true, revoked: [] as string[] };
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (init?.method === "PUT") {
      expect(String(url).endsWith("/reads/renewal/revoked")).toBe(true);
      expect(JSON.parse(init.body as string)).toEqual({ cid: state.pending });
      if (!state.ackOk) return new Response(null, { status: 503 });
      state.pending = null;
      return new Response(null, { status: 204 });
    }
    return Response.json({
      serviceDid: "did:pkh:eip155:1:0x" + "11".repeat(20),
      grantCid: CURRENT, expiresAt: Date.now() + 86_400_000, renewAfter: null,
      replacedGrantCid: state.pending, areas: { meetings: "on", feed_chats: "off" },
    });
  });
  const client = () => ({
    session: () => undefined,
    revokeDelegation: async (cid: string) => {
      state.revoked.push(cid);
      return { ok: state.nodeOk };
    },
  }) as unknown as TinyCloudWeb;
  return { state, client };
}

test("confirmed revoke clears the replaced grant, but a refused revoke keeps it pending", async () => {
  const { state, client } = setup();
  const tcw = client();
  state.nodeOk = false;
  expect(await ensureTrustBotReadGrant(tcw)).toBe(false);
  expect(state.pending).toBe(PRIOR);
  state.nodeOk = true;
  expect(await ensureTrustBotReadGrant(tcw)).toBe(true);
  expect(state.pending).toBeNull();
});

test.each(["", "prior", "bafy-not-a-cid", `${PRIOR}\n`, "https://node.test/" + PRIOR])(
  "malformed replaced grant %j is dropped without a node revoke", async malformed => {
    const { state, client } = setup(malformed);
    await ensureTrustBotReadGrant(client());
    expect(state.pending).toBeNull();
    expect(state.revoked).toEqual([]);
  },
);

test("successful cleanup prevents further revokes even with a new browser client", async () => {
  const { state, client } = setup();
  expect(await ensureTrustBotReadGrant(client())).toBe(true);
  expect(await ensureTrustBotReadGrant(client())).toBe(false);
  expect(await ensureTrustBotReadGrant(client())).toBe(false);
  expect(state.revoked).toEqual([PRIOR]);
});

test("a failed acknowledgement retries cleanup without repeating a confirmed node revoke", async () => {
  const { state, client } = setup();
  const tcw = client();
  state.ackOk = false;
  expect(await ensureTrustBotReadGrant(tcw)).toBe(false);
  expect(state.pending).toBe(PRIOR);
  state.ackOk = true;
  expect(await ensureTrustBotReadGrant(tcw)).toBe(true);
  expect(state.pending).toBeNull();
  expect(state.revoked).toEqual([PRIOR]);
});

test("the settings revoke path also acknowledges a confirmed replaced grant", async () => {
  const { state, client } = setup();
  await revokeReadGrant(client(), PRIOR);
  expect(state.pending).toBeNull();
  expect(state.revoked).toEqual([PRIOR]);
});
