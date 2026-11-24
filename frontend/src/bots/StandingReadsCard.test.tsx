import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionStore } from "@tinyboilerplate/client";

import { installDom } from "@/test/dom";
import StandingReadsCard from "./StandingReadsCard";
import type { ReadSettings } from "./trustbotReadGrant";
import type { StandingReadsView } from "./trustbotStandingReads";

const CID = "bafystandingreadactivegrant";
const settings: ReadSettings = {
  serviceDid: "did:pkh:eip155:1:0x" + "11".repeat(20), expiresAt: null, grantCid: null,
  areas: { meetings: "on", feed_chats: "off" }, standingAvailable: true,
};
const on: StandingReadsView = {
  areas: ["meetings"], active: { originalCid: CID, areas: ["meetings"], validUntil: Date.now() + 86_400_000 },
  pending: null, previousOriginalCid: null, outcome: null,
};
const off: StandingReadsView = { ...on, active: null };

let restore: (() => void) | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  fetchSpy?.mockRestore();
  restore?.();
});

const flush = async () => { await act(async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); }); };

/** Mounts the real card against a backend that turns standing access off once it gets the DELETE. */
async function mount(revokeFails: boolean) {
  restore = installDom({});
  new SessionStore("xyz.tinycloud.tinychat:session").setSession("fixture-token", 3600, "0x" + "22".repeat(20));
  const calls: string[] = [];
  let view = on;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    const method = init?.method ?? "GET";
    if (pathname.endsWith("/summary")) return Response.json({ days: [] });
    calls.push(`${method} ${pathname}`);
    if (method === "DELETE") {
      view = off;
      return new Response(null, { status: 204 });
    }
    return Response.json(view);
  }) as typeof fetch);
  const revoke = async (cid: string) => {
    calls.push(`revoke ${cid}`);
    if (revokeFails) throw new Error("node did not confirm");
  };
  const container = document.createElement("div");
  document.body.append(container);
  mounted = createRoot(container);
  act(() => mounted!.render(<StandingReadsCard settings={settings} revoke={revoke} />));
  await flush();
  const turnOff = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Turn off standing access");
  expect(turnOff()).toBeDefined();
  expect(container.textContent).toContain("Your bot can read your meetings through");
  calls.length = 0;
  act(() => turnOff()!.click());
  await flush();
  return { calls, container, turnOff };
}

test("turning off revokes the grant at the node before the backend drops it, then shows standing access off", async () => {
  const { calls, container, turnOff } = await mount(false);
  expect(calls).toEqual([
    `revoke ${CID}`,
    `DELETE /api/bots/main/reads/standing/${CID}`,
    "GET /api/bots/main/reads/standing",
  ]);
  expect(turnOff()).toBeUndefined();
  expect(container.textContent).toContain("Let your bot keep reading your meetings for up to 90 days");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("a failed node revoke never tells the backend, says so and keeps standing access shown as on", async () => {
  const { calls, container, turnOff } = await mount(true);
  expect(calls).toEqual([`revoke ${CID}`]);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t update bot reads. Try again.");
  expect(turnOff()).toBeDefined();
  expect(container.textContent).toContain("Your bot can read your meetings through");
});
