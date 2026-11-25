import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { installDom } from "@/test/dom";
import { finishSetupBannerVisible } from "@/lib/registryConsent/bannerGate";
import { FINISH_SETUP_BANNER_COPY } from "@/lib/registryConsent/copy";
import { FINISH_SETUP_INTENT_SEARCH, hasFinishSetupRegistryIntent, runFinishSetupIntent } from "@/lib/registryConsent/intent";
import { fakeSdk, memoryDismissedStore } from "@/lib/registryConsent/testClient.fixture";
import { FinishSetupBanner } from "./FinishSetupBanner";

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.();
  restore = undefined;
});

let search = "";
let routerState: unknown = null;
function Probe() { const location = useLocation(); search = location.search; routerState = location.state; return null; }

async function mount(visible: Parameters<typeof FinishSetupBanner>[0]["visible"], client = fakeSdk().client, dismissed = memoryDismissedStore()) {
  restore = installDom();
  search = "";
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter initialEntries={["/chat/feed"]}><Probe /><FinishSetupBanner tcw={client} visible={visible} dismissed={dismissed} /></MemoryRouter>));
  return {
    text: () => container.textContent ?? "",
    click: (label: string) => act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === label)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }),
  };
}

test("hidden when the app cannot open TinyCloud One", async () => {
  const view = await mount((tcw) => finishSetupBannerVisible(tcw, async () => true, () => false, memoryDismissedStore()));
  expect(view.text()).toBe("");
});

test("visible for an unregistered account that has not tapped the button on this device", async () => {
  const sdk = fakeSdk();
  const view = await mount((tcw) => finishSetupBannerVisible(tcw, async () => true, () => true, memoryDismissedStore()), sdk.client);
  expect(view.text()).toContain(FINISH_SETUP_BANNER_COPY.support);
  expect(view.text()).toContain(FINISH_SETUP_BANNER_COPY.action);
});

test("hidden once the owner has tapped the button on this device", async () => {
  const sdk = fakeSdk();
  const store = memoryDismissedStore();
  store.write(sdk.client.did);
  const view = await mount((tcw) => finishSetupBannerVisible(tcw, async () => true, () => true, store), sdk.client, store);
  expect(view.text()).toBe("");
});

test("hidden for an account that already has its record", async () => {
  const view = await mount((tcw) => finishSetupBannerVisible(tcw, async () => false, () => true, memoryDismissedStore()));
  expect(view.text()).toBe("");
});

test("the button records the tap for this account, goes to the finish-setup address, and the page's intent path then publishes", async () => {
  const sdk = fakeSdk("published");
  const store = memoryDismissedStore();
  const view = await mount(async () => true, sdk.client, store);
  expect(store.read(sdk.client.did)).toBe(false);
  await view.click(FINISH_SETUP_BANNER_COPY.action);
  expect(store.read(sdk.client.did)).toBe(true);
  expect(search).toBe(FINISH_SETUP_INTENT_SEARCH);
  expect(hasFinishSetupRegistryIntent(search)).toBe(true);
  expect(view.text()).toBe("");
  const replaced: string[] = [];
  const outcome = await runFinishSetupIntent(sdk.client, {
    location: { origin: "https://tinycloud.one", pathname: "/chat/feed", search, hash: "" },
    history: { state: { usr: routerState }, replaceState: (_state, _title, url) => { replaced.push(String(url)); } },
  });
  expect(outcome).toBe("published");
  expect(replaced).toEqual(["/chat/feed"]);
  expect(sdk.calls).toEqual([[]]);
});
