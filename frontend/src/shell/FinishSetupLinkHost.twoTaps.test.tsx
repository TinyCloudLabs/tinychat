// The Home card's tap, through the real router: the page strips the query with a raw history.replaceState the router
// never sees, so a second tap (after an unavailable or refused answer) is a navigation to the same router search string.
// It must still ask the SDK again; a reload of the stripped address must not ask at all.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { installDom } from "@/test/dom";
import { FINISH_SETUP_CARD_STATE, FINISH_SETUP_INTENT_SEARCH, type RegistryPublishEnv } from "@/lib/registryConsent/intent";
import { createDismissedStore } from "@/lib/registryConsent/dismissed";
import { createNudgedStore } from "@/lib/registryConsent/nudged";
import { fakeSdk, memoryStorage } from "@/lib/registryConsent/testClient.fixture";
import { RoutedFinishSetupLinkHost } from "./FinishSetupNotice";

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.();
  restore = undefined;
});

/** The page's address and history entry, which a card tap sets and the page's replaceState strips (the router is not told). */
function browser() {
  const at = new URL("https://tinycloud.one/chat/feed");
  let usr: unknown = null;
  const env: RegistryPublishEnv = {
    location: { origin: at.origin, pathname: at.pathname, get search() { return at.search; }, hash: at.hash },
    history: {
      get state() { return { key: "s", usr }; },
      replaceState: (_state, _title, next) => { at.search = new URL(String(next), at.origin).search; },
    },
  };
  return { env, tapAddress: () => { at.search = FINISH_SETUP_INTENT_SEARCH; usr = FINISH_SETUP_CARD_STATE; }, search: () => at.search };
}

function mount(client: ReturnType<typeof fakeSdk>["client"], env: RegistryPublishEnv, tap: () => void) {
  restore ??= installDom();
  const storage = memoryStorage();
  function Card() {
    const navigate = useNavigate();
    return <button type="button" onClick={() => { tap(); navigate({ search: FINISH_SETUP_INTENT_SEARCH }, { state: FINISH_SETUP_CARD_STATE }); }}>card</button>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  return act(async () => root!.render(
    <MemoryRouter initialEntries={["/chat/feed"]}>
      <RoutedFinishSetupLinkHost tcw={client} ready env={env} dismissed={createDismissedStore(() => storage)}
        nudged={createNudgedStore(() => storage)} unregistered={async () => false} platform="web" />
      <Card />
    </MemoryRouter>,
  ));
}
const tapCard = () => act(async () => {
  document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});

describe("the Home card's tap", () => {
  test("a second tap after an unavailable answer asks the SDK again, and each tap asks once", async () => {
    const sdk = fakeSdk("unavailable");
    const page = browser();
    await mount(sdk.client, page.env, page.tapAddress);
    await tapCard();
    expect(sdk.calls).toEqual([[]]);
    expect(page.search()).toBe("");
    await tapCard();
    expect(sdk.calls).toEqual([[], []]);
    expect(page.search()).toBe("");
  });

  test("a reload of the stripped address asks nothing, though the history entry still carries the card's marker", async () => {
    const sdk = fakeSdk("unavailable");
    const page = browser();
    await mount(sdk.client, page.env, page.tapAddress);
    await tapCard();
    expect(sdk.calls).toEqual([[]]);
    await act(async () => root!.unmount());
    root = undefined;
    await mount(sdk.client, page.env, page.tapAddress);
    expect(sdk.calls).toEqual([[]]);
  });
});
