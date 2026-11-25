// The finish-setup link (TC-3547): from the Home card the SDK is asked at once; from a pasted or shared link the notice
// shows first and the SDK is not asked until Publish. Cancel, Escape and a tap outside ask nothing and write nothing.
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import type { RegistryPublishClient } from "@/lib/registryConsent/adapter";
import { FINISH_SETUP_NOTICE_COPY } from "@/lib/registryConsent/copy";
import { FINISH_SETUP_CARD_STATE, type RegistryPublishEnv } from "@/lib/registryConsent/intent";
import { createDismissedStore } from "@/lib/registryConsent/dismissed";
import { fakeSdk } from "@/lib/registryConsent/testClient.fixture";
import { clearAccountSignOutStorage } from "@/lib/accountSignOutStorage";

// Radix portals do not attach in happy-dom: the dialog's chrome is an inline stand-in; the notice's own content is real.
// bun's mock.module is process-wide: the stand-in keeps every other export, and the real module is put back after.
const actualDialog = { ...(await import("../components/ui/dialog")) };
afterAll(() => { mock.module("../components/ui/dialog", () => actualDialog); });
type Kids = { children?: ReactNode };
mock.module("../components/ui/dialog", () => ({
  ...actualDialog,
  // The stand-in's "dismiss" button is Radix's Escape or outside tap: it asks the dialog to close.
  Dialog: (props: { open: boolean; onOpenChange?: (open: boolean) => void } & Kids) => (props.open
    ? <div role="dialog">{props.children}<button type="button" onClick={() => props.onOpenChange?.(false)}>dismiss</button></div>
    : null),
  DialogContent: (props: { "data-testid"?: string } & Kids) => <div data-testid={props["data-testid"]}>{props.children}</div>,
  DialogHeader: (props: Kids) => <div>{props.children}</div>,
  DialogTitle: (props: Kids) => <h2>{props.children}</h2>,
  DialogDescription: (props: Kids) => <p>{props.children}</p>,
  DialogFooter: (props: Kids) => <div>{props.children}</div>,
}));
const { FinishSetupLinkHost } = await import("./FinishSetupNotice");

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.();
  restore = undefined;
});

/** A page at `url`: replaceState rewrites the address the way the browser does, so a second load reads the stripped one. */
function page(url: string, fromCard: boolean) {
  const at = new URL(url);
  const env: RegistryPublishEnv = {
    location: {
      origin: at.origin,
      pathname: at.pathname,
      get search() { return at.search; },
      hash: at.hash,
    },
    history: {
      state: fromCard ? { key: "s", usr: FINISH_SETUP_CARD_STATE } : { key: "s", usr: null },
      replaceState: (_state, _title, next) => { at.search = new URL(String(next), at.origin).search; },
    },
  };
  return { env, search: () => at.search };
}

async function mount(sdk: { client: RegistryPublishClient }, env: RegistryPublishEnv, ready = true) {
  restore ??= installDom();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (isReady: boolean) => act(async () => root!.render(<FinishSetupLinkHost tcw={sdk.client} ready={isReady} searchKey={env.location.search} env={env} />));
  await render(ready);
  return { render };
}

const dialog = () => document.querySelector<HTMLElement>('[data-testid="finish-setup-notice"]');
const press = (label: string) => act(async () => {
  [...document.querySelectorAll("button")].find((button) => button.textContent === label)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});

describe("a finish-setup link", () => {
  test("from the Home card the SDK is asked once, at once, and no notice shows", async () => {
    const sdk = fakeSdk("published");
    const link = page("https://tinycloud.one/chat/feed?finish-setup=registry", true);
    await mount(sdk, link.env);
    expect(sdk.calls).toEqual([[]]);
    expect(dialog()).toBeNull();
    expect(link.search()).toBe("");
  });

  test("a pasted link shows the notice with the card's words and asks the SDK nothing until Publish", async () => {
    const sdk = fakeSdk("published");
    const link = page("https://tinycloud.one/chat/feed?finish-setup=registry", false);
    await mount(sdk, link.env);
    expect(dialog()).not.toBeNull();
    expect(link.search()).toBe("");
    expect(sdk.calls).toEqual([]);
    const text = dialog()!.textContent ?? "";
    expect(text).toContain(FINISH_SETUP_NOTICE_COPY.title);
    expect(text).toContain(FINISH_SETUP_NOTICE_COPY.body);
    await press(FINISH_SETUP_NOTICE_COPY.publish);
    expect(sdk.calls).toEqual([[]]);
    expect(dialog()).toBeNull();
  });

  test("Cancel closes the notice and asks the SDK nothing", async () => {
    const sdk = fakeSdk("published");
    await mount(sdk, page("https://tinycloud.one/chat/feed?finish-setup=registry", false).env);
    await press(FINISH_SETUP_NOTICE_COPY.cancel);
    expect(dialog()).toBeNull();
    expect(sdk.calls).toEqual([]);
  });

  test("Escape or a tap outside (the dialog asked to close) is Cancel: it asks the SDK nothing", async () => {
    const sdk = fakeSdk("published");
    await mount(sdk, page("https://tinycloud.one/chat/feed?finish-setup=registry", false).env);
    await press("dismiss");
    expect(dialog()).toBeNull();
    expect(sdk.calls).toEqual([]);
  });

  test("a reload after the query is removed does not open the notice again", async () => {
    const sdk = fakeSdk("published");
    const link = page("https://tinycloud.one/chat/feed?finish-setup=registry", false);
    await mount(sdk, link.env);
    await press(FINISH_SETUP_NOTICE_COPY.cancel);
    await act(async () => root!.unmount());
    root = undefined;
    await mount(sdk, link.env);
    expect(dialog()).toBeNull();
    expect(sdk.calls).toEqual([]);
  });

  test("opened signed out, nothing shows or is asked until the sign-in completes, and the query is kept until then", async () => {
    const sdk = fakeSdk("published");
    const link = page("https://tinycloud.one/chat/feed?finish-setup=registry", false);
    const view = await mount(sdk, link.env, false);
    expect(dialog()).toBeNull();
    expect(link.search()).toBe("?finish-setup=registry");
    await view.render(true);
    expect(dialog()).not.toBeNull();
    expect(link.search()).toBe("");
    expect(sdk.calls).toEqual([]);
  });
});

/** A localStorage stand-in with the key listing the sign-out wipe walks. */
function listedStorage() {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

/** One page that sees the signed-in client change: `signIn(client)` renders it, `signOut()` renders no client. */
async function mountAccounts(env: RegistryPublishEnv) {
  restore ??= installDom();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const show = (client: RegistryPublishClient | null, ready: boolean) =>
    act(async () => root!.render(<FinishSetupLinkHost tcw={client} ready={ready} searchKey={env.location.search} env={env} />));
  return { signIn: (client: RegistryPublishClient) => show(client, true), signOut: () => show(null, false), show };
}

describe("a finish-setup notice and the next account", () => {
  const accountA = fakeSdk("published");
  const accountB = fakeSdk("published");
  const clientB = { ...accountB.client, did: "did:pkh:eip155:1:0x00000000000000000000000000000000000b0b01" };
  const link = () => page("https://tinycloud.one/chat/feed?finish-setup=registry", false);

  test("A opens a link, signs out, B signs in: the notice does not show for B, nothing is asked, and A's flag stays on the device", async () => {
    const storage = listedStorage();
    const flags = createDismissedStore(() => storage);
    flags.write(accountA.client.did);
    const env = link().env;
    const view = await mountAccounts(env);
    await view.signIn(accountA.client);
    expect(dialog()).not.toBeNull();
    expect(accountA.calls).toEqual([]);

    await view.signOut();
    clearAccountSignOutStorage(accountA.client.did, "0x00000000000000000000000000000000000a11ce", storage);
    expect(dialog()).toBeNull();

    await view.signIn(clientB);
    expect(dialog()).toBeNull();
    expect(accountB.calls).toEqual([]);
    expect(accountA.calls).toEqual([]);
    expect(createDismissedStore(() => storage).read(accountA.client.did)).toBe(true);
    expect(createDismissedStore(() => storage).read(clientB.did)).toBe(false);
  });

  test("a direct swap of the signed-in client closes A's notice and does not show it for B", async () => {
    const view = await mountAccounts(link().env);
    await view.signIn(accountA.client);
    expect(dialog()).not.toBeNull();
    await view.signIn(clientB);
    expect(dialog()).toBeNull();
    expect(accountB.calls).toEqual([]);
    expect(accountA.calls).toEqual([]);
  });

  test("a sign-in that ends and returns for the same client does not bring the closed notice back", async () => {
    const view = await mountAccounts(link().env);
    await view.signIn(accountA.client);
    expect(dialog()).not.toBeNull();
    await view.show(accountA.client, false);
    expect(dialog()).toBeNull();
    await view.show(accountA.client, true);
    expect(dialog()).toBeNull();
    expect(accountA.calls).toEqual([]);
  });
});
