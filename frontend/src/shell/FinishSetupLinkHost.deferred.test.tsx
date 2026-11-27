// The one-time registry prompt waits for every other modal to close, and writes its flag only when it actually shows.
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { FINISH_SETUP_NOTICE_COPY } from "@/lib/registryConsent/copy";
import { FINISH_SETUP_CARD_STATE, type RegistryPublishEnv } from "@/lib/registryConsent/intent";
import { createDismissedStore } from "@/lib/registryConsent/dismissed";
import { createNudgedStore } from "@/lib/registryConsent/nudged";
import { fakeSdk, memoryStorage, OWNER_DID } from "@/lib/registryConsent/testClient.fixture";
import { appDialogOpen } from "./modalOpen";

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


const none = { storageFull: false, pendingVoiceNoteSignOut: false, pricing: false, rates: false };

function device() {
  const storage = memoryStorage();
  return { nudged: createNudgedStore(() => storage), dismissed: createDismissedStore(() => storage), storage };
}
type Device = ReturnType<typeof device>;
const nudgedKeys = (d: Device) => [...d.storage.map.keys()].filter((key) => key.startsWith("tinychat.registryNudged.v1."));

function page(): RegistryPublishEnv {
  const at = new URL("https://tinycloud.one/chat/feed");
  return {
    location: { origin: at.origin, pathname: at.pathname, get search() { return at.search; }, hash: at.hash },
    history: { state: { key: "s", usr: null }, replaceState: () => {} },
  };
}

async function mount(d: Device, blocked: boolean) {
  restore ??= installDom();
  const sdk = fakeSdk("published");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (isBlocked: boolean) => act(async () => root!.render(
    <FinishSetupLinkHost tcw={sdk.client} ready searchKey="" env={page()} dismissed={d.dismissed} nudged={d.nudged}
      unregistered={async () => true} platform="web" blocked={isBlocked} />));
  await render(blocked);
  return { render, sdk };
}

/** A modal some other screen owns, as the page shows it. */
function addModal(markup: string) {
  const holder = document.createElement("div");
  holder.innerHTML = markup;
  document.body.append(holder);
  return () => act(async () => { holder.remove(); });
}
const dialogs = () => document.querySelectorAll('[data-testid="finish-setup-notice"]');
const press = (label: string) => act(async () => {
  [...document.querySelectorAll("button")].find((button) => button.textContent === label)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});

describe("the one-time registry prompt and the App's own dialogs", () => {
  for (const name of ["storageFull", "pendingVoiceNoteSignOut", "pricing", "rates"] as const) {
    test(`waits while the ${name} dialog is open, writes nothing, and opens when it closes`, async () => {
      const d = device();
      const view = await mount(d, appDialogOpen({ ...none, [name]: true }));
      expect(dialogs().length).toBe(0);
      expect(nudgedKeys(d)).toEqual([]);
      await view.render(appDialogOpen(none));
      expect(dialogs().length).toBe(1);
      expect(nudgedKeys(d).length).toBe(1);
      expect(view.sdk.calls).toEqual([]);
    });
  }
});

describe("the one-time registry prompt and any other modal", () => {
  const modals: Record<string, string> = {
    "a Radix dialog or sheet": '<div role="dialog" data-state="open"></div>',
    "a Radix alert dialog": '<div role="alertdialog" data-state="open"></div>',
    "a hand-built confirmation": '<section role="alertdialog" aria-modal="true"></section>',
  };
  for (const [name, markup] of Object.entries(modals)) {
    test(`waits while ${name} is open, writes nothing, and opens once it is gone`, async () => {
      const d = device();
      restore = installDom();
      const close = addModal(markup);
      await mount(d, false);
      expect(dialogs().length).toBe(0);
      expect(nudgedKeys(d)).toEqual([]);
      await close();
      expect(dialogs().length).toBe(1);
      expect(nudgedKeys(d).length).toBe(1);
    });
  }

  test("a dialog that is only closing does not hold it back", async () => {
    const d = device();
    restore = installDom();
    addModal('<div role="dialog" data-state="closed"></div>');
    await mount(d, false);
    expect(dialogs().length).toBe(1);
  });

  test("a reload while it waits asks again, because nothing was written", async () => {
    const d = device();
    restore = installDom();
    addModal('<div role="dialog" data-state="open"></div>');
    await mount(d, false);
    expect(dialogs().length).toBe(0);
    await act(async () => root!.unmount());
    root = undefined;
    document.body.innerHTML = "";
    await mount(d, false);
    expect(dialogs().length).toBe(1);
  });

  test("once shown it is not asked again after Cancel", async () => {
    const d = device();
    const view = await mount(d, true);
    await view.render(false);
    await press(FINISH_SETUP_NOTICE_COPY.cancel);
    await view.render(true);
    await view.render(false);
    expect(dialogs().length).toBe(0);
  });

  test("an owner who published while it waited is not asked, and nothing is written", async () => {
    const d = device();
    const view = await mount(d, true);
    d.dismissed.write(OWNER_DID);
    await view.render(false);
    expect(dialogs().length).toBe(0);
    expect(nudgedKeys(d)).toEqual([]);
  });
});
