import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { ensureBotHistoryGrant } from "./historyGrant";
let restore: (() => void) | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); restore?.(); });
function client(allowed = true) {
  let delegated = false;
  const tcw = { session: () => ({ siwe: `Expiration Time: ${new Date(Date.now() + 86_400_000).toISOString()}`, signature: "fixture" }),
    hasPermissions: () => allowed,
    delegateTo: async () => { delegated = true; throw new Error("reached_delegation"); },
  } as unknown as TinyCloudWeb;
  return { tcw, delegated: () => delegated };
}
function setup() {
  restore = installDom({});
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ enabled: true, backendDid: "did:pkh:eip155:1:0x" + "11".repeat(20) }));
}
test("the history grant reads a session created after module import instead of retaining a signed-out snapshot", async () => {
  setup(); const { tcw, delegated } = client();
  await expect(ensureBotHistoryGrant(tcw)).rejects.toThrow("history_signed_out");
  new SessionStore("xyz.tinycloud.tinychat:session").setSession("fixture-token", 3600, "0x" + "22".repeat(20));
  await expect(ensureBotHistoryGrant(tcw)).rejects.toThrow("reached_delegation");
  expect(delegated()).toBe(true);
});
test("missing existing permission fails before delegation and never starts an approval flow", async () => {
  setup(); const { tcw, delegated } = client(false);
  new SessionStore("xyz.tinycloud.tinychat:session").setSession("fixture-token", 3600, "0x" + "22".repeat(20));
  await expect(ensureBotHistoryGrant(tcw)).rejects.toThrow("history_authority_missing");
  expect(delegated()).toBe(false);
});
