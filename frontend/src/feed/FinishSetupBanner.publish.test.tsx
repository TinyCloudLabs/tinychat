// The card and the publish answer (TC-3547): the card's tap writes nothing; only "published" or "already-current" writes
// the account's flag and hides the card. A refused signature, "unavailable", "needs-one" or a thrown error leaves it showing.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import type { RegistryPublishClient, RegistryPublishOutcome } from "@/lib/registryConsent/adapter";
import { finishSetupBannerVisible } from "@/lib/registryConsent/bannerGate";
import { FINISH_SETUP_BANNER_COPY } from "@/lib/registryConsent/copy";
import type { DismissedStore } from "@/lib/registryConsent/dismissed";
import { publishRegistryRecord } from "@/lib/registryConsent/intent";
import { fakeSdk, memoryDismissedStore, OWNER_DID } from "@/lib/registryConsent/testClient.fixture";
import { FinishSetupBanner } from "./FinishSetupBanner";

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.();
  restore = undefined;
});

async function mountCard(client: RegistryPublishClient, store: DismissedStore) {
  restore = installDom();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const visible = (tcw: RegistryPublishClient | null) => finishSetupBannerVisible(tcw, async () => true, () => true, store);
  await act(async () => root!.render(<MemoryRouter initialEntries={["/chat/feed"]}><FinishSetupBanner tcw={client} visible={visible} dismissed={store} /></MemoryRouter>));
  return {
    shown: () => (container.textContent ?? "").includes(FINISH_SETUP_BANNER_COPY.action),
    tap: () => act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === FINISH_SETUP_BANNER_COPY.action)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }),
  };
}

/** The page's publish path, run inside `act` so the card reacts to the flag the way it does in the app. */
function publish(client: RegistryPublishClient, store: DismissedStore, opened: string[] = []) {
  return act(async () => { await publishRegistryRecord(client, "https://tinycloud.one", async (origin) => { opened.push(origin); }, store); });
}

describe("the finish-setup card and the publish answer", () => {
  test("a tap on the card writes nothing and leaves the card showing", async () => {
    const store = memoryDismissedStore();
    const view = await mountCard(fakeSdk().client, store);
    await view.tap();
    expect(store.read(OWNER_DID)).toBe(false);
    expect(view.shown()).toBe(true);
  });

  for (const outcome of ["published", "already-current"] as const) {
    test(`"${outcome}" writes the account's flag and hides the card`, async () => {
      const sdk = fakeSdk(outcome);
      const store = memoryDismissedStore();
      const view = await mountCard(sdk.client, store);
      expect(view.shown()).toBe(true);
      await publish(sdk.client, store);
      expect(store.read(OWNER_DID)).toBe(true);
      expect(view.shown()).toBe(false);
    });
  }

  for (const outcome of ["unavailable", "needs-one"] as const satisfies readonly RegistryPublishOutcome[]) {
    test(`"${outcome}" writes nothing and the card keeps showing`, async () => {
      const sdk = fakeSdk(outcome);
      const store = memoryDismissedStore();
      const opened: string[] = [];
      const view = await mountCard(sdk.client, store);
      await publish(sdk.client, store, opened);
      expect(store.read(OWNER_DID)).toBe(false);
      expect(view.shown()).toBe(true);
      expect(opened).toEqual(outcome === "needs-one" ? ["https://tinycloud.one"] : []);
    });
  }

  test("a thrown error (a refused signature) writes nothing and the card keeps showing", async () => {
    const refusing: RegistryPublishClient = { did: OWNER_DID, ensureOwnerRegistryRecord: async () => { throw new Error("signature refused"); } };
    const store = memoryDismissedStore();
    const view = await mountCard(refusing, store);
    await publish(refusing, store);
    expect(store.read(OWNER_DID)).toBe(false);
    expect(view.shown()).toBe(true);
  });

  test("the flag is per account: another owner's published answer does not hide this account's card", async () => {
    const store = memoryDismissedStore();
    const other = { ...fakeSdk("published").client, did: "did:pkh:eip155:1:0x00000000000000000000000000000000000b0b01" };
    const view = await mountCard(fakeSdk().client, store);
    await publish(other, store);
    expect(store.read(other.did)).toBe(true);
    expect(store.read(OWNER_DID)).toBe(false);
    expect(view.shown()).toBe(true);
  });
});
