// The SDK's `account.setup.pending` (web-sdk 3.18.0) opens the one finish-setup notice: a hosted owner sees a single prompt,
// Publish is this app's own publish, and Cancel asks the SDK nothing.
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import type { RegistryPublishClient } from "@/lib/registryConsent/adapter";
import { FINISH_SETUP_NOTICE_COPY } from "@/lib/registryConsent/copy";
import type { RegistryPublishEnv } from "@/lib/registryConsent/intent";
import { createSetupPendingStore } from "@/lib/registryConsent/setupPending";
import { fakeSdk, memoryDismissedStore } from "@/lib/registryConsent/testClient.fixture";

// Radix portals do not attach in happy-dom: the dialog's chrome is an inline stand-in; the notice's own content is real.
const actualDialog = { ...(await import("../components/ui/dialog")) };
afterAll(() => { mock.module("../components/ui/dialog", () => actualDialog); });
type Kids = { children?: ReactNode };
mock.module("../components/ui/dialog", () => ({
  ...actualDialog,
  Dialog: (props: { open: boolean; onOpenChange?: (open: boolean) => void } & Kids) => (props.open
    ? <div role="dialog">{props.children}</div>
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

/** A page with no finish-setup link, so only the SDK's signal can open the notice. */
const plainPage: RegistryPublishEnv = {
  location: { origin: "https://tinycloud.one", pathname: "/chat/feed", search: "", hash: "" },
  history: { state: null, replaceState: () => undefined },
};

function setup() {
  const dismissed = memoryDismissedStore();
  const pending = createSetupPendingStore(dismissed, () => true);
  restore ??= installDom();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (tcw: RegistryPublishClient | null, ready = true) =>
    act(async () => root!.render(<FinishSetupLinkHost tcw={tcw} ready={ready} searchKey="" env={plainPage} dismissed={dismissed} pending={pending} />));
  return { dismissed, pending, render };
}

const dialogs = () => document.querySelectorAll('[data-testid="finish-setup-notice"]');
const press = (label: string) => act(async () => {
  [...document.querySelectorAll("button")].find((button) => button.textContent === label)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});

describe("account.setup.pending", () => {
  test("a hosted owner's sign-in shows exactly one notice with the card's words, and asks the SDK nothing until Publish", async () => {
    const sdk = fakeSdk("published");
    const view = setup();
    await view.render(sdk.client, false);
    // The SDK reports it at the end of sign-in, before the app holds the signed-in client.
    await act(async () => view.pending.request(sdk.client));
    await view.render(sdk.client, true);
    expect(dialogs()).toHaveLength(1);
    expect(document.body.textContent).toContain(FINISH_SETUP_NOTICE_COPY.title);
    // A repeat of the same report (a second sign-in for this owner) adds no second prompt.
    await act(async () => view.pending.request(sdk.client));
    await view.render(sdk.client, true);
    expect(dialogs()).toHaveLength(1);
    expect(sdk.calls).toEqual([]);
    await press(FINISH_SETUP_NOTICE_COPY.publish);
    expect(sdk.calls).toEqual([[]]);
    expect(dialogs()).toHaveLength(0);
    expect(view.dismissed.read(sdk.client.did)).toBe(true);
  });

  test("Cancel closes it, asks the SDK nothing, and the same owner is not asked again in this page load", async () => {
    const sdk = fakeSdk("published");
    const view = setup();
    await act(async () => view.pending.request(sdk.client));
    await view.render(sdk.client);
    await press(FINISH_SETUP_NOTICE_COPY.cancel);
    expect(dialogs()).toHaveLength(0);
    expect(sdk.calls).toEqual([]);
    await act(async () => view.pending.request(sdk.client));
    await view.render(sdk.client);
    expect(dialogs()).toHaveLength(0);
  });

  test("a notice raised for one client never shows or publishes for another", async () => {
    const first = fakeSdk("published");
    const second = fakeSdk("published");
    const view = setup();
    await act(async () => view.pending.request(first.client));
    await view.render(second.client);
    expect(dialogs()).toHaveLength(0);
    await view.render(null, false);
    await view.render(first.client);
    expect(dialogs()).toHaveLength(1);
    expect(second.calls).toEqual([]);
  });

  test("it waits while signed out and shows nothing", async () => {
    const sdk = fakeSdk("published");
    const view = setup();
    await act(async () => view.pending.request(sdk.client));
    await view.render(sdk.client, false);
    expect(dialogs()).toHaveLength(0);
  });
});
