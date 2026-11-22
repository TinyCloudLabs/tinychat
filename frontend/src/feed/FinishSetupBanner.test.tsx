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
function Probe() { search = useLocation().search; return null; }

async function mount(visible: Parameters<typeof FinishSetupBanner>[0]["visible"], client = fakeSdk().client) {
  restore = installDom();
  search = "";
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter initialEntries={["/chat/feed"]}><Probe /><FinishSetupBanner tcw={client} visible={visible} /></MemoryRouter>));
  return {
    text: () => container.textContent ?? "",
    click: (label: string) => act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === label)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }),
  };
}

test("hidden while the consent switch is off (the shipped default)", async () => {
  const view = await mount(undefined);
  expect(view.text()).toBe("");
});

test("visible for an unregistered account that has not said Not now (switch on, in this test only)", async () => {
  const sdk = fakeSdk();
  const view = await mount((tcw) => finishSetupBannerVisible(tcw, true, async () => true, memoryDismissedStore()), sdk.client);
  expect(view.text()).toContain(FINISH_SETUP_BANNER_COPY.support);
  expect(view.text()).toContain(FINISH_SETUP_BANNER_COPY.action);
});

test("hidden after Not now: the SDK's flag keeps it away", async () => {
  const sdk = fakeSdk();
  const store = memoryDismissedStore();
  store.write(sdk.client.did);
  const view = await mount((tcw) => finishSetupBannerVisible(tcw, true, async () => true, store), sdk.client);
  expect(view.text()).toBe("");
});

test("hidden for an account that already has its record", async () => {
  const view = await mount((tcw) => finishSetupBannerVisible(tcw, true, async () => false, memoryDismissedStore()));
  expect(view.text()).toBe("");
});

test("the action goes to the finish-setup address, and the page's intent path then publishes past a Not now", async () => {
  const sdk = fakeSdk(async () => true);
  const view = await mount(async () => true, sdk.client);
  await view.click(FINISH_SETUP_BANNER_COPY.action);
  expect(search).toBe(FINISH_SETUP_INTENT_SEARCH);
  expect(hasFinishSetupRegistryIntent(search)).toBe(true);
  expect(view.text()).toBe("");
  const replaced: string[] = [];
  const outcome = await runFinishSetupIntent(sdk.client, {
    location: { origin: "https://tinycloud.one", hostname: "tinycloud.one", pathname: "/chat/feed", search, hash: "" },
    history: { state: null, replaceState: (_state, _title, url) => { replaced.push(String(url)); } },
  }, true);
  expect(outcome).toBe("published");
  expect(replaced).toEqual(["/chat/feed"]);
  expect(sdk.calls).toEqual([{ options: { ignoreDismissed: true } }]);
});
