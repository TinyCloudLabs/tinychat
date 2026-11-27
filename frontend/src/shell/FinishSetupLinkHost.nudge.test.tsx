// The one-time prompt (TC-4322 follow-up): a signed-in web owner the registry does not know sees the finish-setup notice
// once per device, with no link and no new words. The flag is written when the notice shows.
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import type { RegistryPublishClient } from "@/lib/registryConsent/adapter";
import { FINISH_SETUP_NOTICE_COPY } from "@/lib/registryConsent/copy";
import { FINISH_SETUP_CARD_STATE, type RegistryPublishEnv } from "@/lib/registryConsent/intent";
import { createDismissedStore } from "@/lib/registryConsent/dismissed";
import { createNudgedStore } from "@/lib/registryConsent/nudged";
import { fakeSdk, memoryStorage, OWNER_DID } from "@/lib/registryConsent/testClient.fixture";
import type { AppPlatform } from "@/lib/platform";

// Same inline dialog stand-in as FinishSetupLinkHost.test.tsx (Radix portals do not attach in happy-dom).
const actualDialog = { ...(await import("../components/ui/dialog")) };
afterAll(() => { mock.module("../components/ui/dialog", () => actualDialog); });
type Kids = { children?: ReactNode };
mock.module("../components/ui/dialog", () => ({
  ...actualDialog,
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

const BOB_DID = "did:pkh:eip155:1:0x00000000000000000000000000000000000b0b01";

/** A page at `url` (origin tinycloud.one, so a "needs-one" answer has nowhere to navigate): replaceState strips the query. */
function page(search = "", fromCard = false) {
  const at = new URL(`https://tinycloud.one/chat/feed${search}`);
  const env: RegistryPublishEnv = {
    location: { origin: at.origin, pathname: at.pathname, get search() { return at.search; }, hash: at.hash },
    history: {
      state: fromCard ? { key: "s", usr: FINISH_SETUP_CARD_STATE } : { key: "s", usr: null },
      replaceState: (_state, _title, next) => { at.search = new URL(String(next), at.origin).search; },
    },
  };
  return env;
}

/** One device: its storage, so a remount is a reload and the stores are the page's own. */
function device() {
  const storage = memoryStorage();
  return { nudged: createNudgedStore(() => storage), dismissed: createDismissedStore(() => storage), storage };
}
type Device = ReturnType<typeof device>;
const nudgedKeys = (d: Device) => [...d.storage.map.keys()].filter((key) => key.startsWith("tinychat.registryNudged.v1."));

async function mount(d: Device, client: RegistryPublishClient | null, verdict: (c: RegistryPublishClient) => Promise<boolean>, opts: { env?: RegistryPublishEnv; platform?: AppPlatform } = {}) {
  restore ??= installDom();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const env = opts.env ?? page();
  const render = (c: RegistryPublishClient | null) => act(async () => root!.render(
    <FinishSetupLinkHost tcw={c} ready={c !== null} searchKey={env.location.search} env={env}
      dismissed={d.dismissed} nudged={d.nudged} unregistered={verdict} platform={opts.platform ?? "web"} />));
  await render(client);
  return { render };
}
const unmount = async () => { await act(async () => root!.unmount()); root = undefined; };

const dialogs = () => document.querySelectorAll('[data-testid="finish-setup-notice"]');
const press = (label: string) => act(async () => {
  [...document.querySelectorAll("button")].find((button) => button.textContent === label)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
const yes = async () => true;

describe("the one-time registry prompt", () => {
  test("an unregistered owner is asked once, without a link, in the card's words; Cancel asks the SDK nothing", async () => {
    const d = device();
    const sdk = fakeSdk("published");
    await mount(d, sdk.client, yes);
    expect(dialogs().length).toBe(1);
    expect(dialogs()[0]!.textContent).toContain(FINISH_SETUP_NOTICE_COPY.title);
    expect(nudgedKeys(d)).toEqual([`tinychat.registryNudged.v1.${OWNER_DID.toLowerCase()}`]);
    await press(FINISH_SETUP_NOTICE_COPY.cancel);
    expect(dialogs().length).toBe(0);
    expect(sdk.calls).toEqual([]);
  });

  test("after Cancel, a reload does not ask again", async () => {
    const d = device();
    const sdk = fakeSdk("published");
    await mount(d, sdk.client, yes);
    await press(FINISH_SETUP_NOTICE_COPY.cancel);
    await unmount();
    await mount(d, sdk.client, yes);
    expect(dialogs().length).toBe(0);
    expect(nudgedKeys(d).length).toBe(1);
  });

  test("a reload with the notice still open (never answered) does not ask again either", async () => {
    const d = device();
    const sdk = fakeSdk("published");
    await mount(d, sdk.client, yes);
    expect(dialogs().length).toBe(1);
    await unmount();
    await mount(d, sdk.client, yes);
    expect(dialogs().length).toBe(0);
  });

  test("another owner on the same device is asked once for themselves", async () => {
    const d = device();
    const a = fakeSdk("published");
    const b = { ...fakeSdk("published").client, did: BOB_DID };
    await mount(d, a.client, yes);
    await press(FINISH_SETUP_NOTICE_COPY.cancel);
    await unmount();
    await mount(d, b, yes);
    expect(dialogs().length).toBe(1);
    expect(nudgedKeys(d).length).toBe(2);
  });

  test("a registered, offline or already-published owner is not asked and nothing is written, so a later unregistered answer still asks", async () => {
    const d = device();
    const sdk = fakeSdk("published");
    await mount(d, sdk.client, async () => false);
    expect(dialogs().length).toBe(0);
    expect(nudgedKeys(d)).toEqual([]);
    await unmount();

    d.dismissed.write(OWNER_DID);
    let asked = 0;
    await mount(d, sdk.client, async () => { asked++; return true; });
    expect(dialogs().length).toBe(0);
    expect(nudgedKeys(d)).toEqual([]);
    expect(asked).toBe(0);
    await unmount();

    const later = device();
    await mount(later, sdk.client, async () => { throw new Error("registry down"); });
    expect(dialogs().length).toBe(0);
    expect(nudgedKeys(later)).toEqual([]);
    await unmount();
    await mount(later, sdk.client, yes);
    expect(dialogs().length).toBe(1);
  });

  test("a pasted finish-setup link shows exactly one notice and uses up the prompt", async () => {
    const d = device();
    const sdk = fakeSdk("published");
    await mount(d, sdk.client, yes, { env: page("?finish-setup=registry") });
    expect(dialogs().length).toBe(1);
    expect(sdk.calls).toEqual([]);
    expect(nudgedKeys(d).length).toBe(1);
    await press(FINISH_SETUP_NOTICE_COPY.cancel);
    expect(dialogs().length).toBe(0);
  });

  test("the Home card's link still publishes at once, with no notice", async () => {
    const d = device();
    const sdk = fakeSdk("published");
    await mount(d, sdk.client, yes, { env: page("?finish-setup=registry", true) });
    expect(dialogs().length).toBe(0);
    expect(sdk.calls).toEqual([[]]);
    expect(nudgedKeys(d).length).toBe(1);
  });

  test("a verdict that arrives after the client changed shows nothing for the new client and writes nothing for the old one", async () => {
    const d = device();
    const a = fakeSdk("published");
    const b = { ...fakeSdk("published").client, did: BOB_DID };
    let answerA: (value: boolean) => void = () => {};
    const verdict = (c: RegistryPublishClient) => c === a.client ? new Promise<boolean>((resolve) => { answerA = resolve; }) : Promise.resolve(false);
    const view = await mount(d, a.client, verdict);
    await view.render(b);
    await act(async () => answerA(true));
    expect(dialogs().length).toBe(0);
    expect(nudgedKeys(d)).toEqual([]);
  });

  test("a verdict that arrives after sign-out shows nothing", async () => {
    const d = device();
    const sdk = fakeSdk("published");
    let answer: (value: boolean) => void = () => {};
    const view = await mount(d, sdk.client, () => new Promise<boolean>((resolve) => { answer = resolve; }));
    await view.render(null);
    await act(async () => answer(true));
    expect(dialogs().length).toBe(0);
    expect(nudgedKeys(d)).toEqual([]);
  });

  test("Publish from the prompt asks the SDK once and, on published, writes the card's published flag", async () => {
    const d = device();
    const sdk = fakeSdk("published");
    await mount(d, sdk.client, yes);
    await press(FINISH_SETUP_NOTICE_COPY.publish);
    expect(sdk.calls).toEqual([[]]);
    expect(dialogs().length).toBe(0);
    expect(d.dismissed.read(OWNER_DID)).toBe(true);
  });

  test("Publish answered needs-one writes no published flag", async () => {
    const d = device();
    const sdk = fakeSdk("needs-one");
    await mount(d, sdk.client, yes);
    await press(FINISH_SETUP_NOTICE_COPY.publish);
    expect(sdk.calls).toEqual([[]]);
    expect(d.dismissed.read(OWNER_DID)).toBe(false);
  });

  test("the desktop app and the phone apps are not asked and nothing is looked up", async () => {
    for (const platform of ["tauri", "ios", "android"] as const) {
      const d = device();
      let asked = 0;
      await mount(d, fakeSdk("published").client, async () => { asked++; return true; }, { platform });
      expect(dialogs().length).toBe(0);
      expect(asked).toBe(0);
      expect(nudgedKeys(d)).toEqual([]);
      await unmount();
    }
  });
});
