import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { AgentAccessProvider, useAgentAccess } from "./useAgentEnablement";

const tcw = { address: () => "0x00000000000000000000000000000000000000a1", did: "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1" } as unknown as TinyCloudWeb;
const sessionStore = { getToken: () => "token", isExpired: () => false, getAddress: () => "0x00000000000000000000000000000000000000a1" } as unknown as SessionStore;

let restoreDom: () => void;
let root: Root;
let requests: string[];
const realFetch = globalThis.fetch;
let access: ReturnType<typeof useAgentAccess> | null = null;
function Probe() {
  access = useAgentAccess();
  return null;
}
beforeEach(() => {
  restoreDom = installDom();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  requests = [];
  access = null;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    // The backend would grant agent tools.
    return Response.json({ status: "active", revision: "r1", bundle: { active: true } });
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = realFetch;
  restoreDom();
});

async function mount(enabled?: boolean) {
  await act(async () => root.render(
    <AgentAccessProvider tcw={tcw} sessionStore={sessionStore} backendUrl="http://localhost" appName="Home" openkeyHost="http://localhost" enabled={enabled}>
      <Probe />
    </AgentAccessProvider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

test("switched off (the Home site), agent access never probes the backend and gives chat no agent tools", async () => {
  await mount(false);
  expect(requests.filter((url) => url.includes("/api/agent/"))).toEqual([]);
  expect(access!.capability).toBe("unavailable");
  expect(access!.agentEnabledRef.current).toBe(false);
  expect(access!.privateAccessRef.current.active).toBe(false);
  await act(async () => { await access!.onEnable(); });
  expect(requests.filter((url) => url.includes("/api/agent/"))).toEqual([]);
  expect(access!.agentEnabledRef.current).toBe(false);
});

test("on by default, it asks the backend", async () => {
  await mount();
  expect(requests.some((url) => url.includes("/api/agent/session"))).toBe(true);
});
