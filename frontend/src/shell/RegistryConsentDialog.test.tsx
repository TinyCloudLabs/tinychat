import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { PREVIEW } from "@/lib/registryConsent/testClient.fixture";
import { REGISTRY_CONSENT_COPY } from "@/lib/registryConsent/copy";
import { cancelPendingRegistryConsent, pendingRegistryConsent, requestRegistryConsent, startSignOutClosingRegistryConsent } from "@/lib/registryConsent/broker";

// Radix portals do not attach in happy-dom: the dialog's chrome is an inline stand-in; the dialog's own content is real.
// bun's mock.module is process-wide: the stand-in keeps every other export, and the real module is put back after.
const actualAlert = { ...(await import("../components/ui/alert-dialog")) };
afterAll(() => { mock.module("../components/ui/alert-dialog", () => actualAlert); });
type Kids = { children?: ReactNode };
mock.module("../components/ui/alert-dialog", () => ({
  ...actualAlert,
  AlertDialog: (props: { open: boolean } & Kids) => (props.open ? <div role="alertdialog">{props.children}</div> : null),
  AlertDialogContent: (props: Kids) => <div>{props.children}</div>,
  AlertDialogHeader: (props: Kids) => <div>{props.children}</div>,
  AlertDialogTitle: (props: Kids) => <h2>{props.children}</h2>,
  AlertDialogDescription: (props: Kids) => <p>{props.children}</p>,
  AlertDialogFooter: (props: Kids) => <div>{props.children}</div>,
  AlertDialogCancel: (props: { onClick?: () => void } & Kids) => <button type="button" onClick={props.onClick}>{props.children}</button>,
  AlertDialogAction: (props: { onClick?: () => void } & Kids) => <button type="button" onClick={props.onClick}>{props.children}</button>,
}));
const { RegistryConsentDialog, shortSubject } = await import("./RegistryConsentDialog");

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  cancelPendingRegistryConsent();
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.();
  restore = undefined;
});

async function mount() {
  restore = installDom();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<RegistryConsentDialog />));
  return {
    text: () => container.textContent ?? "",
    click: (label: string) => act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === label)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }),
  };
}

test("shows nothing until the SDK asks", async () => {
  const view = await mount();
  expect(view.text()).toBe("");
});

test("renders the preview with the owner's address short, and answers true on Publish and continue", async () => {
  const view = await mount();
  let asked!: Promise<boolean>;
  await act(async () => { asked = requestRegistryConsent(PREVIEW); });
  expect(view.text()).toContain(REGISTRY_CONSENT_COPY.title);
  expect(view.text()).toContain("0x…bcd1");
  expect(view.text()).toContain(PREVIEW.nodeDid);
  expect(view.text()).toContain(PREVIEW.nodeOrigin);
  expect(view.text()).toContain(PREVIEW.space);
  expect(view.text()).not.toContain(PREVIEW.subject);
  await view.click("Publish and continue");
  expect(await asked).toBe(true);
  expect(view.text()).toBe("");
});

test("Not now answers false and closes", async () => {
  const view = await mount();
  let asked!: Promise<boolean>;
  await act(async () => { asked = requestRegistryConsent(PREVIEW); });
  await view.click("Not now");
  expect(await asked).toBe(false);
  expect(view.text()).toBe("");
});

test("sign-out closes the dialog and answers false", async () => {
  const view = await mount();
  let asked!: Promise<boolean>;
  await act(async () => { asked = requestRegistryConsent(PREVIEW); });
  expect(view.text()).toContain(REGISTRY_CONSENT_COPY.title);
  await act(async () => { startSignOutClosingRegistryConsent(() => undefined); });
  expect(await asked).toBe(false);
  expect(pendingRegistryConsent()).toBeNull();
  expect(view.text()).toBe("");
});

test("shortSubject is 0x… and the last four of the address", () => {
  expect(shortSubject("did:pkh:eip155:1:0x00000000000000000000000000000000000abcd1")).toBe("0x…bcd1");
});
